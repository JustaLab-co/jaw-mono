import { randomBytes } from 'node:crypto';
import {
  messageBody,
  openRequest,
  typedDataRefusal,
  type ApprovalBody,
  type ApprovalId,
  type ApprovalRequest,
  type Call,
  type ConnectionScope,
  type GasQuote,
} from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { log } from '@/lib/edge';
import { oneOffStatus } from '@/payments/one-off';
import { payOutput } from '@/payments/render';
import { quoteGas } from './bundler';
import { findForConnection, insertUnderCap, MAX_PENDING } from './store';

export const statusOutput = z.object({
  requestId: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  approveUrl: z.string().url(),
  expiresAt: z.string(),
  account: z.string(),
  chainId: z.string().describe('CAIP-2 chain id'),
  signature: z.string().optional(),
  permissionId: z.string().optional().describe('The on-chain permission an approved budget created'),
  callsId: z.string().optional().describe('The wallet_sendCalls id an approved transfer or calls ran under'),
  txHash: z.string().optional().describe('The transaction an approved transfer or calls landed in'),
  decidedAt: z.string().optional(),
  payment: payOutput
    .optional()
    .describe('An approved payment: what paying it once came to, as jaw_pay_and_fetch answers'),
  summary: z.string(),
});
export type StatusOutput = z.infer<typeof statusOutput>;

const REFUSALS = {
  empty: 'The message is empty.',
  too_long: 'The message is longer than 4096 characters.',
  reserved_prefix: 'Messages starting with "JAW " are reserved for JAW itself.',
  unstorable: 'The message contains a NUL character or a broken surrogate pair.',
  siwe_account: 'This Sign in with Ethereum message is for another account than the connected one.',
  siwe_chain: "This Sign in with Ethereum message is for another chain than the connection's.",
};

const TYPED_DATA_REFUSALS = {
  reserved_domain: 'Typed data under the "JAW" domain is reserved for JAW itself.',
  invalid: 'The typed data is not valid EIP-712: check the types against the message and the domain.',
  too_long: 'The typed data is longer than 16384 characters as JSON.',
  unstorable: 'The typed data contains a NUL character or a broken surrogate pair.',
};

const typedDataInput = z.object({
  domain: z.record(z.string(), z.unknown()),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});

export function describe(request: ApprovalRequest): StatusOutput {
  const approveUrl = `${config().keysOrigin}/approve/${request.id}`;
  const { state, body } = request;
  const paying = body.kind === 'payment';
  const asked = paying
    ? ` paying ${body.terms.requirement.amount} base units of USDC to ${body.terms.requirement.payTo}`
    : '';
  const unpaid = paying ? ' Nothing was paid.' : '';
  const out = {
    requestId: request.id,
    status: state.status,
    approveUrl,
    expiresAt: request.expiresAt.toISOString(),
    account: request.account,
    chainId: `eip155:${request.chainId}`,
  };
  switch (state.status) {
    case 'pending':
      return { ...out, summary: `Waiting for the account owner to approve${asked} at ${approveUrl}.` };
    case 'approved': {
      const { proof } = state.evidence;
      const decidedAt = state.evidence.decidedAt.toISOString();
      switch (proof.type) {
        case 'signature':
          // The owner's payment authorization is sent by this server alone, never handed to the agent.
          if (paying) return { ...out, decidedAt, summary: 'Approved. This server sends the payment.' };
          return {
            ...out,
            signature: proof.signature,
            decidedAt,
            summary: 'Approved. The signature is in `signature`.',
          };
        case 'permission':
          return {
            ...out,
            permissionId: proof.permissionId,
            decidedAt,
            summary: 'Approved. The budget is live; jaw_status shows it.',
          };
        case 'calls':
          return {
            ...out,
            callsId: proof.callsId,
            txHash: proof.txHash,
            decidedAt,
            summary: `Approved. It ran in transaction ${proof.txHash}.`,
          };
      }
    }
    case 'rejected':
      return {
        ...out,
        decidedAt: state.evidence.decidedAt.toISOString(),
        summary: `The account owner rejected it.${unpaid}`,
      };
    case 'expired':
      return { ...out, summary: `Expired before a decision.${unpaid} Ask again if it is still needed.` };
  }
}

export const result = (out: StatusOutput) => ({
  content: [{ type: 'text' as const, text: out.summary }],
  structuredContent: out,
});
export const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
export const NO_SEND_SCOPE =
  'This connection was not granted wallet:send. Reconnect and ask for it to request transfers, contract calls or signatures.';
