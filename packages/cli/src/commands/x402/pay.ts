import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { loadConfig } from '../../lib/config.js';
import { tryLoadSessionConfig } from '../../lib/session-config.js';
import { SessionBridge } from '../../lib/session-bridge.js';
import { Eip3009EoaPayer } from '../../x402/payer.js';
import { payAndFetch } from '../../x402/http.js';
import { appendX402Log, readX402Log, sumSpentSince } from '../../x402/ledger.js';
import { reconcileSettlements } from '../../x402/settlement.js';
import { resolveSessionX402Policy, topUpCeiling } from '../../x402/policy.js';
import { currentLimitUsageOnChain } from '../../x402/spend-window.js';
import { ensurePayerFunds } from '../../x402/topup.js';
import { parseNonNegativeBigInt } from '../../x402/amount.js';
import { usdcForNetwork, USDC_BY_NETWORK } from '../../x402/asset-registry.js';
import { formatUsdc } from '../../x402/status-report.js';
import { sanitizeLine, sanitizeBlock } from '../../lib/terminal.js';
import { withPaymentLock } from '../../lib/payment-lock.js';
import type { OutputFormat } from '../../lib/types.js';
import type { X402PaymentRequirement } from '../../x402/types.js';

/**
 * The same request an agent makes, from a terminal.
 *
 * Everything x402 was reachable only through MCP, so a broken setup could not be
 * told apart from a broken MCP client. This runs the identical `payAndFetch`
 * path the tool runs: if it works here, it works there.
 *
 * Dry run is the default. A command named `pay` that spends on first use is the
 * wrong default for something whose main job is verification, and the read-only
 * half answers most questions on its own.
 */
export default class X402Pay extends BaseCommand {
  static override description =
    'Fetch a URL, paying an x402 challenge with the session key. Dry run by default: pass --pay to actually spend.';

  static override examples = [
    '<%= config.bin %> x402 pay https://api.example.com/resource',
    '<%= config.bin %> x402 pay https://api.example.com/resource --pay',
    '<%= config.bin %> x402 pay https://api.example.com/resource --pay --max-amount 50000',
  ];

