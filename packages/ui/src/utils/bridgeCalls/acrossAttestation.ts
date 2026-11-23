import {
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  pad,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import { decodeStore } from './across';
import { PINNED_ACROSS_QUOTE_SIGNER } from './contracts';
import { callValue, unreadableCapability, type BridgeCall, type TokenRef } from './view';

export const QUOTE_TYPES = {
  Quote: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'originValidUntil', type: 'uint64' },
    { name: 'origin', type: 'Origin' },
    { name: 'destination', type: 'Destination' },
    { name: 'refundPolicy', type: 'RefundPolicy' },
    { name: 'funding', type: 'Funding' },
  ],
  Token: [
    { name: 'chainId', type: 'uint256' },
    { name: 'token', type: 'bytes32' },
  ],
  Origin: [
    { name: 'token', type: 'Token' },
    { name: 'amount', type: 'uint256' },
    { name: 'depositor', type: 'bytes32' },
  ],
  Destination: [
    { name: 'token', type: 'Token' },
    { name: 'recipient', type: 'bytes32' },
    { name: 'minAmount', type: 'uint256' },
    { name: 'actions', type: 'RequestedAction[]' },
  ],
  RequestedAction: [
    { name: 'target', type: 'address' },
    { name: 'functionSignature', type: 'string' },
    { name: 'args', type: 'bytes' },
    { name: 'value', type: 'uint256' },
    { name: 'allowFailure', type: 'bool' },
    { name: 'substitutions', type: 'BalanceSubstitution[]' },
  ],
  BalanceSubstitution: [
    { name: 'token', type: 'address' },
    { name: 'balanceOwner', type: 'address' },
    { name: 'bps', type: 'uint16' },
    { name: 'appliesToValue', type: 'bool' },
    { name: 'calldataOffset', type: 'uint256' },
  ],
  RefundPolicy: [
    { name: 'recipient', type: 'bytes32' },
    { name: 'tokens', type: 'Token[]' },
  ],
  Funding: [
    { name: 'caller', type: 'bytes32' },
    { name: 'approvals', type: 'Approval[]' },
    { name: 'transactions', type: 'Transaction[]' },
    { name: 'messages', type: 'SignedMessage[]' },
  ],
  SignedMessage: [
    { name: 'chainId', type: 'uint256' },
    { name: 'digest', type: 'bytes32' },
    { name: 'index', type: 'uint256' },
  ],
  Approval: [
    { name: 'chainId', type: 'uint256' },
    { name: 'token', type: 'bytes32' },
    { name: 'spender', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'index', type: 'uint256' },
  ],
  Transaction: [
    { name: 'chainId', type: 'uint256' },
    { name: 'to', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'index', type: 'uint256' },
  ],
} as const;

const DOMAIN = { name: 'Across Quote', version: '3', verifyingContract: zeroAddress } as const;

const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .transform(BigInt)
  .refine((n) => n < 2n ** 256n);
const bytes = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/)
  .transform((s) => s.toLowerCase() as Hex);
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex);
const addressWord = z
  .string()
  .regex(/^0x0{24}[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase() as Hex);
const token = z.strictObject({ chainId: uint, token: addressWord });
const empty = z.tuple([]);

const quoteSchema = z.strictObject({
  orderId: bytes32,
  issuedAt: uint,
  expiresAt: uint,
  originValidUntil: uint,
  origin: z.strictObject({ token, amount: uint, depositor: addressWord }),
  destination: z.strictObject({ token, recipient: addressWord, minAmount: uint, actions: empty }),
  refundPolicy: z.strictObject({ recipient: addressWord, tokens: z.array(token) }),
  funding: z.strictObject({
    caller: addressWord,
    approvals: z.array(
      z.strictObject({ chainId: uint, token: addressWord, spender: addressWord, amount: uint, index: uint })
    ),
    transactions: z.array(z.strictObject({ chainId: uint, to: addressWord, value: uint, data: bytes, index: uint })),
    messages: empty,
  }),
});

const capabilitySchema = z.object({
  attestation: z.object({
    scheme: z.literal('eip712'),
    typedData: z.object({
      primaryType: z.literal('Quote'),
      domain: z.strictObject({
        name: z.literal(DOMAIN.name),
        version: z.literal(DOMAIN.version),
        chainId: z.number(),
        verifyingContract: z.literal(DOMAIN.verifyingContract),
      }),
      message: quoteSchema,
    }),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]{130}$/)
      .transform((s) => s as Hex),
  }),
});

