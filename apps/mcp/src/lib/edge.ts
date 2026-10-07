import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServer } from '@modelcontextprotocol/server';
import { recordToolCall } from '@/audit/record';
import { countHit, isPaused } from '@/db/settings';
import { pageCors } from './cors';

export interface RouteContext {
  params: Promise<Record<string, string>>;
}
type Handler = (req: Request, ctx: RouteContext) => Response | Promise<Response>;

export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT = 120;

type RateKey = (req: Request) => string | undefined | Promise<string | undefined>;

// JAW_MCP_TRUSTED_PROXY_HOPS proxies each append the address they saw to
// x-forwarded-for, so the client is the entry that many from the right. Without
// it, x-forwarded-for is the caller's to write; only x-real-ip, which a platform
// such as Vercel sets itself, is used. With neither there is no per-IP limit:
// one shared bucket would let any caller lock everyone out.
export const ipKey: RateKey = (req) => {
  const hops = Number(process.env.JAW_MCP_TRUSTED_PROXY_HOPS ?? 0);
  const ip =
    hops > 0
      ? (req.headers.get('x-forwarded-for') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .at(-hops)
      : req.headers.get('x-real-ip');
  return ip ? `ip:${ip}` : undefined;
};

async function refuse(req: Request, rateKey: RateKey): Promise<Response | undefined> {
  if (await isPaused()) return Response.json({ error: 'paused' }, { status: 503 });
  const key = await rateKey(req);
  if (key && (await countHit(key, RATE_WINDOW_MS)) > RATE_LIMIT) {
    return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '60' } });
  }
  return undefined;
}

// Ids in paths are capabilities (an approval id, an interaction uid); keep them out of logs.
const loggedPath = (url: string) =>
  new URL(url).pathname
    .split('/')
    .map((s) => (s.length >= 16 ? ':id' : s))
    .join('/');

// Error messages can carry query parameters (drizzle puts them in its own),
// so only the class name and a driver code reach the log.
export const errorLabel = (err: unknown) => {
  if (!(err instanceof Error)) return 'unknown';
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${err.name} ${code}` : err.name;
};

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'CONNECT_TIMEOUT',
  '57014',
  '57P01',
  '57P03',
  '08001',
  '08006',
]);

export function databaseUnreachable(err: unknown): boolean {
  const codeOf = (e: unknown) => (e as { code?: unknown } | undefined)?.code;
  return [codeOf(err), codeOf((err as { cause?: unknown } | undefined)?.cause)].some(
    (c) => typeof c === 'string' && UNREACHABLE.has(c)
  );
}

// The MCP SDK answers a throwing tool with the error's message, and a driver
// error's message carries its SQL and parameters.
export function guardTools(server: McpServer): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  server.registerTool = ((name: string, config: unknown, handler: (...args: unknown[]) => unknown) =>
    register(name, config, async (...args: unknown[]) => {
      const result = await answer(handler, args);
      await audit(name, args.at(-1), result.isError ? 'error' : 'ok');
      return result;
    })) as typeof server.registerTool;
}

type ToolResult = { content?: unknown; isError?: boolean };

async function answer(handler: (...args: unknown[]) => unknown, args: unknown[]): Promise<ToolResult> {
  try {
    return (await handler(...args)) as ToolResult;
  } catch (err) {
    log('error', { msg: 'tool failed', error: errorLabel(err) });
    const text = databaseUnreachable(err)
      ? 'The service is temporarily unavailable. Try again shortly.'
      : 'The tool failed on the server.';
    return { content: [{ type: 'text', text }], isError: true };
  }
}

// The edge's request id, so an audit event matches the x-request-id the client saw and the log line.
const requestScope = new AsyncLocalStorage<string>();

// Never fails the call: the tool may already have moved money, and its answer matters more than the record.
async function audit(tool: string, ctx: unknown, outcome: 'ok' | 'error') {
  const tenant = (ctx as { http?: { authInfo?: { extra?: { tenant?: { connectionId: string } } } } } | undefined)?.http
    ?.authInfo?.extra?.tenant;
  if (!tenant) return;
  await recordToolCall({ connectionId: tenant.connectionId, tool, outcome, requestId: requestScope.getStore() }).catch(
    (err) => log('error', { msg: 'audit record failed', error: errorLabel(err) })
  );
}

export function withEdge(
  handler: Handler,
  { guarded, cors = false, rateKey = ipKey }: { guarded: boolean; cors?: boolean; rateKey?: RateKey }
): (req: Request, ctx: RouteContext) => Promise<Response> {
  return async (req, ctx) => {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    let res: Response;
    try {
      res = (guarded && (await refuse(req, rateKey))) || (await requestScope.run(requestId, () => handler(req, ctx)));
    } catch (err) {
      log('error', { requestId, error: errorLabel(err) });
      res = databaseUnreachable(err)
        ? Response.json({ error: 'unavailable', requestId }, { status: 503 })
        : Response.json({ error: 'internal_error', requestId }, { status: 500 });
    }
    const out = new Response(res.body, res);
    out.headers.set('x-request-id', requestId);
    log('info', {
      requestId,
      method: req.method,
      path: loggedPath(req.url),
      status: out.status,
      ms: Math.round(performance.now() - started),
    });
    return cors ? pageCors(out) : out;
  };
}

interface LogFields {
  msg?: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  ms?: number;
  error?: string;
}

export function log(level: 'info' | 'warn' | 'error', fields: LogFields) {
  console.log(JSON.stringify({ level, time: new Date().toISOString(), ...fields }));
}
