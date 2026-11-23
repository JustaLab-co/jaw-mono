import { formatUnits, getAddress, isAddressEqual, type Address } from 'viem';
import { groupNumber } from '../displayFormat';
import { formatAddress } from '../formatAddress';
import type { AcrossDeposit, AcrossOrder } from './across';
import type { AcrossAttestedOrder } from './acrossAttestation';
import type { BridgeChain } from './contracts';
import type { RelayDeposit, RelaySwap } from './relay';
import type { OrderUnshown, RelayOrder } from './relayOrder';
import type { BridgeContracts } from './table';
import { tokenAmount, type BridgeProvider, type Received, type Token, type TokenAmount } from './view';

export type Detail = { label: string; value: string; copy?: string };

export type ChainLabel = Pick<BridgeChain, 'name' | 'nativeSymbol'>;

export type BridgeTransfer = {
  provider: BridgeProvider;
  title: string;
  send: TokenAmount;
  origin: ChainLabel;
  receive?: Received;
  destination?: ChainLabel;
  /** Pays out on the chain it starts on, so the simulation sees what arrives. */
  sameChain?: true;
  /** Set when what arrives goes to an address other than this account. */
  otherRecipient?: Address;
  details: Detail[];
};

export type TransferRead = { transfer: BridgeTransfer; notices: string[] };

export const PROVIDER_NAME: Record<BridgeProvider, string> = { across: 'Across', relay: 'Relay' };

const notThisAccount = (who: string, address: Address) => `${who} is not this account: ${getAddress(address)}.`;
const tokenNotice = (token: Token) =>
  token.known === false && token.unverified
    ? `This screen has not verified the token ${token.symbol} (${formatAddress(getAddress(token.address))}). Check it before you confirm.`
    : `This screen does not know the token ${token.address}. Check it before you confirm.`;
const unknownChain = (id: number) =>
  `This screen does not know chain ${id} and cannot confirm that the recipient there is this account. Check it before you confirm.`;
const hiddenTerms = (provider: BridgeProvider) =>
  `${PROVIDER_NAME[provider]} keeps the destination chain and the recipient in an order outside this transaction. This screen cannot show them. Confirm only if you started this transfer yourself.`;
const orderDetail = (id: string): Detail => ({ label: 'Order', value: `${id.slice(0, 6)}…${id.slice(-4)}`, copy: id });

export function transferOf(
  contracts: BridgeContracts,
  deposit: AcrossDeposit | AcrossOrder | RelayDeposit | RelaySwap,
  account: Address,
  relayOrder?: RelayOrder | OrderUnshown,
  acrossOrder: AcrossAttestedOrder | null = null
): TransferRead {
  if (deposit.kind === 'swap') return relaySwapTransfer(contracts, deposit);
  if (deposit.kind === 'order') return acrossOrderTransfer(contracts, deposit, account, acrossOrder);
  if (deposit.provider === 'across') return acrossTransfer(contracts, deposit, account);
  return relayTransfer(contracts, deposit, account, relayOrder);
}

function acrossTransfer(contracts: BridgeContracts, deposit: AcrossDeposit, account: Address): TransferRead {
  const { fee } = deposit;
  const notices: string[] = [];
  // On a chain the table lacks, the same address may not be this account, so it is never called that.
  const knownChain = contracts.chain(deposit.destinationChainId) !== undefined;
  const yours = knownChain && isAddressEqual(deposit.recipient, account);
  if (!knownChain) notices.push(unknownChain(deposit.destinationChainId));
  else if (!yours) notices.push(notThisAccount('The recipient', deposit.recipient));
  if (!isAddressEqual(deposit.refundTo, account)) notices.push(notThisAccount('The refund address', deposit.refundTo));
  const received = deposit.receive.amount.token;
  for (const token of [deposit.send.token, received]) if (!token.known) notices.push(tokenNotice(token));

  const recipient = getAddress(deposit.recipient);
  const details: Detail[] = [
    yours ? accountDetail('Recipient', recipient, account) : { label: 'Recipient', value: recipient, copy: recipient },
  ];
  if (fee) {
    const to = fee.jaw ? 'JAW' : getAddress(fee.recipient);
    details.push({ label: 'Fee', value: `${amountText(fee.amount)} to ${to}`, copy: fee.jaw ? undefined : to });
  }
  details.push(accountDetail('Refund to', deposit.refundTo, account), {
    label: 'Fill by',
    value: new Date(deposit.fillDeadline * 1000).toUTCString(),
  });

  const origin = labelOf(contracts, deposit.send.chainId);
  const destination = labelOf(contracts, deposit.destinationChainId);
  return {
    transfer: {
      provider: 'across',
      title: `Bridge to ${destination.name}`,
      send: deposit.send,
      origin,
      receive: deposit.receive,
      destination,
      otherRecipient: yours ? undefined : recipient,
      details,
    },
    notices,
  };
}

