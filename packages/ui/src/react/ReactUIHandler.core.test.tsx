// @vitest-environment jsdom
/**
 * ReactUIHandler against a real @jaw.id/core.
 *
 * The other handler tests hand it a UIRequest written by hand, so they pin
 * what the dialogs do with a shape, not whether core still produces it. Here
 * the request starts where a dapp starts, at `provider.request`, and travels
 * the real AppSpecific signer into the real handler. What is asserted is the
 * text the user reads: the message they sign and the phishing warning. A core
 * change that stops decoding a message, renames a field or reroutes a method
 * shows up as a dialog that says something else.
 *
 * Expected text comes from the request itself and from EIP-4361 (the SIWE
 * domain must be the requesting origin), never from a previous run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { JAW, Mode, type UIHandler, type UIRequest } from '@jaw.id/core';
import { stringToHex } from 'viem';

import { ReactUIHandler } from './ReactUIHandler';

const ALICE = '0x00000000000000000000000000000000000A11cE';
const TOKEN = '0xdead000000000000000000000000000000c0ffee';

function siwe(domain: string) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    ALICE,
    '',
    'Sign in.',
    '',
    `URI: https://${domain}`,
    'Version: 1',
    'Chain ID: 8453',
    'Nonce: abcdef123456',
    'Issued At: 2026-01-01T00:00:00.000Z',
  ].join('\n');
}

/**
 * The person signs in, the real handler renders everything else. Onboarding
 * needs a passkey ceremony, which is not what this file is about.
 */
function signedInHandler(): UIHandler {
  const dialogs = new ReactUIHandler();
  return {
    init: (config) => dialogs.init(config),
    request: async <T,>(request: UIRequest) => {
      if (request.type !== 'wallet_connect') return dialogs.request<T>(request);
      return { id: request.id, approved: true, data: { accounts: [{ address: ALICE }] } as T };
    },
  };
}

/** Sends a request from the dapp side and returns what the dialog shows. */
async function shown(method: string, params: unknown[]): Promise<string> {
  const { provider } = JAW.create({
    apiKey: 'test-api-key',
    defaultChainId: 8453,
    preference: { mode: Mode.AppSpecific, uiHandler: signedInHandler() },
  });
  await provider.request({ method: 'eth_requestAccounts' });

  // Settles only when the user acts, so it is left pending.
  await act(async () => {
    void provider.request({ method, params }).catch(() => undefined);
  });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull());
  return document.body.textContent ?? '';
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Chain icons and reverse ENS go to the network. Nothing here depends on
  // them, and a test must not.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  // jsdom has no matchMedia. A desktop viewport, so dialogs open as the card.
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(async () => {
  await act(async () => undefined);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('ReactUIHandler against a real core', () => {
  it('shows the text of a message wagmi sent hex-encoded', async () => {
    const text = await shown('personal_sign', [stringToHex('Transfer ownership to Bob'), ALICE]);

    expect(text).toContain('Transfer ownership to Bob');
    expect(text).not.toContain(stringToHex('Transfer ownership to Bob'));
  });

  describe('a sign-in for another domain', () => {
    const evil = siwe('evil.example');

    it.each([
      ['personal_sign', () => [stringToHex(evil), ALICE]],
      ['wallet_sign', () => [{ address: ALICE, request: { type: '0x45', data: { message: evil } } }]],
    ])('is flagged when it arrives as %s', async (method, params) => {
      const text = await shown(method, params());

      expect(text).toContain('evil.example');
      expect(text).toContain(window.location.host);
      expect(text).toContain('I accept the risk');
    });
  });

  it('does not flag a sign-in for the page it runs on', async () => {
    const text = await shown('personal_sign', [stringToHex(siwe(window.location.host)), ALICE]);

    expect(text).not.toContain('I accept the risk');
  });

  it('shows the contract and chain a typed-data signature is bound to', async () => {
    // Mainnet while the wallet sits on Base: the signature is valid where the
    // domain says, so that is the chain the user must see.
    const typedData = {
      domain: { name: 'Token', version: '1', chainId: 1, verifyingContract: TOKEN },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        Mail: [{ name: 'contents', type: 'string' }],
      },
      primaryType: 'Mail',
      message: { contents: 'hello' },
    };
    const text = await shown('eth_signTypedData_v4', [ALICE, JSON.stringify(typedData)]);

    // The address is shortened on screen; its head and tail are what a user
    // compares.
    expect(text).toContain('Verifying contract');
    expect(text.toLowerCase()).toContain(TOKEN.slice(0, 6));
    expect(text.toLowerCase()).toContain(TOKEN.slice(-4));
    expect(text).toContain('Ethereum · 1');
    expect(text).toContain('hello');
  });
});
