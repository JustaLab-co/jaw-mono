// @vitest-environment jsdom
// (SessionManager persists via localStorage — the shared setup only installs a
// working Storage stub in a jsdom file. See vitest.setup.localstorage.ts.)
import { describe, it, expect, beforeEach } from 'vitest';

import { sessionManager, SessionManager } from './session-manager';
import type { SessionAuthState } from './session-manager';

/**
 * Session auth lifecycle — the primitive the cold-start handshake branch in
 * `app/page.tsx` relies on. Our authState survives a dApp-side disconnect
 * (different origin, and sessions never expire), so it has to be cleared there.
 */

const ORIGIN = 'https://dapp.example';
const OTHER_ORIGIN = 'https://other.example';

const AUTH: SessionAuthState = {
  address: '0x1234567890123456789012345678901234567890',
  credentialId: 'A1b2-C3d4_E5f6',
  username: 'leo',
  publicKey: '0xabcdef',
};

/** A session as created by a real connect: keys exchanged AND authenticated. */
async function createAuthenticatedSession(origin = ORIGIN) {
  return sessionManager.createSession({
    origin,
    peerPublicKey: '04aabbccdd',
    account: AUTH,
  });
}

describe('sessionManager auth lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionManager.clearAllSessions();
  });

  it('reports an origin as authenticated after a connect', async () => {
    await createAuthenticatedSession();

    expect(await sessionManager.isAuthenticated(ORIGIN)).toBe(true);
    expect(await sessionManager.getAuthStateForOrigin(ORIGIN)).toEqual(AUTH);
  });

  it('drops the auth pointer when the auth state is cleared', async () => {
    // What the cold-start handshake branch does. Without this the picker is
    // overridden by the signing modal for the previous account.
    await createAuthenticatedSession();

    await sessionManager.updateSession(ORIGIN, { authState: null });

    expect(await sessionManager.isAuthenticated(ORIGIN)).toBe(false);
    expect(await sessionManager.getAuthStateForOrigin(ORIGIN)).toBeNull();
  });

  it('keeps the session usable after clearing auth', async () => {
    // Only the auth pointer goes. The handshake still has to be answered, so
    // the key material must survive — otherwise the cold-start request fails
    // instead of prompting for an account.
    const created = await createAuthenticatedSession();

    await sessionManager.updateSession(ORIGIN, { authState: null });

    const session = await sessionManager.getSession(ORIGIN);
    expect(session).not.toBeNull();
    expect(session?.popupPrivateKey).toBe(created.popupPrivateKey);
    expect(session?.popupPublicKey).toBe(created.popupPublicKey);
    expect(session?.peerPublicKey).toBe(created.peerPublicKey);
  });

  it('survives the peer-key update the same handshake performs', async () => {
    // The live trace showed `Updating peer key` on that branch, immediately
    // before the auth clear. Order must not resurrect the pointer.
    await createAuthenticatedSession();

    await sessionManager.updatePeerKey(ORIGIN, '04ffeeddcc');
    await sessionManager.updateSession(ORIGIN, { authState: null });

    const session = await sessionManager.getSession(ORIGIN);
    expect(session?.peerPublicKey).toBe('04ffeeddcc');
    expect(await sessionManager.isAuthenticated(ORIGIN)).toBe(false);
  });

  it('clears auth for one origin only', async () => {
    // Sessions are keyed by dApp origin. One dApp disconnecting must not sign
    // the user out of another.
    await createAuthenticatedSession(ORIGIN);
    await createAuthenticatedSession(OTHER_ORIGIN);

    await sessionManager.updateSession(ORIGIN, { authState: null });

    expect(await sessionManager.isAuthenticated(ORIGIN)).toBe(false);
    expect(await sessionManager.isAuthenticated(OTHER_ORIGIN)).toBe(true);
  });

  it('survives clearing auth twice', async () => {
    // The branch runs on every bare handshake, so a second cold start before
    // any reconnect must be a no-op rather than an error.
    await createAuthenticatedSession();

    await sessionManager.updateSession(ORIGIN, { authState: null });
    await sessionManager.updateSession(ORIGIN, { authState: null });

    expect(await sessionManager.isAuthenticated(ORIGIN)).toBe(false);
  });

  it('re-authenticates the same origin after the user picks an account', async () => {
    // Clearing must not poison the origin: once the user picks an account for
    // the cold-start request, keys sets auth again (page.tsx updateAuthState).
    await createAuthenticatedSession();
    await sessionManager.updateSession(ORIGIN, { authState: null });

    await sessionManager.updateSessionAuthState(ORIGIN, AUTH);

    expect(await sessionManager.isAuthenticated(ORIGIN)).toBe(true);
    expect(await sessionManager.getAuthStateForOrigin(ORIGIN)).toEqual(AUTH);
  });

  it('makes a cleared auth visible to the very next read', async () => {
    // The request handler re-reads isAuthenticated straight after the handshake
    // clears it, rather than trusting a react-query snapshot from its closure.
    // If this read were served from a stale cache, the handler would take the
    // authenticated branch and render the signing modal with an empty From row
    // (the address comes from the same authState via useSessionAccount).
    await createAuthenticatedSession();
    expect(await sessionManager.isAuthenticated(ORIGIN)).toBe(true);

    await sessionManager.updateSession(ORIGIN, { authState: null });

    // No await in between, no refetch — the next read must already see it.
    expect(await sessionManager.isAuthenticated(ORIGIN)).toBe(false);
    expect((await sessionManager.getSession(ORIGIN))?.authState).toBeNull();
  });

  it('reports an unknown origin as unauthenticated', async () => {
    expect(await sessionManager.isAuthenticated('https://never-seen.example')).toBe(false);
  });

  it('stays authenticated no matter how old the session is', async () => {
    // Documents WHY the branch must clear explicitly rather than lean on
    // expiry: isValidSession checks SHAPE only — createdAt and lastUsedAt are
    // recorded and never compared — so nothing ages a session out. If a real
    // TTL is ever added, this is the test to revisit.
    const created = await createAuthenticatedSession();
    const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

    await sessionManager.importSession(ORIGIN, {
      ...created,
      createdAt: Date.now() - YEAR_MS,
      lastUsedAt: Date.now() - YEAR_MS,
    });

    expect(await sessionManager.isAuthenticated(ORIGIN)).toBe(true);
  });
});

