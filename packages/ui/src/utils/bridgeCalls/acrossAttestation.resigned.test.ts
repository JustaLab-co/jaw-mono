import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { readAcrossAttestation } from './acrossAttestation';
import { ACROSS_ATTESTED_QUOTES, ACROSS_QUOTES_LIVE_AT, ACROSS_QUOTE_DEPOSITOR } from './acrossAttestation.fixtures';

const anvilFirstKey = vi.hoisted(() => '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const);
vi.mock('./contracts', async (original) => {
  const { privateKeyToAccount } = await import('viem/accounts');
  return {
    ...(await original<typeof import('./contracts')>()),
    PINNED_ACROSS_QUOTE_SIGNER: privateKeyToAccount(anvilFirstKey).address,
  };
});

const PINNED = privateKeyToAccount(anvilFirstKey);
const { erc20 } = ACROSS_ATTESTED_QUOTES;
const ACCOUNT = ACROSS_QUOTE_DEPOSITOR;
const OTHER_WORD = `0x${'2222222222222222222222222222222222222222'.padStart(64, '0')}`;

type Attestation = typeof erc20.attestation;
type Message = Attestation['typedData']['message'];

async function resigned(edit: (message: Message, attestation: Attestation) => void) {
  const attestation = structuredClone(erc20.attestation);
  edit(attestation.typedData.message, attestation);
  attestation.signature = await PINNED.signTypedData(
    attestation.typedData as Parameters<typeof PINNED.signTypedData>[0]
  );
  return { optional: true, attestation };
}

describe('given an Across quote signed again by the pinned key', () => {
  it('when nothing else changes, then it verifies', async () => {
    expect(
      await readAcrossAttestation(await resigned(() => undefined), erc20.calls, ACCOUNT, ACROSS_QUOTES_LIVE_AT)
    ).toMatchObject({
      minAmount: 9_910_089n,
    });
  });

  it.each<[string, (message: Message, attestation: Attestation) => void]>([
    ['the depositor is another account', (m) => (m.origin.depositor = OTHER_WORD)],
    ['the funding caller is another account', (m) => (m.funding.caller = OTHER_WORD)],
    ['the order id is not the one the store call carries', (m) => (m.orderId = `0x${'ab'.repeat(32)}`)],
    ['it was signed for another chain', (m, a) => (a.typedData.domain.chainId = 10)],
    ['an approval is signed for another chain', (m) => (m.funding.approvals[0].chainId = '10')],
    [
      'the steps are signed in another order',
      (m) => {
        m.funding.approvals[0].index = '1';
        m.funding.transactions[0].index = '0';
      },
    ],
    ['the recipient is wider than an address', (m) => (m.destination.recipient = `0x01${OTHER_WORD.slice(4)}`)],
    [
      'it pays out through a destination action',
      (m) =>
        (m.destination.actions = [
          {
            target: '0x2222222222222222222222222222222222222222',
            functionSignature: 'function go()',
            args: '0x',
            value: '0',
            allowFailure: false,
            substitutions: [],
          },
        ] as never),
    ],
    [
      'it needs a signed message',
      (m) => (m.funding.messages = [{ chainId: '8453', digest: `0x${'cd'.repeat(32)}`, index: '2' }] as never),
    ],
    ['the refund names a recipient but no token', (m) => (m.refundPolicy.recipient = OTHER_WORD)],
    [
      'the refund names a token but no recipient',
      (m) => (m.refundPolicy.tokens = [{ chainId: '8453', token: OTHER_WORD }] as never),
    ],
  ])('when %s, then it is not verified', async (_, edit) => {
    expect(await readAcrossAttestation(await resigned(edit), erc20.calls, ACCOUNT, ACROSS_QUOTES_LIVE_AT)).toBeNull();
  });
});
