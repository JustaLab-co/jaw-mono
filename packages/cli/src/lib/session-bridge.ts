import { loadSessionKey } from './keystore.js';
import { isLegacySession, loadSessionConfig, type SessionConfig } from './session-config.js';
import { loadConfig } from './config.js';
import { encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { usdcForNetwork } from '../x402/asset-registry.js';
import { whyFeeTokenDisagrees } from '../x402/fee-token.js';
import { PERMIT2_ADDRESS } from '../x402/permit2.js';

// JAW's ERC-20 paymaster, mirrored from core's `jawPaymasterUrl`. Kept as a
// local literal rather than an import because `@jaw.id/core` is lazy-loaded in
// the CLI (a static import would pull it into startup); keep in sync if core's
// URL moves. The core SDK recognises this exact base URL and adds the USDC
// approval the paymaster needs, so the path must match byte for byte.
const JAW_ERC20_PAYMASTER_URL = 'https://api.justaname.id/proxy/v1/rpc/erc20-paymaster';

/**
 * The paymaster an auto-mode userOp goes out with, in precedence order: an
 * explicit url, then `config.paymasters` for the chain, then JAW's own.
 *
 * Falling through to JAW's is what makes the default path need no configuration.
 * Without it a fresh setup could not top up at all: the account has to prefund
 * the EntryPoint for the worst-case gas, which fails on an account holding only
 * USDC, and the error names none of this. Asking the user for a paymaster url
 * put the ERC-7677 app-developer role on someone who is just using the wallet,
 * and it asked them to sign up with the provider we already proxy and pay for.
 *
 * It takes its fee in USDC rather than sponsoring anything, so the account never
 * needs a native token, which is the point: gas comes out of the same balance
 * the payments do. `config.paymasters` still wins, so anyone bringing their own
 * keeps it.
 */
function resolvePaymaster(
  options: SessionBridgeOptions
): Pick<SessionBridgeOptions, 'paymasterUrl' | 'paymasterContext'> {
  if (options.paymasterUrl) {
    return { paymasterUrl: options.paymasterUrl, paymasterContext: options.paymasterContext };
  }

  const configured = loadConfig().paymasters?.[options.chainId];
  if (configured) {
    return { paymasterUrl: configured.url, paymasterContext: configured.context };
  }

  // No api key means nothing to authenticate the proxy with, so there is no
  // paymaster to engage and the account pays its gas in the native token.
  if (!options.apiKey) return {};

  // The ERC-20 paymaster has to be told which token it is being paid in: the SDK
  // sizes and emits the `approve` it needs from this address, and without it the
  // userOp reaches the paymaster with no allowance behind it and cannot settle.
  // A chain the registry does not cover has no token to name, so fall back to
  // sending with no paymaster rather than engaging one that must fail.
  const asset = usdcForNetwork(`eip155:${options.chainId}`);
  if (!asset) {
    // Say so rather than falling through quietly: the userOp goes out with no
    // paymaster, and the failure the user eventually sees is about native funds
    // and mentions none of this. stderr, so stdio MCP framing is untouched.
    console.warn(
      `[jaw] No USDC in the x402 asset registry for chain ${options.chainId}, so no ERC-20 paymaster ` +
        'can be engaged. Gas will come out of the account\u2019s native balance. ' +
        'Set `paymasters` in your config to sponsor this chain.'
    );
    return {};
  }

  const url = new URL(JAW_ERC20_PAYMASTER_URL);
  url.searchParams.set('chainId', String(options.chainId));
  url.searchParams.set('api-key', options.apiKey);
  return { paymasterUrl: url.toString(), paymasterContext: { token: asset.address } };
}

/**
 * Say so when the token this session names is not one the paymaster takes.
 *
 * Only for JAW's own paymaster: a user who brought their own url owns that
 * relationship, and the capabilities response describes ours.
 */
async function warnOnFeeTokenDrift(options: SessionBridgeOptions): Promise<void> {
  if (options.paymasterUrl && !options.paymasterUrl.startsWith(JAW_ERC20_PAYMASTER_URL)) return;
  const asset = usdcForNetwork(`eip155:${options.chainId}`);
  if (!asset || !options.apiKey) return;
  const warning = await whyFeeTokenDisagrees(asset, options.apiKey);
  if (warning) console.warn(`[jaw] ${warning}`);
}

/**
 * The one way the send still breaks once nothing is sponsored: the ERC-20
 * paymaster charges the account the userOp is sent from, and an account with no
 * USDC cannot be charged, so sizing its approval fails. Core's error names the
 * token and the chain and nothing about the account, which is what made this
 * hard to read the first time it happened.
 *
 * A session normally receives its gas in the grant, so an empty one means that
 * transfer did not happen: the wallet that approved the permission does not
 * carry it yet. Say the address and the amount rather than leaving the user to
 * work backwards from a paymaster error.
 */
function explainUnchargeableSender(err: unknown, sessionAddress: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes('Could not size the ERC-20 paymaster approval')) return err;
  return new Error(
    `${message}\n\nIf ${sessionAddress} holds no USDC, that is why: it pays for its own gas and ` +
      'cannot be charged with an empty balance. Send it 0.1 USDC, or run `jaw session setup` again.',
    { cause: err }
  );
}

