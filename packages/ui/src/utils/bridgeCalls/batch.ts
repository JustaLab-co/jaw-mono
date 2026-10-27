import { getAddress, isAddressEqual, zeroAddress, type Address } from 'viem';
import { readAcrossCall, type AcrossDeposit } from './across';
import { readBridgeApprove, type BridgeApprove } from './approve';
import { readRelayCall, type RelayDeposit } from './relay';
import { readRelayOrder } from './relayOrder';
import type { BridgeContracts } from './table';
import { PROVIDER_NAME, transferOf, type BridgeTransfer } from './transfer';
import type { BridgeCall, BridgeProvider, Unreadable } from './view';

const DOES_MORE = 'This batch does more than the bridge deposit. Review every step.';
const OTHER_CONTRACT = 'This approval is for a different contract than the deposit.';
const OTHER_TOKEN = 'This approval is for a different token than the deposit.';
const UNPAIRED = 'This batch has an approval that the deposit does not use. Check its token, amount and spender.';
const APPROVE_UNKNOWN = 'This batch approves a token this screen does not know. Check its address before you confirm.';

const STALE_TABLE = 'This screen could not refresh its list of bridge contracts.';

export type BridgeStep = { alert: string } | null;

/** `alerts` are red: a bridge call this screen cannot read. `notices` are yellow: worth a look, maybe intended. */
export type BridgeBatch = { transfer?: BridgeTransfer; steps: BridgeStep[]; alerts: string[]; notices: string[] };

type Deposit = AcrossDeposit | RelayDeposit;
type Read = Deposit | BridgeApprove | Unreadable | undefined;
type Pull = { token: Address; amount: bigint; spender: Address };

export const cannotRead = (provider: BridgeProvider) =>
  `This screen cannot read this ${PROVIDER_NAME[provider]} call. Check the raw details before you confirm.`;

export function readBridgeBatch(
  contracts: BridgeContracts,
  calls: BridgeCall[],
  account: Address,
  relayOrder?: unknown
): BridgeBatch | null {
  const reads: Read[] = calls.map(
    (call) => readAcrossCall(contracts, call) ?? readRelayCall(contracts, call) ?? readBridgeApprove(contracts, call)
  );
  if (reads.every((read) => read === undefined)) return null;

  const steps = reads.map(stepOf);
  const alerts = reads.flatMap((read) => (read?.kind === 'unreadable' ? [cannotRead(read.provider)] : []));
  const deposits = reads.filter((read): read is Deposit => read?.kind === 'deposit');
  const transfers = deposits.map((deposit) =>
    transferOf(
      contracts,
      deposit,
      account,
      deposit.provider === 'relay' ? readRelayOrder(contracts, relayOrder, deposit) : undefined
    )
  );
  const notices = transfers.flatMap((read) => read.notices);
  const unknownApprove = reads.some((read) => read?.kind === 'approve' && !read.token.known);
  if (unknownApprove) notices.push(APPROVE_UNKNOWN);
  const outsideTable =
    unknownApprove ||
    transfers.some((read) => read.outsideTable) ||
    reads.some((read) => read?.kind === 'unreadable' && read.outsideTable);
  if (outsideTable && contracts.source === 'snapshot') notices.push(STALE_TABLE);

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

const stepOf = (read: Read): BridgeStep => (read?.kind === 'unreadable' ? { alert: cannotRead(read.provider) } : null);

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
