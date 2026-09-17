/**
 * Method policy — the security model that decides which EIP-1193 / wallet RPC
 * methods may be served *silently* (no user gesture, no visible UI) versus
 * those that MUST run an interactive flow (a dialog the user can see and
 * approve).
 *
 * This is the prerequisite for headless auto-reconnect: a returning user is
 * reconnected by answering read-only methods (`eth_accounts`, `eth_chainId`,
 * …) from the cached, still-valid session — never by silently producing a
 * signature, sending a transaction, or creating/using a credential.
 *
 * Invariant: a method is silent ONLY if it cannot move funds, cannot produce a
 * signature, cannot grant/extend authority, and exposes nothing the user has
 * not already authorized. Everything else is interactive. When in doubt, a
 * method is interactive — the set below is an explicit allow-list, and the
 * default ({@link isSilentMethod} returning false) fails safe.
 */

/**
 * Read-only methods safe to resolve without any user interaction. They return
 * already-known/already-authorized state (the connected accounts, the chain,
 * capabilities, call status/history, assets) and never mutate authority.
 *
 * `eth_accounts` is the keystone: wallet libraries (wagmi) call it on mount to
 * decide whether to reconnect, so it has to answer silently — but only after
 * the session is confirmed live (see the signer's TTL check). It must never
 * open a dialog: an absent/expired session reports `[]`, not a prompt.
 */
export const SILENT_METHODS: readonly string[] = [
    'eth_accounts',
    'eth_chainId',
    'eth_coinbase',
    'net_version',
    'wallet_getCapabilities',
    'wallet_getCallsStatus',
    'wallet_getCallsHistory',
    'wallet_getAssets',
    'wallet_getPermissions',
];

/**
 * Methods that require an interactive, user-visible flow. They either create a
 * credential, establish/elevate a connection, produce a signature, send calls,
 * or change delegated authority. None of these may EVER be served headlessly.
 */
export const INTERACTIVE_METHODS: readonly string[] = [
    'eth_requestAccounts',
    'wallet_connect',
    'wallet_sendCalls',
    'wallet_sign',
    'personal_sign',
    'eth_sign',
    'eth_signTypedData',
    'eth_signTypedData_v4',
    'eth_sendTransaction',
    'wallet_grantPermissions',
    'wallet_revokePermissions',
    'wallet_addFunds',
];

/** Whether a method may be resolved silently (no user gesture, no UI). */
export function isSilentMethod(method: string): boolean {
    return SILENT_METHODS.includes(method);
}

/**
 * Whether a method requires an interactive flow. The complement of the silent
 * allow-list: anything not explicitly silent is treated as interactive, so an
 * unknown/new method can never be served headlessly by omission.
 */
export function requiresInteraction(method: string): boolean {
    return !isSilentMethod(method);
}