export interface SessionBridgeOptions {
  apiKey: string;
  chainId: number;
  paymasterUrl?: string;
  paymasterContext?: Record<string, unknown>;
}

/** Lazily resolved Account instance + session config */
interface InitializedSession {
  account: {
    address: string;
    sendCalls: (...args: unknown[]) => Promise<unknown>;
    getCallStatus: (batchId: `0x${string}`) => Promise<unknown>;
  };
  config: SessionConfig;
}

export class SessionBridge {
  private readonly options: SessionBridgeOptions;
  private session: InitializedSession | null = null;

  constructor(options: SessionBridgeOptions) {
    this.options = { ...options, ...resolvePaymaster(options) };
  }

  private async getSession(): Promise<InitializedSession> {
    if (this.session) {
      this.checkExpiry(this.session.config);
      return this.session;
    }

    const config = loadSessionConfig();
    this.checkExpiry(config);

    // Sessions from before the CLI settled on EIP-7702 granted their permission
    // to a counterfactual second address, which holds nothing and so cannot be
    // charged the gas of the ops it sends. Re-deriving one of those here would
    // produce a different address and fail at the mismatch guard below, which
    // blames the keystore. Say what it actually is, and how to fix it.
    if (isLegacySession(config)) {
      throw new Error(
        'This session was created by an older CLI and uses a session address separate from the session key. ' +
          'Run `jaw session setup` to recreate it, which offers to revoke the old permission first. ' +
          '`jaw session status` still shows the old session, and `jaw session revoke` still revokes it.'
      );
    }

    if (config.chainId !== this.options.chainId) {
      throw new Error(
        `Session was created for chain ${config.chainId}, but --chain ${this.options.chainId} was requested. ` +
          `Run \`jaw session setup --chain ${this.options.chainId}\` to create a session for that chain.`
      );
    }

    let privateKeyHex: string | null = loadSessionKey();

    const { privateKeyToAccount } = await import('viem/accounts');
    const localAccount = privateKeyToAccount(privateKeyHex as `0x${string}`);
    privateKeyHex = null;

    const { Account } = await import('@jaw.id/core');
    // The token in the context is the registry's, and until now nothing compared
    // it against what the paymaster actually takes. Checked here rather than in
    // the constructor because it costs a network read, and warned rather than
    // corrected: see `whyFeeTokenDisagrees`.
    await warnOnFeeTokenDrift(this.options);

    // Every session is EIP-7702, so the account re-derives to the session key
    // EOA and the delegation rides its userOps. Deriving any other way would
    // produce an address the permission was never granted to.
    const account = await Account.fromLocalAccount(
      {
        chainId: this.options.chainId,
        apiKey: this.options.apiKey,
        paymasterUrl: this.options.paymasterUrl,
        paymasterContext: this.options.paymasterContext,
      },
      localAccount,
      { eip7702: true }
    );

    // The stored sessionAddress is the on-chain permission's spender. If the
    // key or mode drifted since setup (hand-edited keystore, config from
    // another machine), signing would come from an account the permission was
    // never granted to — fail clearly instead of sending doomed userOps.
    if (account.address.toLowerCase() !== config.sessionAddress.toLowerCase()) {
      throw new Error(
        `Session key derives ${account.address}, but the stored session address is ${config.sessionAddress}. ` +
          'The keystore and session config are out of sync. Run `jaw session setup` to recreate the session.'
      );
    }

    this.session = { account: account as InitializedSession['account'], config };
    return this.session;
  }

