// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from 'viem';
import fc from 'fast-check';
import { identityKey } from '../../utils';
import {
  ACROSS_CALLS,
  PROD_RELAY_DEPOSIT,
  RELAY_USDC_APPROVE,
  RELAY_USDC_DEPOSIT,
  RELAY_USDC_ORDER,
  SIGNER,
} from '../../utils/bridgeCalls/fixtures';
import type { BridgeCall } from '../../utils/bridgeCalls/view';
import type { AssetDelta } from '../../utils/assetPreview';
import { Accordion } from '../ui/accordion';

const table = vi.hoisted(() => ({ settled: true }));
vi.mock('../../hooks/useBridgeContracts', async (original) => {
  const real = await original<typeof import('../../hooks/useBridgeContracts')>();
  return {
    ...real,
    useBridgeContracts: (apiKey?: string) => ({ ...real.useBridgeContracts(apiKey), settled: table.settled }),
  };
});
// The chain side of the screen: a node that knows the tokens it is told about and nothing else.
const chain = vi.hoisted(() => ({
  tokens: {} as Record<string, { symbol: string; decimals: bigint }>,
  hang: false,
}));
vi.mock('../../utils/publicClient', async (original) => {
  const real = await original<typeof import('../../utils/publicClient')>();
  const { createPublicClient, custom, encodeAbiParameters } = await import('viem');
  const client = createPublicClient({
    transport: custom(
      {
        async request({ params }) {
          if (chain.hang) return new Promise(() => undefined);
          const { to, data } = (params as [{ to: string; data: string }])[0];
          const token = chain.tokens[to.toLowerCase()];
          if (!token) return '0x';
          return data === '0x95d89b41'
            ? encodeAbiParameters([{ type: 'string' }], [token.symbol])
            : encodeAbiParameters([{ type: 'uint256' }], [token.decimals]);
        },
      },
      { retryCount: 0 }
    ),
  });
  return { ...real, getJawPublicClient: () => client };
});
vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
vi.mock('../../utils/tokenPrice', () => ({ fetchTokenPrice: async (s: string) => ({ USDC: 1, WETH: 3000 })[s] ?? 0 }));
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
const UNREADABLE = 'Cannot read the Across call in step 2. Check its raw details before you confirm.';

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

// Unmounted after each test, so no pending render outlives the jsdom environment.
const live: Root[] = [];
afterEach(() => act(() => live.splice(0).forEach((root) => root.unmount())));

// Prices arrive in an effect, which static markup never runs.
const renderLive = async (transactions: BridgeCall[], extra: Extra = {}) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = document.createElement('div');
  const react = createRoot(root);
  live.push(react);
  await act(async () => {
    react.render(
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
  });
  return root;
};

const title = (root: HTMLElement) => root.querySelector('h2')?.textContent;
const red = (root: HTMLElement) => [...root.querySelectorAll('p.text-destructive')].map((e) => e.textContent);
const yellow = (root: HTMLElement) =>
  [...root.querySelectorAll('[role="alert"].bg-warning\\/10 p, [role="alert"] > p')].map((e) => e.textContent);