/**
 * Two keys documents, one storage partition — two popups (both top-level
 * keys.jaw.id), or two iframes in a browser that does not partition storage.
 * Each holds its own SessionManager over the SAME localStorage, and every write
 * persists the whole session map, so a write built on a stale cache erases the
 * other document's entries. The victim keeps working until its next load, then
 * fails to decrypt.
 */
describe('two SessionManagers over one storage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionManager.clearAllSessions();
  });

  /** A second keys document. Loads its cache now, as a real one would on open. */
  function secondDocument() {
    return new SessionManager();
  }

  it('does not erase the other document’s session when creating one', async () => {
    const docA = secondDocument();
    const docB = secondDocument();

    // Both cached an empty map at construction. A writes, then B writes.
    await docA.createSession({ origin: ORIGIN, peerPublicKey: '04aabbccdd', account: AUTH });
    await docB.createSession({ origin: OTHER_ORIGIN, peerPublicKey: '04eeff0011', account: AUTH });

    // What actually landed on disk — read by a third, cache-free reader.
    const onDisk = new SessionManager();
    expect(await onDisk.getSession(ORIGIN)).not.toBeNull();
    expect(await onDisk.getSession(OTHER_ORIGIN)).not.toBeNull();
  });

  it('does not erase the other document’s session when updating one', async () => {
    const docA = secondDocument();
    await docA.createSession({ origin: ORIGIN, peerPublicKey: '04aabbccdd', account: AUTH });

    // B opens after A's write, so it sees both — then A, still on its own
    // cache, clears its authState.
    const docB = secondDocument();
    await docB.createSession({ origin: OTHER_ORIGIN, peerPublicKey: '04eeff0011', account: AUTH });
    await docA.updateSession(ORIGIN, { authState: null });

    const onDisk = new SessionManager();
    expect(await onDisk.isAuthenticated(ORIGIN)).toBe(false);
    expect(await onDisk.isAuthenticated(OTHER_ORIGIN)).toBe(true);
  });

  it('does not resurrect a session the other document deleted', async () => {
    const docA = secondDocument();
    await docA.createSession({ origin: ORIGIN, peerPublicKey: '04aabbccdd', account: AUTH });

    const docB = secondDocument();
    await docB.deleteSession(ORIGIN);

    // A's cache still holds ORIGIN. Its next write must not put it back.
    await docA.createSession({ origin: OTHER_ORIGIN, peerPublicKey: '04eeff0011', account: AUTH });

    const onDisk = new SessionManager();
    expect(await onDisk.getSession(ORIGIN)).toBeNull();
    expect(await onDisk.getSession(OTHER_ORIGIN)).not.toBeNull();
  });

  it('merges an update against the stored session, not a pre-await copy', async () => {
    const docA = secondDocument();
    await docA.createSession({ origin: ORIGIN, peerPublicKey: '04aabbccdd', account: AUTH });

    // B rotates the keys (reconnect); A then clears authState on its stale copy.
    const docB = secondDocument();
    await docB.updatePeerKey(ORIGIN, '04ffeeddcc');
    await docA.updateSession(ORIGIN, { authState: null });

    // A's update must apply on top of B's rotation, not revert it.
    const onDisk = new SessionManager();
    const session = await onDisk.getSession(ORIGIN);
    expect(session?.peerPublicKey).toBe('04ffeeddcc');
    expect(session?.authState).toBeNull();
  });

  it('drops its read cache when another document writes', async () => {
    const reader = secondDocument();
    await reader.createSession({ origin: ORIGIN, peerPublicKey: '04aabbccdd', account: AUTH });
    expect(await reader.isAuthenticated(ORIGIN)).toBe(true);

    // Another document deletes it. jsdom does not raise `storage` across
    // SessionManagers (same window), so dispatch what a real browser would.
    //
    // No `storageArea`: on Node 25+ the global is the in-memory stub from
    // vitest.setup.localstorage.ts, and jsdom's StorageEvent only accepts a real
    // Storage there. The listener guards with `event.storageArea && ...`, so a
    // missing one is a path it handles and this still exercises the cache drop.
    await new SessionManager().deleteSession(ORIGIN);
    window.dispatchEvent(new StorageEvent('storage', { key: 'jaw:sessions:apps' }));

    expect(await reader.isAuthenticated(ORIGIN)).toBe(false);
  });

  it('ignores storage events for other keys', async () => {
    const reader = secondDocument();
    await reader.createSession({ origin: ORIGIN, peerPublicKey: '04aabbccdd', account: AUTH });

    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated:key' }));

    expect(await reader.isAuthenticated(ORIGIN)).toBe(true);
  });
});
