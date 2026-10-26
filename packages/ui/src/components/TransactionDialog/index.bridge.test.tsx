// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { identityKey } from '../../utils';
import {
  ACROSS_CALLS,
  PROD_RELAY_DEPOSIT,
  RELAY_USDC_APPROVE,
  RELAY_USDC_DEPOSIT,
  SIGNER,
} from '../../utils/bridgeCalls/fixtures';
import type { BridgeCall } from '../../utils/bridgeCalls/view';
import type { AssetDelta } from '../../utils/assetPreview';
import { Accordion } from '../ui/accordion';

vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../../hooks/useChainIcons', () => ({ useChainIcons: () => ({}) }));
vi.mock('../../hooks/useDecodedCalldata', () => ({
  useDecodedCalldata: (_to: string, data?: string) => ({
    clearSigned: null,
    decoded: { functionName: data?.startsWith('0x095ea7b3') ? 'approve' : 'deposit', signature: '', params: [] },
    isLoading: false,
  }),
}));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../hooks/useAddressIdentities', () => {
  const identity = (address: string, chainId: number) => ({
    address,
    chainId,
    ensName: null,
    ensPlainName: null,
    ensAvatar: null,
    tokenName: null,
    tokenSymbol: null,
    tokenIcon: null,
    clearSigningName: null,
    clearSigningIcon: null,
    label: address,
  });
  return {
    useAddressIdentities: (inputs: { address: string; chainId: number }[]) =>
      Object.fromEntries(inputs.map((i) => [identityKey(i.address, i.chainId), identity(i.address, i.chainId)])),
    useAddressIdentity: (address: string | undefined, chainId: number | undefined) =>
      address && chainId ? identity(address, chainId) : null,
  };
});

import { TransactionDialog } from './index';
import { BridgeDetails } from './CallSections';

const OTHER = '0x1111111111111111111111111111111111111111';
const SPOKE_POOL = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64';
const PERIPHERY = '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RELAY_HIDDEN =
  'Relay keeps the destination chain and the recipient in an order outside this transaction. This screen cannot show them. Confirm only if you started this transfer yourself.';
const UNREADABLE = 'This screen cannot read this Across call. Check the raw details before you confirm.';

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const approve = (spender: string, amount = '989680'): BridgeCall => ({
  ...RELAY_USDC_APPROVE,
  data: '0x095ea7b3' + word(spender) + word(amount),
});

const depositAbi = parseAbi([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
]);
// usdcNofee is a plain SpokePool deposit to this account, so any argument can change and still read.
function nofeeWith(edit: (args: unknown[]) => void): BridgeCall {
  const call = ACROSS_CALLS.usdcNofee;
  const decoded = decodeFunctionData({ abi: depositAbi, data: call.data as Hex });
  const tail = call.data.slice(encodeFunctionData({ abi: depositAbi, ...decoded }).length);
  const args = [...decoded.args];
  edit(args);
  return { ...call, data: encodeFunctionData({ abi: depositAbi, functionName: 'deposit', args } as never) + tail };
}

type Extra = Partial<Parameters<typeof TransactionDialog>[0]>;
const render = (transactions: BridgeCall[], extra: Extra = {}) => {
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(
    <TransactionDialog
      open
      onOpenChange={() => undefined}
      transactions={transactions}
      walletAddress={SIGNER}
      gasFee="0"
      gasFeeLoading={false}
      gasEstimationError=""
      sponsored
      onConfirm={async () => undefined}
      onCancel={() => undefined}
      isProcessing={false}
      networkName="Base"
      mainnetRpcUrl=""
      {...extra}
    />
  );
  return root;
};

const title = (root: HTMLElement) => root.querySelector('h2')?.textContent;
const red = (root: HTMLElement) => [...root.querySelectorAll('.text-destructive')].map((e) => e.textContent);
const yellow = (root: HTMLElement) =>
  [...root.querySelectorAll('[role="alert"].bg-warning\\/10 p')].map((e) => e.textContent);
const column = (root: HTMLElement, heading: string) =>
  [...root.querySelectorAll('.text-heading')].find((e) => e.textContent === heading)?.closest('.rounded-box')
    ?.textContent ?? '';