const notice = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('[role="alert"] > p')].find((e) => e.textContent === text);
// Throws without a header, so a "no icon" assertion cannot pass on a missing one.
const headerIcons = (root: HTMLElement) => {
  const header = root.querySelector('h2')?.parentElement;
  if (!header) throw new Error('no dialog header');
  return [...header.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label')?.startsWith('Cannot read'));
};
// Page text a sighted reader sees: the screen reader line is cut out.
const visibleText = (root: HTMLElement) => {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.sr-only').forEach((e) => e.remove());
  return copy.textContent ?? '';
};
const before = (first?: Element | null, second?: Element | null) =>
  !!first && !!second && !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
const box = (root: HTMLElement, heading: string) =>
  [...root.querySelectorAll('.text-heading')].find((e) => e.textContent === heading)?.closest('.rounded-box');
const column = (root: HTMLElement, heading: string) =>
  [...root.querySelectorAll('.text-heading')].find((e) => e.textContent === heading)?.closest('.rounded-box')
    ?.textContent ?? '';

describe('TransactionDialog with a bridge deposit', () => {
  it('shows the Across deposit in You send and You get, each asset on its chain, with the terms folded away', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod]);
    expect(title(root)).toBe('Bridge to Arbitrum');
    expect(column(root, 'You send')).toContain('USDC');
    expect(column(root, 'You send')).toContain('on Base');
    expect(column(root, 'You get via Across')).toContain('≥ 9.9609');
    expect(column(root, 'You get via Across')).toContain('on Arbitrum');
    expect(root.textContent).toContain('Details');
    expect(root.textContent).not.toContain('to JAW');
    expect(red(root)).toEqual([]);
    expect(yellow(root)).toEqual([]);
    const stepTitles = [...root.querySelectorAll('button .text-value')].map((e) => e.textContent);
    expect(stepTitles).toEqual(['approve()', 'deposit()']);
  });

  it('lays You get out like You send: token address, amount, chain and a USD value', async () => {
    const root = await renderLive([approve(SPOKE_POOL), ACROSS_CALLS.prod]);
    const get = column(root, 'You get via Across');
    expect(get).toContain('0xaf88...5831');
    expect(get).toContain('≥ 9.9609');
    expect(get).toContain('$9.96');
    expect(column(root, 'You send')).toContain('$10.00');
  });

  it('prices the token bought on the other chain by its own symbol', async () => {
    const root = await renderLive([approve(PERIPHERY), ACROSS_CALLS.usdcToWeth]);
    expect(column(root, 'You get via Across')).toMatch(/≥ 0\.0041.*\$1\d\.\d\d/);
  });

  it('keeps simulated incoming tokens out of the receive column', () => {
    const usdt: AssetDelta = {
      address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
      symbol: 'USDT',
      decimals: 6,
      diff: 5_000_000n,
      direction: 'in',
      amountFormatted: '5',
      isNative: false,
    };
    const own = render([approve(SPOKE_POOL), ACROSS_CALLS.prod], { assetsIn: [usdt] });
    expect(column(own, 'You get via Across')).not.toContain('USDT');
    expect(column(own, 'You get via Across')).toContain('≥ 9.9609');
    const other = render([approve(SPOKE_POOL), ACROSS_CALLS.usdcOtherRecipient], { assetsIn: [usdt] });
    expect(other.textContent).not.toContain('USDT');
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
    expect(column(root, 'You get via Across')).toContain('WETH');
    expect(column(root, 'You get via Across')).toContain('≥ 0.0041');
  });

  it('cuts the minimum rather than rounding it up, so it never reads more than the deposit promises', () => {
    const root = render([ACROSS_CALLS.nativeEth]);
    expect(column(root, 'You get via Across')).toContain('≥ 0.0099');
    expect(column(root, 'You get via Across')).not.toContain('0.01');
  });

  it('names the token of a swap on the destination and the least of it the router floor promises', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.usdcToArb]);
    expect(column(root, 'You get via Across')).toContain('0x912C...6548');
    expect(column(root, 'You get via Across')).toContain('≥ 52534325335448453260 base units');
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
    expect(column(root, 'They get via Across')).toContain('≥ 9.9902');
  });

  it('shows a minimum below 0.0001 with its first significant digits, never as 0', () => {
    const root = render([approve(SPOKE_POOL), nofeeWith((a) => (a[5] = 98_765n))]);
    expect(column(root, 'You get via Across')).toContain('≥ 0.0987');
    const dust = render([approve(SPOKE_POOL), nofeeWith((a) => (a[5] = 9n))]);
    // The row writes 0.000009 as 0.0₅9, the subscript counting the zeros, as every other screen does.
    expect(column(dust, 'You get via Across')).toContain('≥ 0.059');
    expect(column(dust, 'You get via Across')).not.toContain('≥ 0 ');
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

  it('marks a bridge call it cannot read with a header icon and a mark on its step, and no text line', () => {
    const broken = { ...ACROSS_CALLS.prod, data: ACROSS_CALLS.prod.data + '00' };
    const root = render([approve(SPOKE_POOL), broken]);
    expect(red(root)).toEqual([]);
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(headerIcons(root).map((e) => e.getAttribute('aria-label'))).toEqual([UNREADABLE]);
    const steps = [...root.querySelectorAll('[data-slot="accordion-item"]')];
    expect(steps).toHaveLength(2);
    expect(steps.some((step) => step.textContent?.includes('Cannot read'))).toBe(false);
    expect(steps[1].querySelector('[aria-label="Unreadable call"]')).not.toBeNull();
    expect(steps[0].querySelector('[aria-label="Unreadable call"]')).toBeNull();
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

  it('shows a Relay deposit with its order like an Across one: the minimum via Relay on the other chain', () => {
    const capabilities = { jawRelayOrder: { optional: true, orderData: RELAY_USDC_ORDER } };
    const root = render([RELAY_USDC_APPROVE, RELAY_USDC_DEPOSIT], { capabilities });
    expect(title(root)).toBe('Bridge to Arbitrum');
    expect(column(root, 'You get via Relay')).toContain('≥ 9.7764');
    expect(column(root, 'You get via Relay')).toContain('on Arbitrum');
    expect(yellow(root)).toEqual([]);
    expect(red(root)).toEqual([]);
  });

  it('says why a Relay order is not shown when it does not match the deposit, in yellow', () => {
    const orderData = { ...RELAY_USDC_ORDER, salt: '0x1' };
    const root = render([RELAY_USDC_APPROVE, RELAY_USDC_DEPOSIT], {
      capabilities: { jawRelayOrder: { optional: true, orderData } },
    });
    expect(yellow(root)).toEqual([
      'The Relay order details do not match this deposit, so this screen does not show them.',
      RELAY_HIDDEN,
    ]);
    expect(root.textContent).not.toContain('You get');
  });

  it('leaves a native Relay deposit without chain badges, since only one chain is known', () => {
    const root = render([PROD_RELAY_DEPOSIT]);
    expect(column(root, 'You send')).toContain('ETH');
    expect(column(root, 'You send')).not.toContain('on Base');
  });

  it('keeps the bridge view when the simulation fails, under the simulation notice', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod], { assetPreviewError: true });
    expect(yellow(root)[0]).toContain('Could not simulate this transaction');
    expect(column(root, 'You get via Across')).toContain('≥ 9.9609');
  });
});

