import { createHash, randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { hashTypedData } from 'viem';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { APPROVE_WITHIN_MS } from '@/connections/config';
import { ownerRelay, type OpenWallet } from '@/connections/relay';
import { findActive } from '@/connections/rows';
import { countHit } from '@/db/settings';
import {
  currentSign,
  LINK_LOST,
  lostBefore,
  lostPreamble,
  openLink,
  type PermissionRequestRow,
} from '@/grants/requests';
import { signWork, type SignPayload, type SignRequest } from '@/grants/resume';
import { canonical } from '@/lib/canonical';
import { isProxyChain } from '@/lib/chain';
import { RATE_WINDOW_MS } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { MAX_OPEN_PER_ACCOUNT } from '@/owner-calls/cap';
import { gateCode } from '@/payments/render';

const LINK_RATE_LIMIT = 10;
const ACCOUNT_LINK_RATE_LIMIT = 20;
const MESSAGE_MAX = 8_192;
const TYPED_DATA_MAX = 32_768;
const HIDDEN_IN_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const HIDDEN_FROM_OWNER = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

const signInput = z
  .strictObject({
    message: z
      .string()
      .min(1)
      .max(MESSAGE_MAX)
      .optional()
      .describe('Text to sign as an EIP-191 personal message, shown to the owner exactly as sent'),
    typedData: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('EIP-712 typed data: { domain, types, primaryType, message }'),
    chainId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("A chain the JAW wallet supports; defaults to this connection's chain"),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,100}$/)
      .optional()
      .describe('Send it again with the same input to read the outcome; one is made up and returned when absent'),
  })
  .refine((v) => (v.message === undefined) !== (v.typedData === undefined), {
    message: 'Send exactly one of message and typedData',
  });
export type SignInput = z.infer<typeof signInput>;

const signOutput = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  state: z.enum(['awaiting_owner', 'signed', 'owner_declined', 'expired', 'failed']),
  kind: z.enum(['message', 'typedData']),
  url: z.url().optional().describe('Link for the owner, while awaiting_owner'),
  approveBy: z.string(),
  from: z.string(),
  signature: z.string().optional().describe("The account's signature, once the owner approved"),
  refusal: z.object({ code: z.string() }).optional(),
  summary: z.string(),
});

type SignResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: z.infer<typeof signOutput>;
  isError?: boolean;
  [gateCode]?: string;
};

type Request = SignRequest;

export interface SignDeps {
  openWallet: OpenWallet;
}

const DEFAULTS: SignDeps = { openWallet: ownerRelay };

const refuse = (code: string, text: string): SignResult => ({
  content: [{ type: 'text', text: `${code}: ${text}` }],
  isError: true,
  [gateCode]: code,
});

const STATE = {
  awaiting_owner: 'awaiting_owner',
  approved: 'signed',
  owner_declined: 'owner_declined',
  expired: 'expired',
  failed: 'failed',
} as const;

function summaryOf(row: PermissionRequestRow): string {
  const by = row.approveBy.toISOString();
  const what = row.signKind === 'message' ? 'the message' : 'the typed data';
  switch (row.state) {
    case 'awaiting_owner':
      return (
        `Ask the owner to open ${row.walletUrl} before ${by} and review ${what} from ${row.account}. ` +
        'The owner sees it in their wallet and signs there; this connection never signs it. ' +
        `Send jaw_sign again with idempotencyKey ${row.idempotencyKey} and the same input to read the signature.`
      );
    case 'approved':
      return `The owner signed ${what} in the wallet.`;
    case 'owner_declined':
      return row.code === 'wrong_account'
        ? 'The owner signed in with another account than this connection. Nothing was signed.'
        : `The owner declined to sign ${what}. Nothing was signed.`;
    case 'expired':
      if (row.code === LINK_LOST) {
        return 'The server lost the wallet session after asking the owner, so it may never hear an answer given on that link. Tell the owner not to approve it there, and ask again with a new idempotencyKey to open a new link.';
      }
      return row.code === 'session_lost'
        ? 'The server lost the wallet session before the owner was asked, so nothing was signed. Ask again with a new idempotencyKey.'
        : `The owner did not sign before ${by}. Use a new idempotencyKey to ask again.`;
    case 'failed':
      return `The wallet could not sign (${row.code}). Nothing was signed. Use a new idempotencyKey to ask again.`;
  }
}

async function answer(row: PermissionRequestRow): Promise<SignResult> {
  const lost = await lostBefore(row);
  const ended = row.state !== 'awaiting_owner' && row.state !== 'approved';
  return reply(
    signOutput.parse({
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      state: STATE[row.state],
      kind: row.signKind,
      url: row.state === 'awaiting_owner' ? row.walletUrl : undefined,
      approveBy: row.approveBy.toISOString(),
      from: row.account,
      signature: row.signature ?? undefined,
      refusal: ended ? { code: row.code ?? row.state } : undefined,
      summary:
        (lost
          ? lostPreamble(lost, 'sign') +
            `Tell the owner not to approve that one; idempotencyKey ${lost.idempotencyKey} answers link_lost. `
          : '') + summaryOf(row),
    })
  );
}

