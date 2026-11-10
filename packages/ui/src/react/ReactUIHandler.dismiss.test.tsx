// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { Account } from '@jaw.id/core';

import { ReactUIHandler } from './ReactUIHandler';

// The signature dialog is stubbed so the test can press sign through its props.
let signProps: { onSign?: () => Promise<void> } = {};
vi.mock('../components/SignatureDialog', () => ({
  SignatureDialog: (props: { onSign?: () => Promise<void> }) => {
    signProps = props;
    return null;
  },
}));

const CONNECT = { id: 'req-1', type: 'wallet_connect', data: { chainId: 1 } };
const SIGNATURE = '0x' + 'ab'.repeat(65);
const SIGN = {
  id: 'req-sign',
  type: 'personal_sign',
  data: { message: 'Hello', address: '0x1111111111111111111111111111111111111111', chainId: 1 },
};

describe('ReactUIHandler dismiss', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  });

  afterEach(async () => {
    await act(async () => undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    signProps = {};
  });

  it('closes an open dialog and rejects its request', async () => {
    const handler = new ReactUIHandler();
    let answer: Awaited<ReturnType<ReactUIHandler['request']>> | undefined;
    act(() => {
      void handler.request(CONNECT as Parameters<ReactUIHandler['request']>[0]).then((r) => (answer = r));
    });
    expect(document.querySelector('[data-jaw-modal-container]')).not.toBeNull();

    await act(async () => handler.dismiss());

    expect(document.querySelector('[data-jaw-modal-container]')).toBeNull();
    expect(answer).toMatchObject({ id: 'req-1', approved: false });
  });

  it('keeps a signed dialog up until its tick ends when dismissed during the hold', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    vi.spyOn(Account, 'get').mockResolvedValue({ signMessage: async () => SIGNATURE } as unknown as Account);
    const handler = new ReactUIHandler();
    handler.init({ apiKey: 'test-key', defaultChainId: 1 } as Parameters<ReactUIHandler['init']>[0]);
    let answer: Awaited<ReturnType<ReactUIHandler['request']>> | undefined;
    act(() => {
      void handler.request(SIGN as Parameters<ReactUIHandler['request']>[0]).then((r) => (answer = r));
    });
    expect(signProps.onSign).toBeDefined();

    vi.useFakeTimers();
    await act(async () => signProps.onSign?.());
    expect(answer).toMatchObject({ id: 'req-sign', approved: true, data: SIGNATURE });

    await act(async () => {
      vi.advanceTimersByTime(200);
      handler.dismiss();
    });
    expect(document.querySelector('[data-jaw-modal-container]')).not.toBeNull();
    expect(answer).toMatchObject({ approved: true, data: SIGNATURE });

    await act(async () => vi.advanceTimersByTime(650));
    expect(document.querySelector('[data-jaw-modal-container]')).toBeNull();
  });

  it('does nothing when no dialog is open', () => {
    expect(() => new ReactUIHandler().dismiss()).not.toThrow();
  });
});
