export const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

export const NO_SEND_SCOPE =
  'This connection was not granted wallet:send. Reconnect and ask for it to send USDC transfers.';
export const NO_PAY_SCOPE =
  'This connection was not granted x402:pay. Reconnect and ask for it to pay x402 services; a budget approved on this connection does not carry over to the new one.';
