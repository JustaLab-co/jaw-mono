// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { concat, hexToString, keccak256, stringToBytes, type Hex } from 'viem';

import { ACCOUNT, CHAIN, cleanup, corpusAccount, renderRequest, shownDigests, type Decision } from './harness';
import { personalSignChallenge, typedDataSignChallenge } from './challenge';

/**
 * The keys signing corpus: hostile and malformed requests, each with the outcome
 * a user must get, written by hand from the payload. See README.md for the rules.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Expect {
  decision?: Decision;
  shows?: string[];
  hides?: string[];
  /** Shown only on hover, never counted as on screen. */
  hovers?: string[];
  /** [label, value]: the value sits in the same row as its label. */
  pairs?: [string, string][];
  /** Pinned from outside TypeScript, see README.md. */
  challenge?: string;
  /** False when what is shown is known not to be what is signed; only a gap may say so. */
  integrity?: boolean;
  /** False when pressing sign must not reach the passkey at all. */
  prompts?: boolean;
  siwe?: { domain: string; uri: string; chainId: string; nonce: string };
  /** The text the screen presents as the message, when it differs from the raw param. */
  signedText?: string;
}

interface Fixture {
  id: string;
  attack: string;
  method?: string;
  params?: unknown[];
  typedData?: { types: Record<string, { name: string; type: string }[]>; primaryType: string };
  message?: string;
  expect: Expect;
  /** `fails` is the start of the assertion message the gap must fail with today. */
  gap?: { note: string; expect: Expect; fails: string };
}

const session = vi.hoisted(() => ({ account: null as unknown }));
vi.mock('../hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionAccount: () => ({
    account: session.account,
    walletAddress: '0x9fD37D2cF1b32b3f7dBae480bbd44BE3De2A9e0F',
    isLoading: false,
    error: null,
    isAuthenticated: true,
  }),
}));

let passkey: { challenge?: Hex };