function typedDataFault(data: Record<string, unknown>): string | undefined {
  const { types, primaryType } = data;
  if (typeof types !== 'object' || types === null || Array.isArray(types))
    return '"types" must be an object of EIP-712 type definitions';
  if (typeof primaryType !== 'string' || !Array.isArray((types as Record<string, unknown>)[primaryType])) {
    return '"primaryType" must name a type defined in "types"';
  }
  try {
    hashTypedData(data as Parameters<typeof hashTypedData>[0]);
  } catch (err) {
    return `it could not be hashed: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'}`;
  }
  return undefined;
}

/** Line breaks and tabs pass only in message values; names, types and the domain allow none. */
function hidesText(data: Record<string, unknown>): boolean {
  const queue: [unknown, RegExp][] = [[data, HIDDEN_IN_NAME]];
  for (const [value, rule] of queue) {
    if (typeof value === 'string' && rule.test(value)) return true;
    if (typeof value !== 'object' || value === null) continue;
    for (const [key, child] of Object.entries(value)) {
      const inMessage = rule === HIDDEN_FROM_OWNER || (value === data && key === 'message');
      queue.push([key, HIDDEN_IN_NAME], [child, inMessage ? HIDDEN_FROM_OWNER : HIDDEN_IN_NAME]);
    }
  }
  return false;
}

function requestOf(input: SignInput): Request | SignResult {
  if (input.message !== undefined) {
    if (HIDDEN_FROM_OWNER.test(input.message)) {
      return refuse('invalid_message', 'The message has invisible or control characters the owner could not see.');
    }
    return { type: '0x45', data: { message: input.message } };
  }
  const data = input.typedData!;
  if (JSON.stringify(data).length > TYPED_DATA_MAX) return refuse('invalid_typed_data', 'The typed data is too large.');
  if (hidesText(data)) {
    return refuse('invalid_typed_data', 'The typed data has invisible or control characters the owner could not see.');
  }
  const fault = typedDataFault(data);
  return fault ? refuse('invalid_typed_data', `The typed data is malformed: ${fault}.`) : { type: '0x01', data };
}

export async function sign(t: Tenant, input: SignInput, deps: SignDeps = DEFAULTS): Promise<SignResult> {
  const chainId = input.chainId ?? t.chainId;
  if (!isProxyChain(chainId)) {
    return refuse('unsupported_chain', `Chain ${chainId} is not one the JAW wallet supports.`);
  }
  const request = requestOf(input);
  if (!('type' in request)) return request;

  const idempotencyKey = input.idempotencyKey ?? `auto_${randomBytes(12).toString('base64url')}`;
  const requestHash = createHash('sha256')
    .update(canonical([chainId, request]))
    .digest('hex');
  const answerStored = (row: PermissionRequestRow) =>
    row.requestHash === requestHash
      ? answer(row)
      : refuse('idempotency_conflict', 'This idempotency key was used for another request. Nothing was signed.');
  const stored = await currentSign(t, idempotencyKey, signWork);
  if (stored) return answerStored(stored);

  if ((await countHit(`owner-sign:${t.connectionId}`, RATE_WINDOW_MS)) > LINK_RATE_LIMIT) {
    return refuse('rate_limited', 'Too many approval links on this connection. Wait a minute.');
  }
  if ((await countHit(`owner-sign-account:${t.account.toLowerCase()}`, RATE_WINDOW_MS)) > ACCOUNT_LINK_RATE_LIMIT) {
    return refuse('rate_limited', 'Too many approval links for this account. Wait a minute.');
  }
  if (!(await findActive(t.connectionId))) {
    return refuse(
      'connection_ended',
      'This connection has ended, so no approval link opens. Connect again to ask the owner.'
    );
  }
  const payload: SignPayload = { chainId, request };
  const opened = await openLink(
    t,
    {
      method: 'sign',
      idempotencyKey,
      requestHash,
      signKind: request.type === '0x45' ? 'message' : 'typedData',
      chainId,
      approveBy: new Date(Date.now() + APPROVE_WITHIN_MS),
      payload,
      rebuild: signWork,
    },
    deps.openWallet
  );
  if (opened === 'account_busy') {
    return refuse(
      'account_busy',
      `This account already has ${MAX_OPEN_PER_ACCOUNT} requests awaiting the owner across its connections. Wait until one ends, then try again.`
    );
  }
  if (opened === 'wallet_busy') {
    return refuse(
      'wallet_busy',
      `Too many owners are approving right now. Send idempotencyKey ${idempotencyKey} again in a minute.`
    );
  }
  const row = 'opened' in opened ? opened.opened : opened.waiting;
  if (row.idempotencyKey !== idempotencyKey) {
    return refuse(
      'sign_in_progress',
      `This connection already asked the owner to sign under idempotencyKey ${row.idempotencyKey}, until ${row.approveBy.toISOString()}. Read it with that key, or ask again once it ends.`
    );
  }
  return answerStored(row);
}

export function registerSignTool(server: McpServer) {
  server.registerTool(
    'jaw_sign',
    {
      description:
        'Ask the account owner to sign a message (EIP-191) or EIP-712 typed data with the account. The owner sees it on keys.jaw.id and approves with their passkey; this connection never signs it. ' +
        'Returns a link for the owner right away. Send the same idempotencyKey and input again to read the signature once the owner approves. ' +
        'Pass exactly one of message and typedData. Tell the owner in plain words what signing it allows: their review is the only check, and a signature can authorize payments or approvals.',
      inputSchema: signInput,
      outputSchema: signOutput,
    },
    async (input, ctx) => sign(tenant(ctx), input)
  );
}