describe('TransactionDialog notices around a bridge deposit', () => {
  const ATTACKER = '0x2222222222222222222222222222222222222222';
  const USDBC = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';
  const APPROVE_UNKNOWN =
    'This batch approves a token this screen does not know. Check its address before you confirm.';
  const OUTSIDE = `Step 3 calls ${ATTACKER} outside the bridge. Check it before you confirm.`;
  const extraCall: BridgeCall = { chainId: 8453, to: ATTACKER, data: '0x12345678' };

  it('shows a notice at once, with no click, in a small alert line with a warning icon', () => {
    const root = render([RELAY_USDC_APPROVE, RELAY_USDC_DEPOSIT]);
    const line = notice(root, RELAY_HIDDEN);
    expect(line?.closest('[role="alert"]')).not.toBeNull();
    expect(line?.className).toContain('text-body-sm');
    expect(line?.className).toContain('border-warning');
    expect(line?.querySelector('svg')).not.toBeNull();
    expect(root.querySelector('[data-slot="accordion-item"].bg-warning\\/10')).toBeNull();
    expect(root.querySelector('[role="alert"].bg-warning\\/10')).toBeNull();
  });

  it('shows RELAY_HIDDEN and the pairing notices together, none folded', () => {
    const root = render([approve(SPOKE_POOL), RELAY_USDC_DEPOSIT]);
    expect(yellow(root)).toEqual([RELAY_HIDDEN, 'This approval is for a different contract than the deposit.']);
  });

  it('names a call outside the bridge next to a clean looking deposit', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod, extraCall]);
    expect(title(root)).toBe('Bridge to Arbitrum');
    expect(yellow(root)).toEqual([OUTSIDE]);
    expect(red(root)).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['0x', '0x'],
    ['too short', '0x1234'],
  ])('says a step with a `to` that is %s cannot be read, without breaking the dialog', (_, to) => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod, { chainId: 8453, to, data: '0x12345678' }]);
    expect(yellow(root)).toEqual([
      'Step 3 does not call an address this screen can read. Check it before you confirm.',
    ]);
  });

  it('puts the send and receive columns before the notices', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod, extraCall]);
    const line = notice(root, OUTSIDE);
    expect(before(box(root, 'You send'), line)).toBe(true);
    expect(before(box(root, 'You get via Across'), line)).toBe(true);
  });

  it('keeps the header icon above You send', () => {
    const broken = { ...ACROSS_CALLS.prod, data: ACROSS_CALLS.prod.data + '00' };
    const root = render([approve(SPOKE_POOL), broken, RELAY_USDC_DEPOSIT]);
    expect(before(headerIcons(root)[0], box(root, 'You send'))).toBe(true);
  });

  it('keeps the header icon when a readable deposit sits beside an approve it cannot read', () => {
    const odd = { ...RELAY_USDC_APPROVE, data: RELAY_USDC_APPROVE.data + '00' };
    const root = render([odd, RELAY_USDC_DEPOSIT]);
    expect(title(root)).toBe('Deposit to Relay');
    expect(headerIcons(root).map((e) => e.getAttribute('aria-label'))).toEqual([
      'Cannot read the Relay call in step 1. Check its raw details before you confirm.',
    ]);
    expect(red(root)).toEqual([]);
  });

  it('shows the deposit count when there is no single transfer to show', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod, ACROSS_CALLS.prod]);
    expect(root.textContent).not.toContain('You get');
    expect(yellow(root)).toEqual(['This batch has 2 bridge deposits. Check each step before you confirm.']);
  });

  it('shows the notice for an approve of an unknown token with no deposit', () => {
    const root = render([{ ...approve(SPOKE_POOL), to: USDBC }]);
    expect(yellow(root)).toContain(APPROVE_UNKNOWN);
  });

  it('shows an unpaired approve notice in view', () => {
    const root = render([ACROSS_CALLS.prod, approve(SPOKE_POOL)]);
    expect(yellow(root)).toEqual([
      'This batch has an approval that the deposit does not use. Check its token, amount and spender.',
    ]);
  });

  it('leaves a transaction that is not a bridge call without bridge notices', () => {
    const root = render([approve(OTHER)], { assetPreviewError: true });
    expect(root.querySelector('[role="alert"] > p')).toBeNull();
    expect(yellow(root)).toHaveLength(1);
    expect(yellow(root)[0]).toContain('Could not simulate this transaction');
  });
});