beforeEach(async () => {
  // Reverse resolution, chain icons and clear-signing descriptors all fetch. Offline
  // they fall back to the raw review, which is the screen the corpus pins.
  vi.stubGlobal('fetch', async () => {
    throw new Error('offline');
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const made = await corpusAccount();
  session.account = made.account;
  passkey = made.passkey;
});

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function request(f: Fixture): { method: string; params: unknown[] } {
  const method = f.method ?? (f.typedData ? 'eth_signTypedData_v4' : 'personal_sign');
  if (f.params) return { method, params: f.params };
  if (f.typedData) return { method, params: [ACCOUNT, JSON.stringify(f.typedData)] };
  return { method, params: [f.message, ACCOUNT] };
}

/** The typed data as keys receives it, whichever envelope carried it. */
function typedPayload(f: Fixture) {
  const envelope = f.params?.[0] as { request?: { type?: string; data?: Fixture['typedData'] } } | undefined;
  return f.typedData ?? (envelope?.request?.type === '0x01' ? envelope.request.data : undefined);
}

/** The message text as keys receives it, whichever envelope carried it. */
function messageParam(f: Fixture): string {
  const envelope = f.params?.[0] as { request?: { data?: { message?: string } } } | undefined;
  return f.message ?? envelope?.request?.data?.message ?? '';
}

async function check(f: Fixture, e: Expect) {
  const { method, params } = request(f);
  const screen = await renderRequest(method, params);

  // Every assertion is labelled so a gap can name the one it fails on.
  if (e.decision) expect(screen.decision, 'decision').toBe(e.decision);
  for (const text of e.shows ?? []) expect(screen.visible, `shows ${text}`).toContain(text);
  for (const text of e.hides ?? []) expect(screen.visible, `hides ${text}`).not.toContain(text);
  for (const text of e.hovers ?? []) expect(screen.hovers, `hovers ${text}`).toContain(text);
  for (const [label, value] of e.pairs ?? []) expect(screen.pair(label, value), `pair ${label}: ${value}`).toBe(true);

  if (e.siwe) {
    expect(screen.visible).toContain(e.siwe.uri);
    expect(screen.visible).toContain(e.siwe.chainId);
    expect(screen.visible).toContain(e.siwe.nonce);
  }

  if (screen.decision === 'blocked') {
    await screen.sign();
    expect(passkey.challenge, 'prompts').toBeUndefined();
    return;
  }

  await screen.sign();
  // Whatever happened at the passkey, the dapp's request must settle.
  await vi.waitFor(() => expect(screen.rejection()).toBeDefined());

  if (e.prompts === false) {
    expect(passkey.challenge, 'prompts').toBeUndefined();
    return;
  }
  expect(passkey.challenge, 'prompts').toBeDefined();
  if (e.challenge) expect(passkey.challenge, 'challenge').toBe(e.challenge);
  if (e.integrity === false) return;

  const typed = typedPayload(f);
  if (typed) {
    const { domainHash, messageHash, digest } = shownDigests(screen.all);
    if (!domainHash || !messageHash) throw new Error('the screen shows no digests to compare');
    expect(digest, 'digest').toBe(keccak256(concat(['0x1901', domainHash, messageHash])));
    expect(passkey.challenge, 'integrity').toBe(
      typedDataSignChallenge({ domainHash, messageHash }, typed, CHAIN.id, ACCOUNT)
    );
    return;
  }

  const raw = messageParam(f);
  const signedText = e.signedText ?? raw;
  expect(passkey.challenge, 'integrity').toBe(personalSignChallenge(stringToBytes(signedText), CHAIN.id, ACCOUNT));
  if (e.siwe) {
    // Each field on screen is the one in the bytes the passkey signed.
    const lines = signedText.split('\n');
    expect(lines[0]).toBe(`${e.siwe.domain} wants you to sign in with your Ethereum account:`);
    expect(lines).toContain(`URI: ${e.siwe.uri}`);
    expect(lines).toContain(`Chain ID: ${e.siwe.chainId}`);
    expect(lines).toContain(`Nonce: ${e.siwe.nonce}`);
  }
}

const load = (file: string): Fixture[] => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const eip712Fixtures = load('./eip712.json');
const messageFixtures = load('./messages.json');

const corpus: Array<[string, Fixture[]]> = [
  ['EIP-712', eip712Fixtures],
  ['personal_sign and SIWE', messageFixtures],
];

describe.each(corpus)('signing corpus: %s', (_kind, fixtures) => {
  it('has unique ids and a stated attack for every fixture', () => {
    const ids = fixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of fixtures) expect(f.attack.length).toBeGreaterThan(0);
  });

  it('names the failing assertion for every gap', () => {
    for (const f of fixtures)
      if (f.gap) expect(f.gap.fails, f.id).toMatch(/^(decision|shows|hides|hovers|pair|integrity)\b/);
  });

  it('only lets a gap waive integrity', () => {
    for (const f of fixtures) {
      if (f.expect.integrity === false) expect(f.gap, f.id).toBeDefined();
    }
  });

  for (const f of fixtures) {
    it(f.id, () => check(f, f.expect));
    // A known hole: it must fail today, on the assertion the gap names. When a fix
    // lands the check passes, this turns red, and the gap moves into `expect`.
    const gap = f.gap;
    if (gap)
      it(`${f.id} [gap] ${gap.note}`, async () => {
        await expect(check(f, { ...f.expect, ...gap.expect })).rejects.toThrow(gap.fails);
      });
  }
});

describe('hex message decoding used by the corpus', () => {
  it('reads the hex-encoded SIWE fixture back to the baseline text', () => {
    const hexed = messageFixtures.find((f) => f.id === 'siwe-hex-encoded');
    expect(hexToString(hexed?.message as Hex)).toBe(hexed?.gap?.expect.signedText);
  });
});

describe('passkey cancellation', () => {
  // The modals map a cancelled prompt to 4001 by checking error.name, but ox wraps
  // whatever the credential request throws in Authentication.SignFailedError and the
  // NotAllowedError ends up in `cause`. The dapp receives -32603 instead.
  it('[gap] reaches the dapp as 4001, not -32603', async () => {
    const screen = await renderRequest('personal_sign', ['hello', ACCOUNT]);
    await screen.sign();
    await vi.waitFor(() => expect(screen.rejection()).toBeDefined());
    // Flip to `.toBe(4001)` without the wrapper when the modals unwrap the cause.
    expect(() => expect(screen.rejection()?.code, 'rejection code').toBe(4001)).toThrow(
      'rejection code: expected -32603 to be 4001'
    );
  });
});