function relayTransfer(
  contracts: BridgeContracts,
  deposit: RelayDeposit,
  account: Address,
  order?: RelayOrder | OrderUnshown
): TransferRead {
  const notices: string[] = [];
  if (!deposit.send.token.known) notices.push(tokenNotice(deposit.send.token));
  if (!isAddressEqual(deposit.depositor, account))
    notices.push(notThisAccount('The account credited', deposit.depositor));
  const credited = accountDetail('Credited to', deposit.depositor, account);

  if (order?.kind !== 'order') {
    notices.unshift(...(order ? [order.reason] : []), hiddenTerms('relay'));
    return {
      transfer: {
        provider: 'relay',
        title: 'Deposit to Relay',
        send: deposit.send,
        origin: labelOf(contracts, deposit.send.chainId),
        details: [credited, orderDetail(deposit.orderId)],
      },
      notices,
    };
  }

  return verifiedOrderTransfer(contracts, deposit, order, account, notices, [credited]);
}

type OrderTerms = Omit<RelayOrder, 'kind'>;

function acrossOrderTransfer(
  contracts: BridgeContracts,
  deposit: AcrossOrder,
  account: Address,
  order: AcrossAttestedOrder | null
): TransferRead {
  const notices = deposit.send.token.known ? [] : [tokenNotice(deposit.send.token)];
  // As with the destination, a refund on a chain the table lacks could not be called this account.
  const chainsInTable =
    order !== null &&
    [order.destinationChainId, ...(order.refund?.tokens ?? []).map((token) => token.chainId)].every(
      (chainId) => contracts.chain(chainId) !== undefined
    );
  if (!order || order.orderId !== deposit.orderId || !chainsInTable) {
    return {
      transfer: {
        provider: 'across',
        title: 'Deposit to Across',
        send: deposit.send,
        origin: labelOf(contracts, deposit.send.chainId),
        details: [orderDetail(deposit.orderId)],
      },
      notices: [hiddenTerms('across'), ...notices],
    };
  }

  const { destinationChainId, refund } = order;
  const refundChains = new Set(refund?.tokens.map((token) => token.chainId));
  const terms: OrderTerms = {
    destinationChainId,
    recipient: order.recipient,
    minimumReceived: tokenAmount(contracts, destinationChainId, order.token, order.minAmount),
    refunds: refund ? [...refundChains].map((chainId) => ({ chainId, to: refund.recipient })) : [],
  };
  return verifiedOrderTransfer(contracts, deposit, terms, account, notices, []);
}

function verifiedOrderTransfer(
  contracts: BridgeContracts,
  deposit: AcrossOrder | RelayDeposit,
  terms: OrderTerms,
  account: Address,
  notices: string[],
  details: Detail[]
): TransferRead {
  const received = terms.minimumReceived.token;
  if (!received.known) notices.push(tokenNotice(received));
  if (!isAddressEqual(terms.recipient, account)) notices.push(notThisAccount('The recipient', terms.recipient));
  // The recipient is only known to hold its address on the destination chain.
  for (const { chainId, to } of terms.refunds) {
    const toRecipient = chainId === terms.destinationChainId && isAddressEqual(to, terms.recipient);
    if (!isAddressEqual(to, account) && !toRecipient) notices.push(notThisAccount('The refund address', to));
  }
  const refundDetails = terms.refunds.map(({ chainId, to }) =>
    accountDetail(`Refund on ${labelOf(contracts, chainId).name}`, to, account)
  );
  const destination = labelOf(contracts, terms.destinationChainId);
  return {
    transfer: {
      provider: deposit.provider,
      title: `Bridge to ${destination.name}`,
      send: deposit.send,
      origin: labelOf(contracts, deposit.send.chainId),
      receive: { kind: 'minimum', amount: terms.minimumReceived },
      destination,
      otherRecipient: isAddressEqual(terms.recipient, account) ? undefined : getAddress(terms.recipient),
      details: [
        accountDetail('Recipient', terms.recipient, account),
        ...(refundDetails.length > 0 ? refundDetails : [{ label: 'Refund', value: 'None' }]),
        ...details,
        orderDetail(deposit.orderId),
      ],
    },
    notices,
  };
}

function relaySwapTransfer(contracts: BridgeContracts, swap: RelaySwap): TransferRead {
  const notices = swap.send.token.known ? [] : [tokenNotice(swap.send.token)];
  return {
    transfer: {
      provider: 'relay',
      title: 'Swap through Relay',
      send: swap.send,
      origin: labelOf(contracts, swap.send.chainId),
      sameChain: true,
      details: [],
    },
    notices,
  };
}

// Only a plain Across deposit can name a chain the table lacks, and what it pays out is never native.
function labelOf(contracts: BridgeContracts, chainId: number): ChainLabel {
  const chain = contracts.chain(chainId);
  return chain
    ? { name: chain.name, nativeSymbol: chain.nativeSymbol }
    : { name: `chain ${chainId}`, nativeSymbol: '' };
}

function amountText({ amount, token }: Pick<TokenAmount, 'amount' | 'token'>): string {
  if (!token.known && !token.unverified) return `${groupNumber(amount.toString())} base units`;
  return `${groupNumber(formatUnits(amount, token.decimals))} ${token.symbol}`;
}

function accountDetail(label: string, address: Address, account: Address): Detail {
  const full = getAddress(address);
  return { label, value: isAddressEqual(full, account) ? 'This account' : full, copy: full };
}
