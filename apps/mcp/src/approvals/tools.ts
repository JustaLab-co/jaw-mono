import { randomBytes } from 'node:crypto';
import { openRequest, validateMessage, type ApprovalId, type ApprovalRequest } from '@jaw.id/agent';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { tenant } from '@/connections/auth';
import { config } from '@/connections/config';
import { countPending, findForConnection, insertRequest } from './store';

const MAX_PENDING = 20;

const statusOutput = z.object({
  requestId: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  approveUrl: z.string().url(),
  expiresAt: z.string(),
  account: z.string(),
  chainId: z.string().describe('CAIP-2 chain id'),
  signature: z.string().optional(),
  decidedAt: z.string().optional(),
  summary: z.string(),
});
type StatusOutput = z.infer<typeof statusOutput>;

const REFUSALS = {
  empty: 'The message is empty.',
  too_long: 'The message is longer than 4096 characters.',
  reserved_prefix: 'Messages starting with "JAW " are reserved for JAW itself.',
};

function describe(request: ApprovalRequest): StatusOutput {
  const approveUrl = `${config().keysOrigin}/approve/${request.id}`;
  const { state } = request;
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
      return { ...out, summary: `Waiting for the account owner to approve at ${approveUrl}.` };
    case 'approved':
      return {
        ...out,
        signature: state.evidence.signature,
        decidedAt: state.evidence.decidedAt.toISOString(),
        summary: 'Approved. The signature is in `signature`.',
      };
    case 'rejected':
      return { ...out, decidedAt: state.evidence.decidedAt.toISOString(), summary: 'The account owner rejected it.' };
    case 'expired':
      return { ...out, summary: 'Expired before a decision. Ask again if it is still needed.' };
  }
}

const result = (out: StatusOutput) => ({
  content: [{ type: 'text' as const, text: out.summary }],
  structuredContent: out,
});
const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

export function registerApprovalTools(server: McpServer) {
  server.registerTool(
    'jaw_request_signature',
    {
      description:
        'Ask the account owner to sign a plain-text message with their passkey. Returns a link for the owner and a request id; poll jaw_request_status for the signature.',
      inputSchema: z.strictObject({
        message: z.string().describe('The exact text to sign (EIP-191 personal message).'),
      }),
      outputSchema: statusOutput,
    },
    async ({ message }, ctx) => {
      const refused = validateMessage(message);
      if (refused) return refusal(REFUSALS[refused]);
      const t = tenant(ctx);
      if ((await countPending(t.connectionId)) >= MAX_PENDING) {
        return refusal(
          `This connection already has ${MAX_PENDING} requests waiting. Wait for them or let them expire.`
        );
      }
      const request = openRequest(
        {
          id: randomBytes(16).toString('base64url') as ApprovalId,
          account: t.account,
          chainId: t.chainId,
          requester: { name: t.clientName, clientId: t.clientId },
          body: { kind: 'signature', message },
        },
        new Date()
      );
      await insertRequest(t.connectionId, request);
      return result(describe(request));
    }
  );

  server.registerTool(
    'jaw_request_status',
    {
      description: 'Read the state of an approval request made by this connection.',
      inputSchema: z.strictObject({ requestId: z.string() }),
      outputSchema: statusOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ requestId }, ctx) => {
      const request = await findForConnection(requestId, tenant(ctx).connectionId, new Date());
      return request ? result(describe(request)) : refusal('No such request for this connection.');
    }
  );
}