describe('TransactionDialog with a bridge deposit', () => {
  it('shows the Across deposit in You send and You get, each asset on its chain, with the terms folded away', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod]);
    expect(title(root)).toBe('Bridge to Arbitrum');
    expect(column(root, 'You send')).toContain('USDC');
    expect(column(root, 'You send')).toContain('on Base');
    expect(column(root, 'You get')).toContain('≥ 9.9609');
    expect(column(root, 'You get')).toContain('via Across');
    expect(column(root, 'You get')).toContain('on Arbitrum');
    expect(root.textContent).toContain('Details');
    expect(root.textContent).not.toContain('to JAW');
    expect(red(root)).toEqual([]);
    expect(yellow(root)).toEqual([]);
    const stepTitles = [...root.querySelectorAll('button .text-value')].map((e) => e.textContent);
    expect(stepTitles).toEqual(['approve()', 'deposit()']);
  });

  it('prefers the simulated send over the decoded one when the simulation has it', () => {
    const simulated: AssetDelta = {
      address: BASE_USDC,
      symbol: 'USDC.sim',
      decimals: 6,
      diff: 10_000_000n,
      direction: 'out',
      amountFormatted: '10',
      isNative: false,
    };
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod], { assetsOut: [simulated] });
    expect(column(root, 'You send')).toContain('USDC.sim');
  });

  it('reads a swap on the origin as the token sent and the token bought on the other chain', () => {
    const root = render([approve(PERIPHERY), ACROSS_CALLS.usdcToWeth]);
    expect(column(root, 'You send')).toContain('USDC');
    expect(column(root, 'You get')).toContain('WETH');
    expect(column(root, 'You get')).toContain('≥ 0.0041');
  });

  it('cuts the minimum rather than rounding it up, so it never reads more than the deposit promises', () => {
    const root = render([ACROSS_CALLS.nativeEth]);
    expect(column(root, 'You get')).toContain('≥ 0.0099');
    expect(column(root, 'You get')).not.toContain('0.01');
  });

  it('names the token of a swap on the destination and says the swap sets its amount, in yellow', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.usdcToArb]);
    const swapNote = [...root.querySelectorAll('.text-warning')].find((e) =>
      e.textContent?.includes('Amount set by a swap on Arbitrum')
    );
    expect(swapNote).toBeDefined();
    expect(column(root, 'You get')).not.toContain('≥');
    expect(red(root)).toEqual([]);
  });

  it('flags a recipient that is not this account in yellow, never red', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.usdcOtherRecipient]);
    expect(yellow(root)).toEqual([`The recipient is not this account: ${OTHER}.`]);
    expect(red(root)).toEqual([]);
  });

  it('heads what arrives with the recipient when it is not this account, not "You get"', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.usdcOtherRecipient]);
    expect(root.textContent).not.toContain('You get');
    expect(column(root, '0x1111...1111 gets')).toContain('≥ 9.9902');
  });

  it('shows a minimum below 0.0001 with its first significant digits, never as 0', () => {
    const root = render([approve(SPOKE_POOL), nofeeWith((a) => (a[5] = 98_765n))]);
    expect(column(root, 'You get')).toContain('≥ 0.0987');
    const dust = render([approve(SPOKE_POOL), nofeeWith((a) => (a[5] = 9n))]);
    expect(column(dust, 'You get')).toContain('≥ 0.000009');
  });

  it('shows an unknown token sent in base units, since its decimals are unknown', () => {
    const unknown = `0x${'00'.repeat(12)}${'ab'.repeat(20)}`;
    const root = render([nofeeWith((a) => (a[2] = unknown))]);
    expect(column(root, 'You send')).toContain('−10000000 base units');
    expect(column(root, 'You send')).toContain('0xABaB...ABaB');
  });

  it('waits for the granter before reading the batch, so no notice is judged against the signer', () => {
    for (const extra of [{ onBehalfOfLoading: true }, { permissionProblem: 'lookup-failed' as const }]) {
      const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod], extra);
      expect(title(root)).not.toContain('Bridge');
      expect(root.textContent).not.toContain('You get');
    }
  });

  it('reads the batch as the account whose funds move under a permission', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod], { onBehalfOf: OTHER });
    expect(yellow(root)).toContain(`The recipient is not this account: ${SIGNER}.`);
  });

  it('marks a bridge call it cannot read in red, on the batch and on its step', () => {
    const broken = { ...ACROSS_CALLS.prod, data: ACROSS_CALLS.prod.data + '00' };
    const root = render([approve(SPOKE_POOL), broken]);
    expect(red(root)).toEqual([UNREADABLE, UNREADABLE]);
    expect(title(root)).not.toContain('Bridge');
    expect(root.textContent).not.toContain('You get');
  });

  it('shows a Relay deposit without its order as You send only, with the reason in yellow', () => {
    const root = render([RELAY_USDC_APPROVE, RELAY_USDC_DEPOSIT]);
    expect(title(root)).toBe('Deposit to Relay');
    expect(column(root, 'You send')).toContain('USDC');
    expect(root.textContent).not.toContain('You get');
    expect(yellow(root)).toEqual([RELAY_HIDDEN]);
  });

  it('leaves a native Relay deposit without chain badges, since only one chain is known', () => {
    const root = render([PROD_RELAY_DEPOSIT]);
    expect(column(root, 'You send')).toContain('ETH');
    expect(column(root, 'You send')).not.toContain('on Base');
  });

  it('keeps the bridge view when the simulation fails, under the simulation notice', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod], { assetPreviewError: true });
    expect(yellow(root)[0]).toContain('Could not simulate this transaction');
    expect(column(root, 'You get')).toContain('≥ 9.9609');
  });
});

describe('BridgeDetails', () => {
  it('lists each term with a copy button for addresses', () => {
    const html = renderToStaticMarkup(
      <Accordion type="single" defaultValue="details">
        <BridgeDetails
          details={[
            { label: 'Recipient', value: 'This account', copy: SIGNER },
            { label: 'Fee', value: '0.024964 USDC to JAW' },
          ]}
        />
      </Accordion>
    );
    const root = document.createElement('div');
    root.innerHTML = html;
    expect([...root.querySelectorAll('dt')].map((e) => e.textContent)).toEqual(['Recipient', 'Fee']);
    expect(root.querySelector('[aria-label="Copy recipient"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Copy fee"]')).toBeNull();
  });
});
