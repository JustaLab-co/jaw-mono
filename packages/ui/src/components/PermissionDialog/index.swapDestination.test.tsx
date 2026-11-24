import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

import type { CallPermission } from './types';

vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../hooks/useAddressIdentities', () => ({ useAddressIdentities: () => ({}) }));

import { PermissionDialog } from './index';

const WETH = '0x4200000000000000000000000000000000000006';
const APPROVE: CallPermission = {
  target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  functionSignature: 'approve(address,uint256)',
};
const SWAP: CallPermission = {
  target: '0x2626664c2603336E57B271c5C0b26F421741e481',
  functionSignature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
};

// Uniswap's SwapRouter02 on every chain but Base: the swap runs inside multicall(deadline, data).
const UNISWAP_SWAP: CallPermission = {
  target: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  functionSignature: 'multicall(uint256,bytes[])',
};

const render = (calls: CallPermission[]) =>
  renderToStaticMarkup(
    <PermissionDialog
      open
      onOpenChange={() => undefined}
      mode="grant"
      spenderAddress="0x2222222222222222222222222222222222222222"
      origin="https://dapp.example"
      calls={calls}
      swapDestination={WETH}
      expiryDate="11/19/2026"
      networkName="Base"
      chainId={8453}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      isProcessing={false}
      gasFee="0.0001"
      sponsored
      mainnetRpcUrl="https://mainnet.example"
    />
  );

describe('the grant screen and a swap destination', () => {
  it('names the swap token on a grant that lets the spender swap', () => {
    expect(render([APPROVE, SWAP])).toContain('Swaps only into WETH');
  });

  it('names the swap token on a grant whose only router entry is a Uniswap multicall', () => {
    const html = render([APPROVE, UNISWAP_SWAP]);

    expect(html).toContain('Swaps only into WETH');
    expect(html).not.toContain('Limits are enforced onchain.');
  });

  // Without a swap call the token restricts nothing, so naming it would describe a limit that is not there.
  it('leaves the swap token off a grant with no swap call', () => {
    const html = render([APPROVE]);

    expect(html).not.toContain('Swaps only into');
    expect(html).toContain('Limits are enforced onchain.');
  });

  it('does not let the onchain footer cover the swap token', () => {
    const html = render([APPROVE, SWAP]);

    expect(html).not.toContain('Limits are enforced onchain.');
    expect(html).toContain('the swap token is not');
  });
});
