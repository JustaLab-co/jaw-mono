import { formatUnits, getAddress, isAddressEqual, type Address } from 'viem';
import { groupNumber } from '../displayFormat';
import { formatAddress } from '../formatAddress';
import type { AcrossDeposit } from './across';
import type { BridgeChain } from './contracts';
import type { RelayDeposit } from './relay';
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
  /** Set when what arrives goes to an address other than this account. */
  otherRecipient?: Address;
  details: Detail[];
};

export type TransferRead = { transfer: BridgeTransfer; notices: string[]; outsideTable: boolean };

export const PROVIDER_NAME: Record<BridgeProvider, string> = { across: 'Across', relay: 'Relay' };

const notThisAccount = (who: string, address: Address) => `${who} is not this account: ${getAddress(address)}.`;
const tokenNotice = (token: Token) =>
  token.known === false && token.unverified
    ? `This screen has not verified the token ${token.symbol} (${formatAddress(getAddress(token.address))}). Check it before you confirm.`
    : `This screen does not know the token ${token.address}. Check it before you confirm.`;
const RELAY_HIDDEN =
  'Relay keeps the destination chain and the recipient in an order outside this transaction. This screen cannot show them. Confirm only if you started this transfer yourself.';

export const transferOf = (
  contracts: BridgeContracts,
  deposit: AcrossDeposit | RelayDeposit,
  account: Address,
  order?: RelayOrder | OrderUnshown
): TransferRead =>
  deposit.provider === 'across'
    ? acrossTransfer(contracts, deposit, account)
    : relayTransfer(contracts, deposit, account, order);

function acrossTransfer(contracts: BridgeContracts, deposit: AcrossDeposit, account: Address): TransferRead {
  const { fee } = deposit;
  const notices: string[] = [];
  if (!isAddressEqual(deposit.recipient, account)) notices.push(notThisAccount('The recipient', deposit.recipient));
  if (!isAddressEqual(deposit.refundTo, account)) notices.push(notThisAccount('The refund address', deposit.refundTo));
  const received = deposit.receive.amount.token;
  const unknown = [deposit.send.token, received].filter((token) => !token.known);
  for (const token of unknown) notices.push(tokenNotice(token));

  const details: Detail[] = [accountDetail('Recipient', deposit.recipient, account)];
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
      otherRecipient: isAddressEqual(deposit.recipient, account) ? undefined : deposit.recipient,
      details,
    },
    notices,
    outsideTable: unknown.length > 0,
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
  const outsideTable = !deposit.send.token.known || (order?.kind === 'unshown' && order.outsideTable === true);
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
      outsideTable,
    };
  }

  const received = order.minimumReceived.token;
  if (!received.known) notices.push(tokenNotice(received));
  if (!isAddressEqual(order.recipient, account)) notices.push(notThisAccount('The recipient', order.recipient));
  if (!isAddressEqual(order.refundTo, account)) notices.push(notThisAccount('The refund address', order.refundTo));
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
      details: [
        accountDetail('Recipient', order.recipient, account),
        accountDetail('Refund to', order.refundTo, account),
        credited,
        orderDetail,
      ],
    },
    notices,
    outsideTable: outsideTable || !received.known,
  };
}

function labelOf(contracts: BridgeContracts, chainId: number): ChainLabel {
  const { name, nativeSymbol } = contracts.chain(chainId)!;
  return { name, nativeSymbol };
}

function amountText({ amount, token }: Pick<TokenAmount, 'amount' | 'token'>): string {
  if (!token.known && !token.unverified) return `${groupNumber(amount.toString())} base units`;
  const text = `${groupNumber(formatUnits(amount, token.decimals))} ${token.symbol}`;
  return token.known ? text : `${text} (unverified)`;
}

function accountDetail(label: string, address: Address, account: Address): Detail {
  const full = getAddress(address);
  return { label, value: isAddressEqual(full, account) ? 'This account' : full, copy: full };
}
