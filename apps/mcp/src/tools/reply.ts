import { sanitizeLine } from '@jaw.id/agent';
import { z } from 'zod';
import { scrub } from '@/lib/scrub';
import { MAX_OPEN_PER_ACCOUNT } from '@/owner-calls/cap';

export const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** Why a read of the proxy failed, for the agent: one line, with no api key in it. */
export function reasonOf(err: unknown) {
  if (err instanceof z.ZodError) return 'The proxy answered with an unexpected shape.';
  const message = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : 'request failed';
  return sanitizeLine(scrub(message), 200);
}

/** Starts a line meant for the agent alone: what to do next, which it never repeats to the owner. */
export const FOR_AGENT = 'For the agent:';

/** What the owner is told, then, on its own line, what the agent does about it. */
export const withNext = (say: string, next?: string) => (next ? `${say}\n${FOR_AGENT} ${next}` : say);

export const NO_PAY_SCOPE = withNext(
  'This connection was not allowed to pay for services when it was set up. Reconnecting with payments allowed fixes that; a spend limit approved on this connection does not carry over to the new one.',
  'Reconnect and ask for the x402:pay scope.'
);

/** The account's open-link cap is full: its code first, then what the owner hears and what the agent does. */
export const ACCOUNT_BUSY = `account_busy: ${withNext(
  `The wallet already has ${MAX_OPEN_PER_ACCOUNT} requests waiting for approval. One has to be answered or expire before a new one can open.`,
  'Wait, then try again.'
)}`;
