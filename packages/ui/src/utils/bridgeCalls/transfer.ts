import { formatUnits, getAddress, isAddressEqual, type Address } from 'viem';
import { groupNumber } from '../displayFormat';
import type { AcrossDeposit } from './across';
import { BRIDGE_CHAINS } from './contracts';
import type { RelayDeposit } from './relay';
import type { BridgeProvider, Received, TokenAmount } from './view';

export type Detail = { label: string; value: string; copy?: string };

export type BridgeTransfer = {
  provider: BridgeProvider;
  title: string;
  send: TokenAmount;
  receive?: Received;
  /** Set when what arrives goes to an address other than this account. */
  otherRecipient?: Address;
  details: Detail[];
};

export type TransferRead = { transfer: BridgeTransfer; notices: string[] };

export const PROVIDER_NAME: Record<BridgeProvider, string> = { across: 'Across', relay: 'Relay' };

const notThisAccount = (who: string, address: Address) => `${who} is not this account: ${getAddress(address)}.`;
const unknownToken = (address: Address) =>
  `This screen does not know the token ${address}. Check it before you confirm.`;
const FEE_NOT_JAW = 'The fee goes to an address JAW does not know.';
const RELAY_HIDDEN =
  'Relay keeps the destination chain and the recipient in an order outside this transaction. This screen cannot show them. Confirm only if you started this transfer yourself.';

export const transferOf = (deposit: AcrossDeposit | RelayDeposit, account: Address): TransferRead =>
  deposit.provider === 'across' ? acrossTransfer(deposit, account) : relayTransfer(deposit, account);

function acrossTransfer(deposit: AcrossDeposit, account: Address): TransferRead {
  const { fee } = deposit;
  const notices: string[] = [];
  if (!isAddressEqual(deposit.recipient, account)) notices.push(notThisAccount('The recipient', deposit.recipient));
  if (!isAddressEqual(deposit.refundTo, account)) notices.push(notThisAccount('The refund address', deposit.refundTo));
  if (fee && !fee.jaw) notices.push(FEE_NOT_JAW);
  const received = deposit.receive.kind === 'minimum' ? deposit.receive.amount.token : deposit.receive.token;
  for (const token of [deposit.send.token, received]) if (!token.known) notices.push(unknownToken(token.address));

  const details: Detail[] = [accountDetail('Recipient', deposit.recipient, account)];
  if (fee) {
    const to = fee.jaw ? 'JAW' : getAddress(fee.recipient);
    details.push({ label: 'Fee', value: `${amountText(fee.amount)} to ${to}`, copy: fee.jaw ? undefined : to });
  }
  details.push(accountDetail('Refund to', deposit.refundTo, account), {
    label: 'Fill by',
    value: new Date(deposit.fillDeadline * 1000).toUTCString(),
  });

  const destination = BRIDGE_CHAINS[deposit.destinationChainId].name;
  return {
    transfer: {
      provider: 'across',
      title: `Bridge to ${destination}`,
      send: deposit.send,
      receive: deposit.receive,
      otherRecipient: isAddressEqual(deposit.recipient, account) ? undefined : deposit.recipient,
      details,
    },
    notices,
  };
}

function relayTransfer(deposit: RelayDeposit, account: Address): TransferRead {
  const id = deposit.orderId;
  const notices = [RELAY_HIDDEN];
  if (!deposit.send.token.known) notices.push(unknownToken(deposit.send.token.address));
  if (!isAddressEqual(deposit.depositor, account))
    notices.push(notThisAccount('The account credited', deposit.depositor));
  return {
    transfer: {
      provider: 'relay',
      title: 'Deposit to Relay',
      send: deposit.send,
      details: [
        accountDetail('Credited to', deposit.depositor, account),
        { label: 'Order', value: `${id.slice(0, 6)}…${id.slice(-4)}`, copy: id },
      ],
    },
    notices,
  };
}

function amountText({ amount, token }: Pick<TokenAmount, 'amount' | 'token'>): string {
  if (!token.known) return `${groupNumber(amount.toString())} base units`;
  return `${groupNumber(formatUnits(amount, token.decimals))} ${token.symbol}`;
}

function accountDetail(label: string, address: Address, account: Address): Detail {
  const full = getAddress(address);
  return { label, value: isAddressEqual(full, account) ? 'This account' : full, copy: full };
}
