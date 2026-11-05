// @vitest-environment jsdom
// Regression cover for two signing-review behaviors: the "Signed in" tick is
// driven by the parent-owned isSuccess prop (never shown mid-delivery or after a
// failure), and an unparseable SIWE message surfaces a "couldn't read" notice
// instead of silently dropping the structured review.
// Client-rendered via createRoot+act because the review screen mounts Radix
// portals that static SSR doesn't capture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

vi.mock('@jaw.id/core', () => ({ SUPPORTED_CHAINS: [] }));
vi.mock('../../hooks/useReverseIdentity', () => ({
  useReverseIdentity: () => ({ name: undefined, avatar: undefined }),
}));

import { SiweDialog } from './index';
import type { SiweDialogProps } from './types';

const VALID_SIWE =
  'app.example wants you to sign in with your Ethereum account:\n' +
  '0x1111111111111111111111111111111111111111\n\n' +
  'Sign in.\n\n' +
  'URI: https://app.example\nVersion: 1\nChain ID: 1\nNonce: abcdef123456\n' +
  'Issued At: 2026-01-01T00:00:00.000Z';

const props = (over: Partial<SiweDialogProps> = {}): SiweDialogProps => ({
  open: true,
  onOpenChange: () => undefined,
  message: VALID_SIWE,
  origin: 'https://app.example',
  appName: 'Example',
  accountAddress: '0x2222222222222222222222222222222222222222',
  onSign: async () => undefined,
  onCancel: () => undefined,
  isProcessing: false,
  isSuccess: false,
  siweStatus: '',
  canSign: true,
  mainnetRpcUrl: 'https://rpc.example',
  ...over,
});

let root: Root | null = null;
async function render(p: SiweDialogProps): Promise<string> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(SiweDialog, p));
  });
  return document.body.innerHTML;
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = '';
  root = null;
});

describe('SiweDialog — parent-owned success tick (blocker 1)', () => {
  it('shows "Signed in" only when the parent passes isSuccess=true', async () => {
    expect(await render(props({ isSuccess: true }))).toContain('Signed in');
  });
  it('does not show it while isSuccess=false (the review/sign screen is shown)', async () => {
    const html = await render(props({ isSuccess: false }));
    expect(html).not.toContain('Signed in');
    expect(html).toContain('Sign In'); // the review screen is up
  });

  // Error path: the tick must not appear before the parent confirms delivery.
  it('does NOT show the tick mid-delivery (isProcessing, isSuccess still false)', async () => {
    const html = await render(props({ isProcessing: true, isSuccess: false }));
    expect(html).toContain('Signing in'); // the processing screen is up (guards against a trivial empty render)
    expect(html).not.toContain('Signed in');
  });

  it('does NOT show the tick after a failed delivery (parent leaves isSuccess false)', async () => {
    // A failed sign leaves the dialog back in the interactive state, never the tick.
    const html = await render(props({ isProcessing: false, isSuccess: false }));
    expect(html).not.toContain('Signed in');
    expect(html).toContain('Sign In');
  });
});

describe('SiweDialog — parse failure surfaced, not silent (blocker 3)', () => {
  it('shows the "couldn\'t read" notice for an unparseable message', async () => {
    expect(await render(props({ message: 'plain personal_sign, not SIWE' }))).toContain(
      "couldn't read the full sign-in request"
    );
  });
  it('does not show it for a well-formed SIWE message', async () => {
    const html = await render(props({ message: VALID_SIWE }));
    expect(html).toContain('Sign In'); // the review screen is up (guards against a trivial empty render)
    expect(html).not.toContain("couldn't read the full sign-in request");
  });
});

describe('SiweDialog — request code', () => {
  const withRequestId = (id: string) => VALID_SIWE + `\nRequest ID: ${id}`;
  /** The element showing the code, found by its label rather than anywhere in the raw message. */
  const codeShown = () =>
    [...document.querySelectorAll('span')].find((s) => s.textContent === 'Request code')?.nextElementSibling;

  it('shows the request id as a code to compare when the message carries one', async () => {
    const html = await render(props({ message: withRequestId('K7MXQ4') }));
    expect(codeShown()?.textContent).toBe('K7MXQ4');
    expect(codeShown()?.className).toContain('tracking-widest');
    expect(html).toContain('Check it matches the code on the page that sent you here.');
  });

  it('shows no request code for a sign-in without one', async () => {
    await render(props({ message: VALID_SIWE }));
    expect(codeShown()).toBeUndefined();
  });

  it('still shows a long request id, in smaller type', async () => {
    const id = 'req-0123456789abcdef0123456789abcdef';
    await render(props({ message: withRequestId(id) }));
    expect(codeShown()?.textContent).toBe(id);
    expect(codeShown()?.className).not.toContain('tracking-widest');
  });
});
