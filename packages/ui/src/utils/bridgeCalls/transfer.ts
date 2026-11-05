import { formatUnits, getAddress, isAddressEqual, type Address } from 'viem';
import { groupNumber } from '../displayFormat';
import { formatAddress } from '../formatAddress';
import type { AcrossDeposit } from './across';
import type { BridgeChain } from './contracts';
import type { RelayDeposit, RelaySwap } from './relay';
import type { OrderUnshown, RelayOrder } from './relayOrder';
import type { BridgeContracts } from './table';
import type { BridgeProvider, Received, Token, TokenAmount } from './view';

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
const RELAY_SWAP_HIDDEN =
  'Relay does not say in this transaction what the swap pays out, so this screen cannot confirm what you get. Confirm only if you started this swap yourself.';
const RELAY_HIDDEN =
  'Relay keeps the destination chain and the recipient in an order outside this transaction. This screen cannot show them. Confirm only if you started this transfer yourself.';

export function transferOf(
  contracts: BridgeContracts,
  deposit: AcrossDeposit | RelayDeposit | RelaySwap,
  account: Address,
  order?: RelayOrder | OrderUnshown
): TransferRead {
  if (deposit.kind === 'swap') return relaySwapTransfer(contracts, deposit, account);
  if (deposit.provider === 'across') return acrossTransfer(contracts, deposit, account);
  return relayTransfer(contracts, deposit, account, order);
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
  const id = deposit.orderId;
  const notices: string[] = [];
  if (!deposit.send.token.known) notices.push(tokenNotice(deposit.send.token));
  if (!isAddressEqual(deposit.depositor, account))
    notices.push(notThisAccount('The account credited', deposit.depositor));
  const credited = accountDetail('Credited to', deposit.depositor, account);
  const orderDetail = { label: 'Order', value: `${id.slice(0, 6)}…${id.slice(-4)}`, copy: id };

  if (order?.kind !== 'order') {
    notices.unshift(...(order ? [order.reason, RELAY_HIDDEN] : [RELAY_HIDDEN]));
    return {
      transfer: {
        provider: 'relay',
        title: 'Deposit to Relay',
        send: deposit.send,
        origin: labelOf(contracts, deposit.send.chainId),
        details: [credited, orderDetail],
      },
      notices,
    };
  }

  const received = order.minimumReceived.token;
  if (!received.known) notices.push(tokenNotice(received));
  if (!isAddressEqual(order.recipient, account)) notices.push(notThisAccount('The recipient', order.recipient));
  // The recipient is only known to hold its address on the destination chain.
  for (const { chainId, to } of order.refunds) {
    const toRecipient = chainId === order.destinationChainId && isAddressEqual(to, order.recipient);
    if (!isAddressEqual(to, account) && !toRecipient) notices.push(notThisAccount('The refund address', to));
  }
  const refundDetails = order.refunds.map(({ chainId, to }) =>
    accountDetail(`Refund on ${labelOf(contracts, chainId).name}`, to, account)
  );
  const destination = labelOf(contracts, order.destinationChainId);
  return {
    transfer: {
      provider: 'relay',
      title: `Bridge to ${destination.name}`,
      send: deposit.send,
      origin: labelOf(contracts, deposit.send.chainId),
      receive: { kind: 'minimum', amount: order.minimumReceived },
      destination,
      otherRecipient: isAddressEqual(order.recipient, account) ? undefined : getAddress(order.recipient),
      details: [accountDetail('Recipient', order.recipient, account), ...refundDetails, credited, orderDetail],
    },
    notices,
  };
}

// The reader only accepts a swap that refunds to this account.
function relaySwapTransfer(contracts: BridgeContracts, swap: RelaySwap, account: Address): TransferRead {
  const notices = [RELAY_SWAP_HIDDEN];
  if (!swap.send.token.known) notices.push(tokenNotice(swap.send.token));
  return {
    transfer: {
      provider: 'relay',
      title: 'Swap through Relay',
      send: swap.send,
      origin: labelOf(contracts, swap.send.chainId),
      sameChain: true,
      details: [accountDetail('Refund to', account, account)],
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