describe('TransactionDialog with a destination swap that pays the JAW fee', () => {
  it.each([
    ['Uniswap', ACROSS_CALLS.usdcToNvdaFee, '≥ 12801829359864708 base units'],
    ['LiFi', ACROSS_CALLS.usdcToNvdaLifiFee, '≥ 431045955026407396 base units'],
  ])('reads as a bridge to Robinhood Chain through %s', (_, call, receive) => {
    const root = render([approve(SPOKE_POOL), call]);
    expect(title(root)).toBe('Bridge to Robinhood Chain');
    expect(column(root, 'They get via Across')).toContain(receive);
    expect(root.textContent).not.toContain(UNREADABLE);
    expect(red(root)).toEqual([]);
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

describe('TransactionDialog while the bridge table settles', () => {
  const confirm = (root: HTMLElement) =>
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Confirm');

  it.each([
    [false, true],
    [true, false],
  ])('when the table settled is %s, then Confirm disabled is %s', async (settled, disabled) => {
    table.settled = settled;
    const root = await renderLive([approve(SPOKE_POOL), ACROSS_CALLS.prod]);
    table.settled = true;
    expect(confirm(root)?.disabled).toBe(disabled);
  });
});

describe('TransactionDialog with a bridge into a token outside the table', () => {
  const BOUGHT = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
  const confirm = (root: HTMLElement) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Confirm') as HTMLButtonElement;
  const batch = [approve(SPOKE_POOL), ACROSS_CALLS.usdcToNvdaFee];

  afterEach(() => {
    chain.tokens = {};
    chain.hang = false;
  });

  it('shows the amount in the token units, warns, and leaves Confirm enabled', async () => {
    chain.tokens[BOUGHT] = { symbol: 'AAPL', decimals: 18n };
    const root = await renderLive(batch);
    const get = column(root, 'They get via Across');
    expect(get).toContain('AAPL');
    expect(get).not.toContain('unverified');
    expect(get).toMatch(/≥ 0\.0128/);
    expect(root.textContent).not.toContain('base units');
    await open(root);
    expect(root.textContent).toContain('This screen has not verified the token AAPL (0xd060...9EEC).');
    expect(confirm(root).disabled).toBe(false);
  });

  it('keeps Confirm disabled until the token answers', async () => {
    chain.hang = true;
    const root = await renderLive(batch);
    expect(confirm(root).disabled).toBe(true);
    expect(column(root, 'They get via Across')).toContain('base units');
  });

  it('when the token cannot be read, then it reads in base units and Confirm is enabled', async () => {
    const root = await renderLive(batch);
    expect(column(root, 'They get via Across')).toContain('≥ 12801829359864708 base units');
    expect(root.textContent).not.toContain('unverified');
    expect(confirm(root).disabled).toBe(false);
  });
});

describe('TransactionDialog with bridge calls it cannot read', () => {
  const ATTACKER = '0x2222222222222222222222222222222222222222';
  const ACROSS_1 = 'Cannot read the Across call in step 1. Check its raw details before you confirm.';
  const ACROSS_2 = 'Cannot read the Across call in step 2. Check its raw details before you confirm.';
  const ACROSS_3 = 'Cannot read the Across call in step 3. Check its raw details before you confirm.';
  const ACROSS_ONE_TWO = 'Cannot read the Across calls in steps 1 and 2. Check their raw details before you confirm.';
  const RELAY_THREE_FOUR = 'Cannot read the Relay calls in steps 3 and 4. Check their raw details before you confirm.';
  const ACROSS_ALL =
    'Cannot read the Across calls in steps 1, 2, 3, 4, 5, 6, 7 and 8. Check their raw details before you confirm.';
  const ACROSS_ONLY = 'Cannot read this Across call. Check its raw details before you confirm.';
  const tail = (call: BridgeCall): BridgeCall => ({ ...call, data: call.data + '00' });
  const paid = (call: BridgeCall): BridgeCall => ({ ...call, value: '1' });

  const steps = (root: HTMLElement) =>
    [...root.querySelectorAll('[data-slot="accordion-item"]')].filter(
      (item) => item.querySelector('button')?.textContent !== 'Details'
    );
  const labels = (root: HTMLElement) => headerIcons(root).map((e) => e.getAttribute('aria-label'));
  const marked = (step: Element) => step.querySelector('[aria-label="Unreadable call"]') !== null;

  it('given a readable deposit and an approve that sends USDC to an attacker, then it is a yellow outside-call notice and no red line', () => {
    const root = render([{ ...approve(ATTACKER), to: BASE_USDC }, ACROSS_CALLS.prod]);
    expect(yellow(root)).toContain(`Step 1 approves ${ATTACKER} to spend USDC. Check it before you confirm.`);
    expect(headerIcons(root)).toHaveLength(0);
  });

  it('given a readable deposit and an Across approve it cannot read, then a header icon and only that step is marked', () => {
    const root = render([paid(approve(SPOKE_POOL)), ACROSS_CALLS.prod]);
    expect(labels(root)).toEqual([ACROSS_1]);
    expect(steps(root).map(marked)).toEqual([true, false]);
  });

  it('given a readable approve and a deposit it cannot read, then the deposit step carries the mark', () => {
    const root = render([approve(SPOKE_POOL), tail(ACROSS_CALLS.prod)]);
    expect(labels(root)).toEqual([ACROSS_2]);
    expect(steps(root).map(marked)).toEqual([false, true]);
  });

  it('given both providers unreadable on two steps each, then one header icon explaining both', () => {
    const root = render([
      paid(approve(SPOKE_POOL)),
      tail(ACROSS_CALLS.prod),
      paid(RELAY_USDC_APPROVE),
      tail(RELAY_USDC_DEPOSIT),
    ]);
    expect(labels(root)).toEqual([`${ACROSS_ONE_TWO} ${RELAY_THREE_FOUR}`]);
    expect(steps(root).map(marked)).toEqual([true, true, true, true]);
  });

  it('given eight unreadable Across steps, then still one header icon', () => {
    const root = render(Array.from({ length: 8 }, () => tail(ACROSS_CALLS.prod)));
    expect(labels(root)).toEqual([ACROSS_ALL]);
    expect(steps(root).filter(marked)).toHaveLength(8);
  });

  it('given a readable transfer and a later step it cannot read, then the summary shows with the icon above it', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod, tail(ACROSS_CALLS.prod)]);
    expect(labels(root)).toEqual([ACROSS_3]);
    expect(before(headerIcons(root)[0], box(root, 'You send'))).toBe(true);
    expect(steps(root).map(marked)).toEqual([false, false, true]);
  });

  it('given an unreadable call beside notices, then both show and no text line carries the unreadable call', () => {
    const extra: BridgeCall = { chainId: 8453, to: ATTACKER, data: '0x12345678' };
    const root = render([approve(SPOKE_POOL), tail(ACROSS_CALLS.prod), RELAY_USDC_DEPOSIT, extra]);
    expect(notice(root, `Step 4 calls ${ATTACKER} outside the bridge. Check it before you confirm.`)).toBeDefined();
    expect(labels(root)).toHaveLength(1);
    expect(visibleText(root)).not.toContain('Cannot read');
  });

  it('given a single call it cannot read, then the header icon and its calldata card mark show', () => {
    const root = render([tail(ACROSS_CALLS.prod)]);
    expect(labels(root)).toEqual([ACROSS_ONLY]);
    expect(steps(root).map(marked)).toEqual([true]);
  });

  it('given a single readable call, then there is no icon and no alert', () => {
    const root = render([approve(SPOKE_POOL)]);
    expect(steps(root).map(marked)).toEqual([false]);
    expect(headerIcons(root)).toHaveLength(0);
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('given a readable bridge batch, then no icon renders', () => {
    const root = render([approve(SPOKE_POOL), ACROSS_CALLS.prod]);
    expect(headerIcons(root)).toHaveLength(0);
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders no red text line, and the header icon is a labelled button', () => {
    const root = render([approve(SPOKE_POOL), tail(ACROSS_CALLS.prod)]);
    expect(root.querySelector('p.text-destructive')).toBeNull();
    expect(visibleText(root)).not.toContain('Cannot read');
    const [icon] = headerIcons(root);
    expect(icon.tagName.toLowerCase()).toBe('button');
    expect(icon.querySelector('svg')).not.toBeNull();
    expect(icon.getAttribute('aria-label')).toBe(ACROSS_2);
    const mark = steps(root)[1].querySelector('[aria-label="Unreadable call"]');
    expect(mark?.tagName.toLowerCase()).toBe('svg');
    expect(mark?.getAttribute('role')).toBe('img');
    expect(mark?.closest('button')).not.toBeNull();
  });

  it('opens a popover with the explanation when the header icon is clicked', async () => {
    const root = await renderLive([approve(SPOKE_POOL), tail(ACROSS_CALLS.prod)]);
    const [icon] = headerIcons(root);
    await act(async () => {
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const popover = document.querySelector('[data-slot="popover-content"]');
    expect(popover?.textContent).toBe(icon.getAttribute('aria-label'));
    expect(popover?.textContent).toContain('step 2');
    expect(popover?.closest('[role="dialog"]')).not.toBeNull();
  });

  it('announces the unreadable state to screen readers without showing it', () => {
    const root = render([
      paid(approve(SPOKE_POOL)),
      tail(ACROSS_CALLS.prod),
      paid(RELAY_USDC_APPROVE),
      tail(RELAY_USDC_DEPOSIT),
    ]);
    const status = root.querySelector('[role="status"]');
    expect(status?.classList.contains('sr-only')).toBe(true);
    expect(status?.textContent).toBe(`${ACROSS_ONE_TWO} ${RELAY_THREE_FOUR}`);
    expect(render([approve(SPOKE_POOL), ACROSS_CALLS.prod]).querySelector('[role="status"]')).toBeNull();
  });

  type Kind = { call: BridgeCall; unreadable?: 'across' | 'relay' };
  const KINDS: Kind[] = [
    { call: approve(SPOKE_POOL) },
    { call: paid(approve(SPOKE_POOL)), unreadable: 'across' },
    { call: ACROSS_CALLS.prod },
    { call: tail(ACROSS_CALLS.prod), unreadable: 'across' },
    { call: RELAY_USDC_APPROVE },
    { call: paid(RELAY_USDC_APPROVE), unreadable: 'relay' },
    { call: RELAY_USDC_DEPOSIT },
    { call: tail(RELAY_USDC_DEPOSIT), unreadable: 'relay' },
    { call: { chainId: 8453, to: ATTACKER, data: '0x12345678' } },
  ];

  it('for any batch, one header icon when any step is unreadable, and a mark on exactly the unreadable steps', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...KINDS), { minLength: 1, maxLength: 6 }), (batch) => {
        const root = render(batch.map((kind) => kind.call));
        expect(headerIcons(root)).toHaveLength(batch.some((kind) => kind.unreadable) ? 1 : 0);
        expect(steps(root).map(marked)).toEqual(batch.map((kind) => !!kind.unreadable));
      }),
      { numRuns: 60 }
    );
  }, 30_000);
});
