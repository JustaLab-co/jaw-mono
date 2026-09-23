import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { bytesToHex, createClient, custom, type Address, type Hex } from 'viem';
import { toWebAuthnAccount } from 'viem/account-abstraction';
import { base } from 'viem/chains';
import { toJustanAccount } from '@jaw.id/core';

import { RequestModals } from '../components/RequestModals';
import { SDKRequestType } from '../lib/sdk-types';
import type { PopupCommunicator } from '../lib/popup-communicator';

export const ACCOUNT: Address = '0x9fD37D2cF1b32b3f7dBae480bbd44BE3De2A9e0F';
export const CHAIN = { id: base.id, rpcUrl: 'https://rpc.corpus.test/?api-key=corpus' };
export const ORIGIN = 'https://app.example';

/**
 * A passkey that records the challenge it was asked to sign and then refuses,
 * the way a user cancelling the prompt does. Everything above it is real: the
 * keys modal, the @jaw.id/ui dialog, core's ERC-7739 wrapping, and viem/ox's
 * WebAuthn request. The account address is fixed, so no RPC is needed.
 */
export async function corpusAccount() {
  const passkey = { challenge: undefined as Hex | undefined };
  const owner = toWebAuthnAccount({
    credential: { id: 'corpus-credential', publicKey: `0x04${'11'.repeat(64)}` },
    getFn: async (options) => {
      passkey.challenge = bytesToHex(new Uint8Array(options?.publicKey?.challenge as ArrayBuffer));
      throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');
    },
  });
  const client = createClient({
    chain: base,
    transport: custom({
      request: async () => {
        throw new Error('the signing path must not reach the network');
      },
    }),
  });
  const smart = await toJustanAccount({ client, owners: [owner], address: ACCOUNT });
  // Mirrors Account.resolveSmartAccount: an override equal to the account, or none,
  // signs with it. Any other address would need an on-chain owner scan, so it fails
  // loudly instead of silently signing as the wrong account.
  const resolve = (options?: { address?: Address }) => {
    if (options?.address && options.address.toLowerCase() !== ACCOUNT.toLowerCase()) {
      throw new Error(`corpus harness cannot sign for ${options.address}`);
    }
    return smart;
  };
  const account = {
    signMessage: (message: string, options?: { address?: Address }) => resolve(options).signMessage({ message }),
    signTypedData: (typedData: Parameters<typeof smart.signTypedData>[0], options?: { address?: Address }) =>
      resolve(options).signTypedData(typedData),
  };
  return { account, passkey };
}

export type Decision = 'sign' | 'ack' | 'blocked';

export interface Rendered {
  /** Text a user sees without expanding or hovering anything. */
  visible: string;
  /** Text that appears only on hover: tooltip triggers and icon labels. */
  hovers: string;
  /** True when a label on screen sits in the same row as the value. */
  pair: (label: string, value: string) => boolean;
  /** Everything in the dialog, collapsed sections included. */
  all: string;
  decision: Decision;
  /** Checks the risk box when there is one, then presses the sign button. */
  sign: () => Promise<void>;
  rejection: () => { message: string; code?: number } | undefined;
}

let root: Root | null = null;

export async function renderRequest(method: string, params: unknown[]): Promise<Rendered> {
  let rejection: { message: string; code?: number } | undefined;
  const type =
    method === 'eth_signTypedData_v4' ||
    (method === 'wallet_sign' && (params[0] as { request?: { type?: string } })?.request?.type === '0x01')
      ? SDKRequestType.SIGN_TYPED_DATA
      : SDKRequestType.SIGN_MESSAGE;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const current = createRoot(container);
  root = current;
  await act(async () => {
    current.render(
      <RequestModals
        pendingRequest={{
          origin: ORIGIN,
          type,
          requestId: 'corpus',
          correlationId: 'corpus',
          metadata: { appName: 'Example', appLogoUrl: '' },
          method,
          params,
          chain: CHAIN,
          onApprove: async () => undefined,
          onReject: async (message, code) => {
            rejection = { message, code };
          },
        }}
        communicator={{ requestClose: () => undefined } as unknown as PopupCommunicator}
        apiKey="corpus"
        currentOrigin={ORIGIN}
        txData={null}
        setPhase={() => undefined}
        setError={() => undefined}
        scheduleClose={() => undefined}
        finishDeliveredFlow={() => undefined}
        closeDelayMs={0}
        signDelivered={false}
      />
    );
  });

  const signButton = [...document.querySelectorAll('button')].find((b) =>
    ['Sign', 'Sign In'].includes(b.textContent?.trim() ?? '')
  );
  const riskBox = document.querySelector<HTMLButtonElement>('button[role="checkbox"]');
  // 'ack' means the risk box is what holds the sign button back, not merely present.
  let decision: Decision = 'sign';
  if (!signButton || signButton.disabled) decision = riskBox ? 'ack' : 'blocked';

  const shown = visibleCopy();
  return {
    visible: shown.textContent ?? '',
    hovers: [...shown.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label')).join('\n'),
    // A label is a leaf element with exactly that text; its row is its parent.
    pair: (label, value) =>
      [...shown.querySelectorAll('*')].some(
        (el) => el.children.length === 0 && el.textContent === label && el.parentElement?.textContent?.includes(value)
      ),
    all: document.body.textContent ?? '',
    decision,
    sign: async () => {
      if (riskBox) await act(async () => riskBox.click());
      await act(async () => signButton?.click());
    },
    rejection: () => rejection,
  };
}

export async function cleanup() {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  document.body.innerHTML = '';
}

function visibleCopy(): HTMLElement {
  const copy = document.body.cloneNode(true) as HTMLElement;
  // A closed <details> shows only its summary.
  copy.querySelectorAll('details:not([open])').forEach((d) => {
    [...d.children].forEach((c) => c.tagName !== 'SUMMARY' && c.remove());
  });
  return copy;
}

/** The ERC-8213 digests the EIP-712 screen shows under "Digests data". */
export function shownDigests(all: string) {
  const read = (label: string) => new RegExp(`${label}\\D*?(0x[0-9a-f]{64})`).exec(all)?.[1] as Hex | undefined;
  return { domainHash: read('Domain Hash'), messageHash: read('Message Hash'), digest: read('EIP-712 Digest') };
}
