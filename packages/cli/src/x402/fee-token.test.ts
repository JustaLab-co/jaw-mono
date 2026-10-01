import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UsdcAsset } from './asset-registry.js';

/**
 * The registry is a hand mirror of the backend's own asset list, and nothing
 * compared the two. A session names the registry's USDC in the paymaster
 * context and sizes every gas figure in it, so the day the backend moves the
 * userOp fails at the paymaster and the error is about the paymaster.
 */

const capabilities = vi.fn();
vi.mock('@jaw.id/core', () => ({ handleGetCapabilitiesRequest: capabilities }));

const { whyFeeTokenDisagrees } = await import('./fee-token.js');

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ASSET: UsdcAsset = {
  address: USDC,
  chainId: 84532,
  wireNetwork: 'eip155:84532',
  usdcName: 'USDC',
  usdcVersion: '2',
  decimals: 6,
};

/** `84532` as the hex chain key the capabilities response is keyed on. */
const CHAIN_KEY = '0x14a34';

const answering = (feeToken: unknown) => capabilities.mockResolvedValue({ [CHAIN_KEY]: { feeToken } });
const token = (over: Record<string, unknown> = {}) => ({
  uid: 'usdc',
  symbol: 'USDC',
  address: USDC,
  decimals: 6,
  interop: false,
  feeToken: true,
  ...over,
});

// Block body on purpose: an arrow returning `mockReset()` hands vitest the mock
// function itself, which it takes for a teardown callback and calls after every
// test. With an implementation that throws, that throw lands in the teardown and
// fails a test whose assertion already passed.
beforeEach(() => {
  capabilities.mockReset();
});

describe('whyFeeTokenDisagrees', () => {
  it('says nothing when the paymaster takes the token the session names', async () => {
    answering({ supported: true, tokens: [token()] });
    expect(await whyFeeTokenDisagrees(ASSET, 'key')).toBeNull();
  });

  it('matches the address case-insensitively', async () => {
    answering({ supported: true, tokens: [token({ address: USDC.toUpperCase() })] });
    expect(await whyFeeTokenDisagrees(ASSET, 'key')).toBeNull();
  });

  it('reports the drift when the paymaster takes something else', async () => {
    answering({ supported: true, tokens: [token({ symbol: 'DAI', address: '0x' + '11'.repeat(20) })] });
    expect(await whyFeeTokenDisagrees(ASSET, 'key')).toMatch(/takes DAI on chain 84532/);
  });

  it('reports a chain the paymaster takes no ERC-20 on', async () => {
    answering({ supported: false, tokens: [] });
    expect(await whyFeeTokenDisagrees(ASSET, 'key')).toMatch(/lists no ERC-20 fee token/);
  });

  // A token listed but not as a fee token is not one the paymaster will charge in.
  it('ignores a token the wallet does not mark as a fee token', async () => {
    answering({ supported: true, tokens: [token({ feeToken: false })] });
    expect(await whyFeeTokenDisagrees(ASSET, 'key')).toMatch(/lists no ERC-20 fee token/);
  });

  // Every gas figure the session sizes is scaled by this, so a mismatch is not
  // cosmetic: it moves `gasReserve` and `firstOperationCost` by a factor of ten
  // per digit.
  it('reports a decimals disagreement', async () => {
    answering({ supported: true, tokens: [token({ decimals: 18 })] });
    expect(await whyFeeTokenDisagrees(ASSET, 'key')).toMatch(/18 decimals .* registry says 6/);
  });

  it('reports a chain the wallet says nothing about', async () => {
    capabilities.mockResolvedValue({});
    expect(await whyFeeTokenDisagrees(ASSET, 'key')).toMatch(/lists no ERC-20 fee token/);
  });

  // A proxy blip must not stop a payment: the fallback is what every session
  // before this check ran on.
  it('degrades to a warning when the capabilities call fails', async () => {
    // Thrown synchronously. A rejected promise from the mock is reported by
    // vitest as unhandled even though the code awaits it inside a try, which
    // fails the test on the path it is meant to prove works.
    capabilities.mockImplementation(() => {
      throw new Error('proxy down');
    });
    const warning = await whyFeeTokenDisagrees(ASSET, 'key');
    expect(warning).toMatch(/Could not check.*proxy down/);
  });
});

// This runs inside the payment lock, and core's `fetchRPCRequest` uses a bare
// `fetch`, which has no timeout in Node. Left unbounded it can stall a payment,
// and with the lock's heartbeat a stalled holder never reads as stale, so nothing
// would break the lock either. A check that only produces a warning must not be
// able to do that.
it('gives up on a capabilities call that never answers', async () => {
  capabilities.mockImplementation(() => new Promise(() => undefined));

  const warning = await whyFeeTokenDisagrees(ASSET, 'key');

  expect(warning).toMatch(/Could not check.*timed out/);
}, 10_000);
