import { createHash, randomBytes } from 'node:crypto';
import { getSupportedChains } from '@jaw.id/core';
import type { McpServer } from '@modelcontextprotocol/server';
import { hashTypedData, toHex } from 'viem';
import { z } from 'zod';
import { tenant, type Tenant } from '@/connections/auth';
import { APPROVE_WITHIN_MS } from '@/connections/config';
import { ownerRelay, WalletBusy, type Ask, type OpenWallet, type Wallet } from '@/connections/relay';
import { findActive } from '@/connections/rows';
import { USER_REJECTED } from '@/connections/wallet-codes';
import { countHit } from '@/db/settings';
import { errorLabel, log, RATE_WINDOW_MS } from '@/lib/edge';
import { reply } from '@/lib/fence';
import { countOpenLinks, MAX_OPEN_PER_ACCOUNT } from '@/owner-calls/cap';
import { gateCode } from '@/payments/render';

const LINK_RATE_LIMIT = 10;
const MESSAGE_MAX = 8_192;
const TYPED_DATA_MAX = 32_768;
// A finished request stays readable this long after its window, so the agent can fetch the signature.
const KEEP_AFTER_MS = 10 * 60_000;
const SESSION_END_MARGIN_MS = 5_000;
// Format and invisible characters would let the owner read one text and sign another. Line breaks and tabs stay.
const UNSEEN = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

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

type Request = { type: '0x45'; data: { message: string } } | { type: '0x01'; data: Record<string, unknown> };

type Entry = {
  id: string;
  key: string;
  hash: string;
  account: string;
  chainId: number;
  request: Request;
  state: z.infer<typeof signOutput>['state'];
  code?: string;
  signature?: string;
  url: string;
  approveBy: Date;
};

export interface SignDeps {
  openWallet: OpenWallet;
}

const DEFAULTS: SignDeps = { openWallet: ownerRelay };

// Requests live in this process, as the wallet sessions that answer them do.
const entries = new Map<string, Entry & { connectionId: string }>();

const refuse = (code: string, text: string): SignResult => ({
  content: [{ type: 'text', text: `${code}: ${text}` }],
  isError: true,
  [gateCode]: code,
});

const kindOf = (e: Entry) => (e.request.type === '0x45' ? 'message' : 'typedData');

function expireLate(e: Entry) {
  if (e.state === 'awaiting_owner' && e.approveBy.getTime() <= Date.now()) e.state = 'expired';
}

function summaryOf(e: Entry): string {
  const by = e.approveBy.toISOString();
  const what = kindOf(e) === 'message' ? 'the message' : 'the typed data';
  switch (e.state) {
    case 'awaiting_owner':
      return (
        `Ask the owner to open ${e.url} before ${by} and review ${what} from ${e.account}. ` +
        'The owner sees it in their wallet and signs there; this connection never signs it. ' +
        `Send jaw_sign again with idempotencyKey ${e.key} and the same input to read the signature.`
      );
    case 'signed':
      return `The owner signed ${what} in the wallet.`;
    case 'owner_declined':
      return e.code === 'wrong_account'
        ? 'The owner signed in with another account than this connection. Nothing was signed.'
        : `The owner declined to sign ${what}. Nothing was signed.`;
    case 'expired':
      return `The owner did not sign before ${by}. Use a new idempotencyKey to ask again.`;
    case 'failed':
      return `The wallet could not sign (${e.code}). Nothing was signed. Use a new idempotencyKey to ask again.`;
  }
}

function answer(e: Entry): SignResult {
  expireLate(e);
  return reply(
    signOutput.parse({
      id: e.id,
      idempotencyKey: e.key,
      state: e.state,
      kind: kindOf(e),
      url: e.state === 'awaiting_owner' ? e.url : undefined,
      approveBy: e.approveBy.toISOString(),
      from: e.account,
      signature: e.signature,
      refusal: e.code ? { code: e.code } : undefined,
      summary: summaryOf(e),
    })
  );
}

const accountBusy = () =>
  refuse(
    'account_busy',
    `This account already has ${MAX_OPEN_PER_ACCOUNT} requests awaiting the owner across its connections. Wait until one ends, then try again.`
  );

const hasAccount = (accounts: unknown, account: string) =>
  Array.isArray(accounts) && accounts.some((a) => typeof a === 'string' && a.toLowerCase() === account.toLowerCase());

const codeOf = (err: unknown) => (err as { code?: unknown } | undefined)?.code;

const finish = (e: Entry, state: Entry['state'], code?: string, signature?: string) => {
  if (e.state === 'awaiting_owner') Object.assign(e, { state, code, signature });
};

