import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { readAcrossCall, type AcrossDeposit } from './across';
import { readBridgeApprove, type BridgeApprove } from './approve';
import { readRelayCall, type RelayDeposit } from './relay';
import { readRelayOrder } from './relayOrder';
import type { BridgeContracts } from './table';
import { PROVIDER_NAME, transferOf, type BridgeTransfer } from './transfer';
import { pinnedToken, unreadRefs, type BridgeCall, type BridgeProvider, type TokenRef, type Unreadable } from './view';

const OTHER_CONTRACT = 'This approval is for a different contract than the deposit.';
const OTHER_TOKEN = 'This approval is for a different token than the deposit.';
const UNPAIRED = 'This batch has an approval that the deposit does not use. Check its token, amount and spender.';
const APPROVE_UNKNOWN = 'This batch approves a token this screen does not know. Check its address before you confirm.';

const manyDeposits = (count: number) => `This batch has ${count} bridge deposits. Check each step before you confirm.`;
const CHECK = 'Check it before you confirm.';

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
  return readBridgeBatchWithUnread(contracts, calls, account, relayOrder)?.batch ?? null;
}

/** The batch and the tokens outside the table that nothing has read yet, for the screen to ask about. */
export function readBridgeBatchWithUnread(
  contracts: BridgeContracts,
  calls: BridgeCall[],
  account: Address,
  relayOrder?: unknown
): { batch: BridgeBatch; unread: TokenRef[] } | null {
  const reads: Read[] = calls.map(
    (call) => readAcrossCall(contracts, call) ?? readRelayCall(contracts, call) ?? readBridgeApprove(contracts, call)
  );
  if (reads.every((read) => read === undefined)) return null;

  const steps = reads.map(stepOf);
  const alerts = reads.flatMap((read) => (read?.kind === 'unreadable' ? [cannotRead(read.provider)] : []));
  const deposits = reads.filter((read): read is Deposit => read?.kind === 'deposit');
  const orders = deposits.map((deposit) =>
    deposit.provider === 'relay' ? readRelayOrder(contracts, relayOrder, deposit) : undefined
  );
  const transfers = deposits.map((deposit, at) => transferOf(contracts, deposit, account, orders[at]));
  const notices = transfers.flatMap((read) => read.notices);
  const approves = reads.flatMap((read, at) =>
    read?.kind === 'approve' ? [{ chainId: calls[at].chainId, read }] : []
  );
  const unknownApprove = approves.some(({ read }) => !read.token.known);
  if (unknownApprove) notices.push(APPROVE_UNKNOWN);
  const outsideTable =
    unknownApprove ||
    transfers.some((read) => read.outsideTable) ||
    reads.some((read) => read?.kind === 'unreadable' && read.outsideTable);
  if (outsideTable && contracts.source === 'snapshot') notices.push(STALE_TABLE);

  if (deposits.length === 1) notices.push(...approveNotices(calls, reads, deposits[0]));
  if (deposits.length > 1) notices.push(manyDeposits(deposits.length));
  calls.forEach((call, i) => reads[i] === undefined && notices.push(outsideNotice(contracts, call, i + 1)));
  return {
    batch: {
      transfer: deposits.length === 1 ? transfers[0].transfer : undefined,
      steps,
      alerts: [...new Set(alerts)],
      notices: [...new Set(notices)],
    },
    unread: [
      ...unreadRefs(deposits.flatMap((deposit, at) => [deposit.send, transfers[at].transfer.receive?.amount])),
      ...orders.flatMap((order) => (order?.kind === 'unshown' && order.token ? [order.token] : [])),
      ...unreadRefs(approves.map(({ chainId, read }) => ({ chainId, amount: read.amount, token: read.token }))),
    ],
  };
}

// Names the party that matters in full, so a lookalike address cannot hide behind a short form.
function outsideNotice(contracts: BridgeContracts, call: BridgeCall, step: number): string {
  if (!isAddress(call.to, { strict: false })) {
    return `Step ${step} does not call an address this screen can read. ${CHECK}`;
  }
  const to = getAddress(call.to);
  const token = pinnedToken(contracts, call.chainId, to)?.symbol ?? to;
  const erc20 = erc20Call(call.data);
  if (erc20?.functionName === 'approve') {
    return `Step ${step} approves ${erc20.args[0]} to spend ${token}. ${CHECK}`;
  }
  if (erc20?.functionName === 'transfer') {
    return `Step ${step} sends ${token} to ${erc20.args[0]}. ${CHECK}`;
  }
  return `Step ${step} calls ${to} outside the bridge. ${CHECK}`;
}

function erc20Call(data: string | undefined) {
  if (!data) return undefined;
  try {
    const call = decodeFunctionData({ abi: erc20Abi, data: data as Hex });
    return call.functionName === 'approve' || call.functionName === 'transfer' ? call : undefined;
  } catch {
    return undefined;
  }
}

function approveNotices(calls: BridgeCall[], reads: Read[], deposit: Deposit): string[] {
  const at = reads.indexOf(deposit);
  const pull = pullOf(deposit, calls[at]);
  const before = reads[at - 1];
  const paired = pull && before?.kind === 'approve' && calls[at - 1].chainId === calls[at].chainId ? before : undefined;
  const notices: string[] = [];
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