  private checkExpiry(config: SessionConfig): void {
    if (config.expiry <= Date.now() / 1000) {
      const expiryDate = new Date(config.expiry * 1000).toISOString();
      throw new Error(`Session expired on ${expiryDate}. Run \`jaw session setup\` to create a new session.`);
    }
  }

  /**
   * Approve Permit2 to move one of the payer's tokens, and return the batch id.
   *
   * The only call this session sends outside its permission, and the only one
   * that can be: `JustaPermissionManager` checks every call's selector against
   * the grant, and the x402 grant permits `transfer` alone, so an approval
   * routed through the permission reverts before anything else happens. Sent by
   * the session on its own balance it never reaches the manager at all, whose
   * approval revocation and Permit2 lockdown act on the granting account and
   * only within their own execution.
   *
   * Being outside the permission is exactly why it is not a general send. It
   * takes a token and nothing else: the spender is Permit2 and the amount is
   * the maximum, neither reachable by a caller, and the token has to be the
   * registry's USDC for this session's chain. There is no shape of argument
   * that turns this into an arbitrary transfer, which matters because an agent
   * reaches the tools that reach this.
   */
  async approvePermit2(token: `0x${string}`): Promise<string> {
    const { account, config } = await this.getSession();
    const usdc = usdcForNetwork(`eip155:${config.chainId}`);
    if (!usdc || token.toLowerCase() !== usdc.address.toLowerCase()) {
      throw new Error(
        `Refusing to approve Permit2 for ${token}: only the registry USDC on chain ${config.chainId} is allowed.`
      );
    }

    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, maxUint256],
    });

    try {
      // No permissionId: this is the session acting for itself.
      // Same shape tolerance the funder applies: `{ id, chainId }` from
      // Account.sendCalls, or a bare id from an older bridge.
      const sent: unknown = await account.sendCalls([{ to: usdc.address, data }]);
      const id = typeof sent === 'string' ? sent : (sent as { id?: string } | null)?.id;
      if (!id) throw new Error('approval submitted but no call id was returned');
      return id;
    } catch (err) {
      throw explainUnchargeableSender(err, config.sessionAddress);
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const { account, config } = await this.getSession();

    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [config.sessionAddress];

      case 'wallet_sendCalls': {
        const payload = Array.isArray(params) ? params[0] : params;
        const { calls } = payload as {
          calls: Array<{ to: string; value?: string; data?: string }>;
        };
        const sendOptions = { permissionId: config.permissionId as `0x${string}` };

        // Always charged, never sponsored. The grant leaves the session enough
        // to pay for its first op and every refill leaves `gasReserve` behind
        // for the next one, so the sender can be charged.
        try {
          return await account.sendCalls(calls, sendOptions);
        } catch (err) {
          throw explainUnchargeableSender(err, config.sessionAddress);
        }
      }

      case 'wallet_getCallsStatus': {
        const batchId = Array.isArray(params) ? params[0] : params;
        return account.getCallStatus(batchId as `0x${string}`);
      }

      // Refused rather than absent, so the reason is on screen instead of a
      // caller reading "not supported in auto mode" and looking for a flag. See
      // `supportsSessionMode` in rpc-classifier.ts for why.
      case 'personal_sign':
      case 'eth_signTypedData_v4':
        throw new Error(
          `${method} is not available in auto mode: a signature the session makes is not a call, so it never reaches the spend caps or the ledger. Run it through the browser instead.`
        );

      case 'wallet_grantPermissions':
        throw new Error('Requires browser — run `jaw session setup`.');

      case 'wallet_revokePermissions':
        throw new Error('Requires browser — run `jaw session revoke`.');

      default:
        throw new Error(`Method ${method} is not supported in auto mode.`);
    }
  }

  close(): void {
    // No-op — no WebSocket to close
  }
}
