import { getAddress, isAddressEqual, zeroAddress, type Address } from 'viem';
import { readAcrossCall, type AcrossDeposit } from './across';
import { readBridgeApprove, type BridgeApprove } from './approve';
import { readRelayCall, type RelayDeposit } from './relay';
import { readRelayOrder } from './relayOrder';
import { PROVIDER_NAME, transferOf, type BridgeTransfer } from './transfer';
import type { BridgeCall, BridgeProvider, Unreadable } from './view';

const DOES_MORE = 'This batch does more than the bridge deposit. Review every step.';
const OTHER_CONTRACT = 'This approval is for a different contract than the deposit.';
const OTHER_TOKEN = 'This approval is for a different token than the deposit.';
const UNPAIRED = 'This batch has an approval that the deposit does not use. Check its token, amount and spender.';
const APPROVE_UNKNOWN = 'This batch approves a token this screen does not know. Check its address before you confirm.';

export type BridgeStep = { label: string } | { alert: string } | null;

/** `alerts` are red: a bridge call this screen cannot read. `notices` are yellow: worth a look, maybe intended. */
export type BridgeBatch = { transfer?: BridgeTransfer; steps: BridgeStep[]; alerts: string[]; notices: string[] };

type Deposit = AcrossDeposit | RelayDeposit;
type Read = Deposit | BridgeApprove | Unreadable | undefined;
type Pull = { token: Address; amount: bigint; spender: Address };

export const cannotRead = (provider: BridgeProvider) =>
  `This screen cannot read this ${PROVIDER_NAME[provider]} call. Check the raw details before you confirm.`;

export function readBridgeBatch(calls: BridgeCall[], account: Address, relayOrder?: unknown): BridgeBatch | null {
  const reads: Read[] = calls.map((call) => readAcrossCall(call) ?? readRelayCall(call) ?? readBridgeApprove(call));
  if (reads.every((read) => read === undefined)) return null;

  const steps = reads.map(stepOf);
  const alerts = reads.flatMap((read) => (read?.kind === 'unreadable' ? [cannotRead(read.provider)] : []));
  const deposits = reads.filter((read): read is Deposit => read?.kind === 'deposit');
  const transfers = deposits.map((deposit) =>
    transferOf(deposit, account, deposit.provider === 'relay' ? readRelayOrder(relayOrder, deposit) : undefined)
  );
  const notices = transfers.flatMap((read) => read.notices);
  if (reads.some((read) => read?.kind === 'approve' && !read.token.known)) notices.push(APPROVE_UNKNOWN);

  if (deposits.length === 1) {
    notices.push(...approveNotices(calls, reads, deposits[0]));
  } else if (deposits.length > 1 || reads.includes(undefined)) {
    notices.push(DOES_MORE);
  }
  return {
    transfer: deposits.length === 1 ? transfers[0].transfer : undefined,
    steps,
    alerts: [...new Set(alerts)],
    notices: [...new Set(notices)],
  };
}

function approveNotices(calls: BridgeCall[], reads: Read[], deposit: Deposit): string[] {
  const at = reads.indexOf(deposit);
  const pull = pullOf(deposit, calls[at]);
  const before = reads[at - 1];
  const paired = pull && before?.kind === 'approve' && calls[at - 1].chainId === calls[at].chainId ? before : undefined;
  const notices: string[] = [];
  if (calls.length !== (paired ? 2 : 1)) notices.push(DOES_MORE);
  if (paired && pull) notices.push(...pairingNotices(paired, pull));
  if (reads.some((read) => read?.kind === 'approve' && read !== paired)) notices.push(UNPAIRED);
  return notices;
}

function stepOf(read: Read): BridgeStep {
  if (!read) return null;
  if (read.kind === 'unreadable') return { alert: cannotRead(read.provider) };
  const provider = PROVIDER_NAME[read.provider];
  if (read.kind === 'deposit') return { label: `${provider} deposit` };
  return { label: `Approve ${read.token.known ? read.token.symbol : 'unknown token'} for ${provider}` };
}

function pullOf({ send }: Deposit, call: BridgeCall): Pull | undefined {
  if (send.token.address === zeroAddress) return undefined;
  return { token: send.token.address, amount: send.amount, spender: getAddress(call.to) };
}

function pairingNotices(approve: BridgeApprove, pull: Pull): string[] {
  const notices: string[] = [];
  if (!isAddressEqual(approve.spender, pull.spender)) notices.push(OTHER_CONTRACT);
  if (!isAddressEqual(approve.token.address, pull.token)) notices.push(OTHER_TOKEN);
  return notices;
}