type Quote = z.infer<typeof quoteSchema>;

export type AcrossAttestedOrder = {
  orderId: Hex;
  destinationChainId: number;
  token: Address;
  recipient: Address;
  minAmount: bigint;
  refund: { recipient: Address; tokens: TokenRef[] } | null;
  expiresAt: number;
};

const unpad = (word: Hex) => `0x${word.slice(26)}` as Address;
const NO_ADDRESS = pad(zeroAddress);

export async function readAcrossAttestation(
  capability: unknown,
  calls: BridgeCall[],
  account: Address,
  now = Date.now()
): Promise<AcrossAttestedOrder | null> {
  // Input from the dapp that breaks the check reads as unverified, never as an error.
  try {
    const parsed = unreadableCapability(capability) ? undefined : capabilitySchema.safeParse(capability).data;
    const chainId = calls[0]?.chainId;
    if (!parsed || chainId === undefined) return null;

    const { typedData, signature } = parsed.attestation;
    const quote = typedData.message;
    const accountWord = pad(account.toLowerCase() as Hex);
    if (typedData.domain.chainId !== chainId) return null;
    if (quote.funding.caller !== accountWord || quote.origin.depositor !== accountWord) return null;
    if (!bindsCalls(quote.funding, calls, chainId)) return null;
    if (decodeStore(calls.at(-1)?.data)?.args[0] !== quote.orderId) return null;
    const order = orderOf(quote);
    // Across leaves the time between expiresAt and originValidUntil for the deposit to land,
    // and store() sets no deadline of its own.
    if (!order || now >= order.expiresAt * 1000) return null;
    if (!(await signedByAcross(quote, chainId, signature))) return null;
    return order;
  } catch {
    return null;
  }
}

function bindsCalls({ approvals, transactions }: Quote['funding'], calls: BridgeCall[], chainId: number): boolean {
  const steps = [
    ...approvals.map((approval) => ({
      ...approval,
      to: unpad(approval.token),
      value: 0n,
      data: approveData(approval.spender, approval.amount),
      allowanceReset: approveData(approval.spender, 0n),
    })),
    ...transactions.map((transaction) => ({ ...transaction, to: unpad(transaction.to), allowanceReset: undefined })),
  ].sort((a, b) => (a.index < b.index ? -1 : 1));
  if (!steps.every((step) => step.chainId === BigInt(chainId))) return false;
  if (!calls.every((call) => call.chainId === chainId)) return false;

  // USDT and tokens like it take a new allowance only from zero, so the app may reset it before the signed approve.
  const [first] = steps;
  const resets = first?.allowanceReset !== undefined && sameCall(calls[0], { ...first, data: first.allowanceReset });
  const rest = resets ? calls.slice(1) : calls;
  return rest.length === steps.length && rest.every((call, at) => sameCall(call, steps[at]));
}

const approveData = (spender: Hex, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [unpad(spender), amount] });

const sameCall = (call: BridgeCall, step: { to: Address; value: bigint; data: Hex }) =>
  call.to.toLowerCase() === step.to &&
  callValue(call.value) === step.value &&
  (call.data ?? '0x').toLowerCase() === step.data;

function orderOf(quote: Quote): AcrossAttestedOrder | undefined {
  const { destination, refundPolicy } = quote;
  const hasRecipient = refundPolicy.recipient !== NO_ADDRESS;
  const hasTokens = refundPolicy.tokens.length > 0;
  if (hasRecipient !== hasTokens) return undefined;
  return {
    orderId: quote.orderId,
    destinationChainId: Number(destination.token.chainId),
    token: unpad(destination.token.token),
    recipient: unpad(destination.recipient),
    minAmount: destination.minAmount,
    refund: hasRecipient
      ? {
          recipient: unpad(refundPolicy.recipient),
          tokens: refundPolicy.tokens.map((refund) => ({
            chainId: Number(refund.chainId),
            address: unpad(refund.token),
          })),
        }
      : null,
    expiresAt: Number(quote.expiresAt),
  };
}

async function signedByAcross(quote: Quote, chainId: number, signature: Hex): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({
      domain: { ...DOMAIN, chainId },
      types: QUOTE_TYPES,
      primaryType: 'Quote',
      message: quote,
      signature,
    });
    return isAddressEqual(signer, PINNED_ACROSS_QUOTE_SIGNER);
  } catch {
    return false;
  }
}