/** Asks the owner's wallet for the account, then for the signature, and records what came back. */
async function approve(ask: Ask, e: Entry): Promise<void> {
  try {
    if (!hasAccount(await ask('eth_requestAccounts', []), e.account))
      return finish(e, 'owner_declined', 'wrong_account');
    const signed = await ask('wallet_sign', [{ address: e.account, chainId: toHex(e.chainId), request: e.request }]);
    const signature = z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .safeParse(signed).data;
    if (signature) finish(e, 'signed', undefined, signature);
    else finish(e, 'failed', 'wallet_answer_unreadable');
  } catch (err) {
    const code = codeOf(err);
    if (code === USER_REJECTED) return finish(e, 'owner_declined', 'owner_declined');
    if (Date.now() >= e.approveBy.getTime() - SESSION_END_MARGIN_MS) return finish(e, 'expired');
    finish(e, 'failed', `wallet_error:${typeof code === 'number' ? code : 'unknown'}`);
  }
}

function follow(e: Entry, wallet: Wallet): void {
  void wallet
    .run((ask) => approve(ask, e))
    .catch((err: unknown) => {
      log('warn', { msg: 'sign approval ended', error: errorLabel(err) });
      finish(e, Date.now() >= e.approveBy.getTime() - SESSION_END_MARGIN_MS ? 'expired' : 'failed', 'session_ended');
    });
}

function prune() {
  const now = Date.now();
  for (const [k, e] of entries) {
    if (e.state !== 'awaiting_owner' && e.approveBy.getTime() + KEEP_AFTER_MS < now) entries.delete(k);
  }
}

const openSigns = (account: string) => {
  const lowered = account.toLowerCase();
  let n = 0;
  for (const e of entries.values()) {
    expireLate(e);
    if (e.state === 'awaiting_owner' && e.account.toLowerCase() === lowered) n++;
  }
  return n;
};

/** Why typed data cannot be signed, or undefined. Runs before any link opens. */
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

function requestOf(input: SignInput): Request | SignResult {
  if (input.message !== undefined) {
    if (UNSEEN.test(input.message)) {
      return refuse('invalid_message', 'The message has invisible or control characters the owner could not see.');
    }
    return { type: '0x45', data: { message: input.message } };
  }
  const data = input.typedData!;
  if (JSON.stringify(data).length > TYPED_DATA_MAX) return refuse('invalid_typed_data', 'The typed data is too large.');
  const fault = typedDataFault(data);
  return fault ? refuse('invalid_typed_data', `The typed data is malformed: ${fault}.`) : { type: '0x01', data };
}

async function openWalletFor(t: Tenant, approveBy: Date, deps: SignDeps): Promise<Wallet | undefined> {
  try {
    return await deps.openWallet(t.chainId, approveBy, t);
  } catch (err) {
    if (err instanceof WalletBusy) return undefined;
    throw err;
  }
}

export async function sign(t: Tenant, input: SignInput, deps: SignDeps = DEFAULTS): Promise<SignResult> {
  const chainId = input.chainId ?? t.chainId;
  if (!getSupportedChains(true).some((chain) => chain.id === chainId)) {
    return refuse('unsupported_chain', `Chain ${chainId} is not one the JAW wallet supports.`);
  }
  const request = requestOf(input);
  if (!('type' in request)) return request;

  const key = input.idempotencyKey ?? `auto_${randomBytes(12).toString('base64url')}`;
  const hash = createHash('sha256')
    .update(JSON.stringify([chainId, request]))
    .digest('hex');
  const slot = `${t.connectionId}:${key}`;
  prune();
  const stored = entries.get(slot);
  if (stored) {
    return stored.hash === hash
      ? answer(stored)
      : refuse('idempotency_conflict', 'This idempotency key was used for another request. Nothing was signed.');
  }

  if ((await countHit(`owner-sign:${t.connectionId}`, RATE_WINDOW_MS)) > LINK_RATE_LIMIT) {
    return refuse('rate_limited', 'Too many approval links on this connection. Wait a minute.');
  }
  if (!(await findActive(t.connectionId))) {
    return refuse(
      'connection_ended',
      'This connection has ended, so no approval link opens. Connect again to ask the owner.'
    );
  }
  if ((await countOpenLinks(t.account)) + openSigns(t.account) >= MAX_OPEN_PER_ACCOUNT) return accountBusy();
  const approveBy = new Date(Date.now() + APPROVE_WITHIN_MS);
  const wallet = await openWalletFor(t, approveBy, deps);
  if (!wallet) {
    return refuse(
      'wallet_busy',
      `Too many owners are approving right now. Send idempotencyKey ${key} again in a minute.`
    );
  }
  const raced = entries.get(slot);
  if (raced) {
    wallet.close();
    return answer(raced);
  }
  const entry = {
    id: `sg_${randomBytes(16).toString('base64url')}`,
    connectionId: t.connectionId,
    key,
    hash,
    account: t.account,
    chainId,
    request,
    state: 'awaiting_owner' as const,
    url: wallet.url,
    approveBy,
  };
  entries.set(slot, entry);
  // Counted before the database read, so links asked for together cannot all pass.
  const mine = openSigns(t.account);
  if ((await countOpenLinks(t.account)) + mine > MAX_OPEN_PER_ACCOUNT) {
    entries.delete(slot);
    wallet.close();
    return accountBusy();
  }
  follow(entry, wallet);
  return answer(entry);
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
