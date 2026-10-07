import { countHit, isPaused } from '@/db/settings';
import { pageCors } from './cors';

export interface RouteContext {
  params: Promise<Record<string, string>>;
}
type Handler = (req: Request, ctx: RouteContext) => Response | Promise<Response>;

export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT = 120;

// JAW_MCP_TRUSTED_PROXY_HOPS proxies each append the address they saw to
// x-forwarded-for, so the client is the entry that many from the right. Without
// it, x-forwarded-for is the caller's to write; only x-real-ip, which a platform
// such as Vercel sets itself, is used.
function clientIp(req: Request): string {
  const hops = Number(process.env.JAW_MCP_TRUSTED_PROXY_HOPS ?? 0);
  if (hops > 0) {
    const chain = (req.headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return chain.at(-hops) ?? 'unknown';
  }
  return req.headers.get('x-real-ip') || 'unknown';
}

async function refuse(req: Request): Promise<Response | undefined> {
  if (await isPaused()) return Response.json({ error: 'paused' }, { status: 503 });
  const hits = await countHit(`ip:${clientIp(req)}`, RATE_WINDOW_MS);
  if (hits > RATE_LIMIT) {
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
const errorLabel = (err: unknown) => {
  if (!(err instanceof Error)) return 'unknown';
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${err.name} ${code}` : err.name;
};

export function withEdge(
  handler: Handler,
  { guarded, cors = false }: { guarded: boolean; cors?: boolean }
): (req: Request, ctx: RouteContext) => Promise<Response> {
  return async (req, ctx) => {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    let res: Response;
    try {
      res = (guarded && (await refuse(req))) || (await handler(req, ctx));
    } catch (err) {
      log('error', { requestId, error: errorLabel(err) });
      res = Response.json({ error: 'internal_error', requestId }, { status: 500 });
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

export function log(level: 'info' | 'error', fields: LogFields) {
  console.log(JSON.stringify({ level, time: new Date().toISOString(), ...fields }));
}
