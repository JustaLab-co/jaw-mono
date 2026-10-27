import { describe, expect, it } from 'vitest';
import { extractTransactionData } from './tx-handler';

const CHAIN = { id: 421614, rpcUrl: 'https://arb-sepolia.test' };
const TO = '0x0987654321098765432109876543210987654321';
const FROM = '0x1234567890123456789012345678901234567890';

/**
 * The popup is the consumer for cross-platform mode, so it has to accept both
 * EIP-5792 request envelopes: v1.0 and the v2.0.0 that viem's sendCalls() —
 * and therefore wagmi — sends by default.
 */
describe('extractTransactionData / wallet_sendCalls envelopes', () => {
  it('accepts the viem v2.0.0 envelope', () => {
    const result = extractTransactionData(
      'wallet_sendCalls',
      [
        {
          atomicRequired: false,
          calls: [
            { to: TO, data: '0xdeadbeef', value: undefined },
            { to: TO, data: '0xcafe', value: '0x10f2c' },
          ],
          capabilities: undefined,
          chainId: '0x66eee', // 421614
          from: FROM,
          id: undefined,
          version: '2.0.0',
        },
      ],
      CHAIN
    );

    expect(result.chainId).toBe(421614);
    expect(result.atomicRequired).toBe(false);
    expect(result.from).toBe(FROM);
    expect(result.transactions).toEqual([
      { to: TO, data: '0xdeadbeef', value: '0', chainId: 421614 },
      { to: TO, data: '0xcafe', value: '0x10f2c', chainId: 421614 },
    ]);
  });

  it('accepts the v1.0 envelope', () => {
    const result = extractTransactionData(
      'wallet_sendCalls',
      [{ version: '1.0', from: FROM, chainId: '0x66eee', calls: [{ to: TO, data: '0xdeadbeef', value: '0x0' }] }],
      CHAIN
    );

    expect(result.chainId).toBe(421614);
    expect(result.transactions).toHaveLength(1);
  });

  it('falls back to the connected chain when the envelope omits chainId', () => {
    const result = extractTransactionData('wallet_sendCalls', [{ calls: [{ to: TO, data: '0x' }] }], CHAIN);
    expect(result.chainId).toBe(421614);
  });

  it('carries the paymasterService capability and permission id through', () => {
    const result = extractTransactionData(
      'wallet_sendCalls',
      [
        {
          version: '2.0.0',
          chainId: '0x66eee',
          calls: [{ to: TO, data: '0x' }],
          capabilities: {
            paymasterService: { url: 'https://paymaster.test', context: { sponsorshipPolicyId: 'sp_1' } },
            permissions: { id: '0xabc' },
          },
        },
      ],
      CHAIN
    );

    expect(result.paymasterUrl).toBe('https://paymaster.test');
    expect(result.paymasterContext).toEqual({ sponsorshipPolicyId: 'sp_1' });
    expect(result.permissionId).toBe('0xabc');
  });

  it('carries the capabilities through for the screen, so a Relay order reaches it', () => {
    const jawRelayOrder = { optional: true, orderData: { version: 'v1' } };
    const result = extractTransactionData(
      'wallet_sendCalls',
      [{ version: '2.0.0', chainId: '0x66eee', calls: [{ to: TO, data: '0x' }], capabilities: { jawRelayOrder } }],
      CHAIN
    );

    expect(result.capabilities).toEqual({ jawRelayOrder });
  });
});
