import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

import type { AddressIdentity } from '../../hooks/useAddressIdentities';
import { identityKey, type ReverseInput } from '../../utils/reverseResolve';

const CHECKER = '0x398b9d939E7E616E03eA99601c835C920621B2ca';

vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
// Every address resolves at once, except the checker: it is named on ENS by whoever deployed it,
// and its clear-signing lookup has not answered yet.
vi.mock('../../hooks/useAddressIdentities', () => ({
  useAddressIdentities: (inputs: readonly ReverseInput[]) =>
    Object.fromEntries(
      inputs.map((input) => {
        const isChecker = input.address.toLowerCase() === CHECKER.toLowerCase();
        const identity = {
          address: input.address,
          ensName: isChecker ? 'recipient-must-be-you.eth' : null,
          clearSigningName: null,
          loading: { ens: false, token: false, clearSigning: isChecker },
        } as unknown as AddressIdentity;
        return [identityKey(input.address, input.chainId), identity];
      })
    ),
}));

import { PermissionDialog } from './index';

const render = () =>
  renderToStaticMarkup(
    <PermissionDialog
      open
      onOpenChange={() => undefined}
      mode="grant"
      spenderAddress="0x2222222222222222222222222222222222222222"
      origin="https://dapp.example"
      calls={[
        {
          target: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          selector: '0xa9059cbb',
          functionSignature: 'transfer(address,uint256)',
          checker: CHECKER,
        },
      ]}
      expiryDate="11/19/2026"
      networkName="Base Sepolia"
      chainId={84532}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      isProcessing={false}
      gasFee="0.0001"
      sponsored
      mainnetRpcUrl="https://mainnet.example"
    />
  );

describe('the grant screen and a call checker', () => {
  // A deployer picks a checker's ENS name, so it is the checker describing itself; only the
  // clear-signing registry may name it.
  it('does not name the checker by the ENS name its deployer chose', () => {
    const html = render();

    expect(html).toContain('Checked by');
    expect(html).not.toContain('recipient-must-be-you.eth');
  });

  // The address is what gets signed and it is always shown; a name lookup that hangs must not
  // hold Confirm.
  it('does not wait on the checker name to enable Confirm', () => {
    const confirm = render().match(/<button[^>]*>[^<]*Grant[^<]*<\/button>/)?.[0] ?? '';

    expect(confirm).not.toBe('');
    expect(confirm).not.toContain('disabled=""');
  });
});
