import { timingSafeEqual } from 'node:crypto';

/** Whether the request carries the operator's cron secret. No secret configured means nobody does. */
export function authorized(req: Request): boolean {
  const secret = process.env.JAW_MCP_CRON_SECRET;
  const sent = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!secret || !sent) return false;
  const [a, b] = [Buffer.from(sent), Buffer.from(secret)];
  return a.length === b.length && timingSafeEqual(a, b);
}