export const NO_PAY_SCOPE =
  'This connection was not granted x402:pay. Reconnect and ask for it to request a budget or pay x402 services; a budget approved on this connection does not carry over to the new one.';

// A token without the scope of the request's kind is answered as if the request did not exist.
const KIND_SCOPE: Record<ApprovalBody['kind'], ConnectionScope> = {
  budget: 'x402:pay',
  payment: 'x402:pay',
  signature: 'wallet:send',
  siwe: 'wallet:send',
  'typed-data': 'wallet:send',
  transfer: 'wallet:send',
  calls: 'wallet:send',
};

export function requestFor(t: Tenant, body: ApprovalBody): ApprovalRequest {
  return openRequest(
    {
      id: randomBytes(16).toString('base64url') as ApprovalId,
      account: t.account,
      chainId: t.chainId,
      requester: { name: t.clientName, clientId: t.clientId },
      sessionAddress: t.sessionAddress,
      body,
    },
    new Date()
  );
}

const NO_GAS =
  'The gas could not be quoted in USDC, so nothing was prepared. The calls may revert, or the paymaster may be unreachable: check them and try again.';

/** Quotes the calls' gas in USDC, then asks for the body built with it. Refuses rather than show no gas. */
export async function askWithGas(t: Tenant, calls: Call[], body: (gas: GasQuote) => ApprovalBody) {
  const gas = await quoteGas(t.account, t.chainId, calls).catch((err: unknown) => {
    log('warn', { msg: 'gas quote unavailable', error: err instanceof Error ? err.name : 'unknown' });
    return undefined;
  });
  if (!gas) return refusal(NO_GAS);
  return ask(t, requestFor(t, body(gas)));
}

/** Stores the request under the connection's cap and answers with its status. */
export async function ask(t: Tenant, request: ApprovalRequest) {
  if (!(await insertUnderCap(t.connectionId, request, MAX_PENDING))) {
    return refusal(`This connection already has ${MAX_PENDING} requests waiting. Wait for them or let them expire.`);
  }
  return result(describe(request));
}

export function registerApprovalTools(server: McpServer) {
  server.registerTool(
    'jaw_request_signature',
    {
      description:
        'Ask the account owner to sign, with their passkey, either a plain-text message or EIP-712 typed data (exactly one). A message that is a Sign in with Ethereum (EIP-4361) login must name the connected account and chain, and the owner is warned which site it logs into. Returns a link for the owner and a request id; poll jaw_request_status for the signature.',
      inputSchema: z.strictObject({
        message: z.string().optional().describe('The exact text to sign (EIP-191 personal message).'),
        typedData: typedDataInput
          .optional()
          .describe('EIP-712 typed data to sign: domain, types, primaryType, message.'),
      }),
      outputSchema: statusOutput,
    },
    async ({ message, typedData }, ctx) => {
      const t = tenant(ctx);
      if (!t.scopes.includes('wallet:send')) return refusal(NO_SEND_SCOPE);
      if (typedData !== undefined) {
        if (message !== undefined) return refusal('Give either message or typedData, not both.');
        const refused = typedDataRefusal(typedData, t.account);
        if (refused) return refusal(TYPED_DATA_REFUSALS[refused]);
        return ask(t, requestFor(t, { kind: 'typed-data', typedData }));
      }
      if (message === undefined) return refusal('Give the message or the typedData to sign.');
      const body = messageBody(message, t.account, t.chainId);
      if (typeof body === 'string') return refusal(REFUSALS[body]);
      return ask(t, requestFor(t, body));
    }
  );

  server.registerTool(
    'jaw_request_status',
    {
      description: 'Read the state of an approval request made by this connection.',
      inputSchema: z.strictObject({ requestId: z.string() }),
      outputSchema: statusOutput,
      // Not read-only: an approved payment that a crash left unsent is sent from here.
      annotations: { idempotentHint: true },
    },
    async ({ requestId }, ctx) => {
      const t = tenant(ctx);
      const request = await findForConnection(requestId, t.connectionId, new Date());
      if (!request || !t.scopes.includes(KIND_SCOPE[request.body.kind])) {
        return refusal('No such request for this connection.');
      }
      const out = describe(request);
      const { body } = request;
      if (body.kind !== 'payment' || request.state.status !== 'approved') return result(out);
      const paid = await oneOffStatus({ ...request, body });
      if (!paid?.structuredContent) return result(out);
      const summary = `Approved. ${paid.structuredContent.summary}`;
      return {
        content: [{ type: 'text' as const, text: summary }, ...paid.content.slice(1)],
        structuredContent: { ...out, payment: paid.structuredContent, summary },
      };
    }
  );
}
