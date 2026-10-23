import { MAX_OPEN_PER_ACCOUNT } from '@/owner-calls/cap';

export const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** Starts a line meant for the agent alone: what to do next, which it never repeats to the owner. */
export const FOR_AGENT = 'For the agent:';

/** What the owner is told, then, on its own line, what the agent does about it. */
export const withNext = (say: string, next?: string) => (next ? `${say}\n${FOR_AGENT} ${next}` : say);

export const NO_PAY_SCOPE = withNext(
  'This connection was not allowed to pay for services. Reconnecting with payments allowed fixes that; a budget approved on this connection does not carry over to the new one.',
  'Reconnect and ask for the x402:pay scope.'
);

export const ACCOUNT_BUSY = `account_busy: This account already has ${MAX_OPEN_PER_ACCOUNT} requests awaiting the owner across its connections. Wait until one ends, then try again.`;
