import { MAX_OPEN_PER_ACCOUNT } from '@/owner-calls/cap';

export const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

export const NO_PAY_SCOPE =
  'This connection was not granted x402:pay. Reconnect and ask for it to pay x402 services; a budget approved on this connection does not carry over to the new one.';

export const ACCOUNT_BUSY = `account_busy: This account already has ${MAX_OPEN_PER_ACCOUNT} requests awaiting the owner across its connections. Wait until one ends, then try again.`;
