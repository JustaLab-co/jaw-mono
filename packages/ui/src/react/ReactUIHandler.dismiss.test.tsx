// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

import { ReactUIHandler } from './ReactUIHandler';

const CONNECT = { id: 'req-1', type: 'wallet_connect', data: { chainId: 1 } };

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
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
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

  it('does nothing when no dialog is open', () => {
    expect(() => new ReactUIHandler().dismiss()).not.toThrow();
  });
});
