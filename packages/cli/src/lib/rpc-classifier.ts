/**
 * Classifies RPC methods to determine if they require browser interaction.
 * Used to show appropriate terminal prompts to the user.
 */

const BROWSER_REQUIRED_METHODS = new Set([
  // Signing
  'personal_sign',
  'eth_signTypedData_v4',
  'wallet_sign',
  // Transactions
  'wallet_sendCalls',
  'eth_sendTransaction',
  // Connection / account
  'wallet_connect',
  'eth_requestAccounts',
  // Permissions
  'wallet_grantPermissions',
  'wallet_revokePermissions',
  // Funding. No signature, but it still opens a screen and waits for the user
  // to close it, so the terminal has to say a browser is needed.
  'wallet_addFunds',
]);

export function requiresBrowser(method: string): boolean {
  return BROWSER_REQUIRED_METHODS.has(method);
}

/**
 * What the session key may do without a human present.
 *
 * Signing is deliberately absent. A session that signs arbitrary typed data can
 * be asked for an EIP-3009 authorization or an EIP-2612 `permit` over its own
 * USDC, and neither is a call, so neither passes the x402 policy, reaches the
 * ledger, or takes the payment lock. A `permit` is the worse of the two: it
 * leaves a standing allowance, so it takes every later top-up as it arrives
 * rather than just the balance of the moment.
 *
 * Being delegated does not help. USDC routes a delegated account through
 * EIP-1271, and ERC-7739 rejects a raw signature over the plain digest, but the
 * envelope is ordinary typed data and the wrapping suffix is public (see
 * `wrappedSigner` in `x402/payer.ts`), so asking for the envelope gets the same
 * result.
 *
 * Nothing here needs it: the payer signs through its own injected signer and
 * top-ups go through `wallet_sendCalls`. A caller that wants a signature can
 * still ask for one through the browser, where a human sees what it is.
 */
const SESSION_SUPPORTED_METHODS = new Set([
  'eth_requestAccounts',
  'eth_accounts',
  'wallet_sendCalls',
  'wallet_getCallsStatus',
]);

export function supportsSessionMode(method: string): boolean {
  return SESSION_SUPPORTED_METHODS.has(method);
}
