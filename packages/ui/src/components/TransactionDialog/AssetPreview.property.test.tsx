// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { formatUnits, getAddress } from 'viem';

const prices = vi.hoisted(() => ({ fetch: vi.fn<(symbol: string) => Promise<number>>(async () => 1) }));
vi.mock('../../utils/tokenPrice', () => ({ fetchTokenPrice: prices.fetch }));

import { AssetPreview } from './AssetPreview';
import { mapAssetChanges } from '../../utils/assetPreview';

const hostileDecimals = fc.oneof(
  fc.constantFrom(undefined, 0, 6, 18, 36, 77, 255, 256, -1, 6.5, Number.NaN, Number.MAX_SAFE_INTEGER),
  fc.integer()
);
const address = fc
  .uint8Array({ minLength: 20, maxLength: 20 })
  .map((b) => getAddress(`0x${Buffer.from(b).toString('hex')}`));
const diff = fc.bigInt({ min: -(2n ** 256n), max: 2n ** 256n }).filter((d) => d !== 0n);

describe('a simulated token row on the signing screen', () => {
  it('is scaled by its decimals, or shown in base units with the note and no price', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await fc.assert(
      fc.asyncProperty(address, hostileDecimals, diff, async (token, decimals, d) => {
        const [delta] = mapAssetChanges([
          { token: { address: token, symbol: 'AAPL', decimals }, value: { pre: 0n, post: d, diff: d } },
        ]);
        const host = document.createElement('div');
        const root = createRoot(host);
        await act(async () =>
          root.render(
            <AssetPreview
              assetsOut={delta.direction === 'out' ? [delta] : []}
              assetsIn={delta.direction === 'in' ? [delta] : []}
              error={false}
              nativeSymbol="ETH"
            />
          )
        );
        await act(async () => undefined);
        const text = host.textContent ?? '';
        const magnitude = d < 0n ? -d : d;

        if (delta.baseUnits) {
          expect(delta.amountFormatted).toBe(magnitude.toString());
          expect(text).toContain(`${magnitude} base units`);
          expect(text).toContain('Could not read the decimals.');
          expect(text).not.toContain('$');
        } else {
          expect(delta.amountFormatted).toBe(formatUnits(magnitude, decimals as number));
          expect(text).not.toContain('base units');
        }
        act(() => root.unmount());
      }),
      { numRuns: 100 }
    );
  }, 30_000);
});