  static override args = {
    url: Args.string({ description: 'Resource URL to fetch', required: true }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    pay: Flags.boolean({
      description: 'Actually sign and send the payment. Without this the command stops before spending.',
      default: false,
    }),
    'max-amount': Flags.string({
      description: 'Hard ceiling in base units for this call, on top of the configured policy.',
    }),
    method: Flags.string({ description: 'HTTP method (default GET).' }),
    body: Flags.string({ description: 'Request body.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(X402Pay);
    const format = flags.output as OutputFormat;
    const config = loadConfig();

    // Throws a clear "run jaw session setup" when there is no session key.
    const payer = Eip3009EoaPayer.fromSessionKey();
    const session = tryLoadSessionConfig();
    // Same resolution the MCP tool uses: this path ran on the bare defaults, so
    // the two front ends enforced different caps for the same session.
    const policy = resolveSessionX402Policy(config.x402, session);

    // Payer, deliberately, with no permission: this total is measured against
    // `maxTotalPerSession`, which is the user's own ceiling rather than the
    // chain's, and it spans permissions. `session add` preserves `createdAt` so
    // that adding a capability cannot reset it; scoping to the new permission
    // would hand back the same clean slate through the other door.
    const scope = { payer: payer.address };

    if (flags.pay && (!session || !config.apiKey)) {
      // Without a session there is no permission to pull through, so the payer
      // spends whatever it already holds. Worth saying: the failure otherwise
      // arrives later as a bare insufficient-balance error with no hint that a
      // top-up was never on the table.
      this.warn(
        session
          ? 'No apiKey configured, so a short payer cannot be topped up. Paying from its own balance.'
          : 'No session, so a short payer cannot be topped up through a permission. Paying from its own balance.'
      );
    }

    // Read, pay and record as one unit. The recording has to be inside the lock
    // with the rest: releasing before the append leaves a window where the next
    // payer reads a total that does not yet include the payment just made, which
    // is the race the lock exists to close.
    const run = async () => {
      // One read for the whole payment, taken here and not before the lock:
      // another process may have paid while we waited our turn, and a stale
      // total waves through a payment the cap should have stopped. Nothing can
      // append while we hold it, so the session total and every period window
      // count against the same rows.
      //
      // Reconciled first because an unverified row costs its ceiling, and this
      // is where that figure comes down to what the chain shows actually moved.
      const ledger = await reconcileSettlements(readX402Log());
      const periodUsage = await currentLimitUsageOnChain(ledger, policy, payer.address, session);
      const spentThisSession = sumSpentSince(ledger, scope, session?.createdAt);

      // Only wired for a real payment: a dry run returns before the funding hook,
      // so building a bridge for it would open a connection nothing uses. Built
      // inside the lock rather than before it so the top-up is bounded by what is
      // left of the caps at this moment, not by their full width.
      let ensureFunds:
        | ((requirement: X402PaymentRequirement, payerAddress: `0x${string}`) => ReturnType<typeof ensurePayerFunds>)
        | undefined;
      if (flags.pay && session && config.apiKey) {
        const bridge = new SessionBridge({ apiKey: config.apiKey, chainId: session.chainId });
        const floatTarget = parseNonNegativeBigInt(config.x402?.topUpFloat);
        const maxTopUp = topUpCeiling(policy, { periodUsage, spentThisSession });
        ensureFunds = (requirement: X402PaymentRequirement, payerAddress: `0x${string}`) =>
          ensurePayerFunds(requirement, payerAddress, bridge, {
            floatTarget,
            maxTopUp,
            sessionChainId: session.chainId,
          });
      }

      const outcome = await payAndFetch(args.url, payer, {
        method: flags.method,
        body: flags.body,
        policy,
        ensureFunds,
        spentThisSession,
        periodUsage,
        maxAmount: flags['max-amount'],
        dryRun: !flags.pay,
      });

      // Only a real run touches the ledger. Recording dry runs would corrupt the
      // spend totals that both this command and the agent read back.
      if (flags.pay) {
        const settled = outcome.payment ?? outcome.attemptedPayment;
        const isPaymentEvent =
          outcome.paid || !!outcome.attemptedPayment || (outcome.status === 402 && !!outcome.refusedReason);
        if (isPaymentEvent) {
          const status = outcome.paid ? 'paid' : outcome.attemptedPayment ? 'failed' : 'refused';
          // Field for field what the MCP handler writes: both read each other's
          // entries back for the session spend total, so a divergence here would
          // make the two disagree about what has been spent.
          appendX402Log({
            at: new Date().toISOString(),
            url: args.url,
            payer: outcome.payer,
            permissionId: session?.permissionId,
            status,
            amount: settled?.amount,
            authorized: settled?.authorized,
            deadline: settled?.deadline,
            scheme: settled?.scheme,
            asset: settled?.asset,
            network: settled?.network,
            payTo: settled?.payTo,
            nonce: settled?.nonce,
            txHash: outcome.payment?.txHash,
            topUpAmount: outcome.topUp?.amount,
            topUpBatchId: outcome.topUp?.batchId,
            approvalBatchId: outcome.permit2Approval?.batchId,
            reason: outcome.refusedReason,
            // A signed authorization is worth its ceiling to whoever holds it
            // until the chain says otherwise. A refusal signed nothing.
            settlement: status === 'refused' ? undefined : 'unverified',
          });
        }
      }

      return outcome;
    };

    // Only a real payment takes the lock. A dry run spends nothing and writes
    // nothing, so making it queue behind an agent mid-payment would be friction
    // for no safety.
    const result = flags.pay
      ? await withPaymentLock(run, {
          onWait: (pid) => this.warn(`Waiting for another payment to finish (pid ${pid})...`),
        })
      : await run();

    if (format === 'json') {
      this.outputResult({ ...result, dryRun: !flags.pay }, format);
      // Same exit code as the human path. `--output json` is the scripting mode,
      // and it was the one reporting success on a refused payment.
      if (result.refusedReason) this.exit(1);
      return;
    }

    // Scale by the decimals of the network each amount is denominated in, not
    // one shared guess: a session can sit on one chain while the challenge
    // prices on another, and reading the wrong token's decimals would print a
    // wrong number with full confidence. A top-up always moves on the session's
    // chain (ensurePayerFunds refuses otherwise), a price never has to.
    const priceDecimals = (network?: string) => (network ? usdcForNetwork(network)?.decimals : undefined) ?? 6;
    const topUpDecimals = Object.values(USDC_BY_NETWORK).find((a) => a.chainId === session?.chainId)?.decimals ?? 6;

    if (result.refusedReason) {
      // The reason can carry server text (an unknown network echoed back,
      // an on-chain revert string), so it is never printed raw.
      this.log(`Refused.\n\n  ${sanitizeLine(result.refusedReason)}`);
      if (result.topUp) {
        // Money moved before the refusal. Never let that scroll past silently.
        // Gated on the record, not on the id: a broadcast that returned no call
        // id has an amount and nothing else, and that is the case where the
        // user most needs to be told their USDC left the owner account.
        const where = result.topUp.batchId ? ` (${result.topUp.batchId})` : ' (no call id returned to confirm it)';
        this.log(`\n  A top-up of ${formatUsdc(result.topUp.amount, topUpDecimals)} was sent first${where}.`);
      }
      if (result.permit2Approval) {
        // Same rule as the top-up: a userOp the user was charged for went out
        // before the refusal, so it is said out loud rather than inferred.
        this.log(`\n  A Permit2 approval was sent first (${result.permit2Approval.batchId}).`);
      }
      // A signed authorization went out and settlement did not confirm, which
      // is true of both schemes: the facilitator may have broadcast it anyway,
      // so the ledger counts it and the caps drop by it. Under `upto` the
      // figure is the whole ceiling rather than what was being paid. Either
      // way it belongs on screen, because it is the budget the next payment
      // will find missing and nothing else says so.
      const held = result.attemptedPayment;
      if (held) {
        const figure = formatUsdc(held.authorized, priceDecimals(held.network));
        this.log(`\n  ${figure} stays authorized until it expires, and your caps count it as spent until then.`);
      }
      this.exit(1);
    }

    if (result.wouldPay) {
      this.log('Would pay.\n');
      // `upto` states a ceiling, not a price, and the server picks the charge
      // afterwards. Printing "price" over that number would tell the user the
      // one thing the scheme guarantees is not true.
      const label = result.wouldPay.scheme === 'upto' ? 'up to  ' : 'price  ';
      this.log(
        `  ${label}  ${formatUsdc(result.wouldPay.amount, priceDecimals(result.wouldPay.network))} on ${sanitizeLine(result.wouldPay.network, 64)}`
      );
      this.log(`  payTo    ${result.wouldPay.payTo}`);
      this.log(`  from     ${payer.address}`);
      if (result.wouldPay.scheme === 'upto') {
        this.log('\n  The server charges anything up to that and decides after the work is done.');
        this.log('  Your caps are measured against the ceiling, since the charge is not knowable yet.');
      }
      this.log('\nNothing was signed or spent. Re-run with --pay to go through with it.');
      return;
    }

    if (!result.paid) {
      this.log(`${result.status} (no payment required)`);
      this.logBody(result.body);
      return;
    }

    this.log('Paid.\n');
    this.log(
      `  amount   ${formatUsdc(result.payment?.amount, priceDecimals(result.payment?.network))} on ${sanitizeLine(result.payment?.network, 64)}`
    );
    // Only under `upto`, and only when the two figures really differ. Compared
    // as numbers: an advertised amount is validated as digits, not normalised,
    // so `01000` and `1000` are the same money spelled two ways and would
    // otherwise print a line claiming a gap that does not exist.
    if (result.payment?.scheme === 'upto' && BigInt(result.payment.authorized) !== BigInt(result.payment.amount)) {
      this.log(`  of up to ${formatUsdc(result.payment.authorized, priceDecimals(result.payment.network))} authorized`);
    }
    this.log(`  payTo    ${result.payment?.payTo}`);
    if (result.topUp) {
      this.log(`  top-up   ${formatUsdc(result.topUp.amount, topUpDecimals)} pulled from the owner account`);
    }
    if (result.permit2Approval) {
      this.log(`  approval ${result.permit2Approval.batchId} granted Permit2 the allowance upto settles through`);
    }
    if (result.payment?.txHash) {
      this.log(`  tx       ${result.payment.txHash}`);
    }
    this.log(`\n${result.status} OK`);
    this.logBody(result.body);
  }

  private logBody(body: unknown): void {
    if (body === undefined || body === null || body === '') return;
    this.log('');
    // The body is whatever the endpoint chose to send back.
    this.log(sanitizeBlock(typeof body === 'string' ? body : JSON.stringify(body, null, 2)));
  }
}
