// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { maxUint160, maxUint256 } from 'viem';

vi.mock('../../hooks', () => ({ useChainIconURI: () => undefined, useFeeTokenPrice: () => undefined }));
// The calldata lookup, answered the way its raw decode shapes params: one per argument, in order.
vi.mock('../../hooks/useDecodedCalldata', async () => {
  const { decodeFunctionData, parseAbi, toFunctionSelector } = await import('viem');
  const abi = parseAbi([
    'function approve(address spender, uint256 amount)',
    'function increaseAllowance(address spender, uint256 addedValue)',
    'function increaseApproval(address spender, uint256 addedValue)',
    'function approveAndCall(address spender, uint256 amount)',
    'function approveAndCall(address spender, uint256 amount, bytes data)',
    'function setApprovalForAll(address operator, bool approved)',
    'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
    'function permit(address holder, address spender, uint256 nonce, uint256 expiry, bool allowed, uint8 v, bytes32 r, bytes32 s)',
    'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  ]);
  return {
    // A contract the lookup cannot read: no decode, however the calldata looks.
    useDecodedCalldata: (to: string, data?: string) => {
      if (to === '0x00000000000000000000000000000000000000aa')
        return { clearSigned: null, decoded: null, isLoading: false };
      const item = abi.find((i) => data?.startsWith(toFunctionSelector(i)));
      if (!item || !data) return { clearSigned: null, decoded: null, isLoading: false };
      const { functionName, args = [] } = decodeFunctionData({ abi: [item], data: data as `0x${string}` });
      const params = args.map((arg, i) => ({
        name: item.inputs[i].name ?? '',
        type: item.inputs[i].type,
        value: String(arg),
      }));
      return { clearSigned: null, decoded: { functionName, signature: functionName, params }, isLoading: false };
    },
  };
});
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { TransactionDialog } from './index';

const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SPENDER = '0x1111111111111111111111111111111111111111';
const approveMax = `0x095ea7b3${SPENDER.slice(2).padStart(64, '0')}${maxUint256.toString(16)}`;
const approve5 = `0x095ea7b3${SPENDER.slice(2).padStart(64, '0')}${(5_000_000).toString(16).padStart(64, '0')}`;
const setAll = `0xa22cb465${SPENDER.slice(2).padStart(64, '0')}${'1'.padStart(64, '0')}`;

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const OWNER = '0x2222222222222222222222222222222222222222';
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addr = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');
const sig = `${word(27n)}${word(1n)}${word(2n)}`;
const MAX = word(maxUint256);
// One call per allowance kind, each at its unlimited value. Selectors from the standard signatures.
// The last column is the flagged argument as its row reads: name, then type.
const KINDS: [string, { to: string; data: string }, string, string][] = [
  ['approve', { to: TOKEN, data: `0x095ea7b3${addr(SPENDER)}${MAX}` }, 'Unlimited', 'amountuint256'],
  ['increaseAllowance', { to: TOKEN, data: `0x39509351${addr(SPENDER)}${MAX}` }, 'Unlimited', 'addedValueuint256'],
  ['increaseApproval', { to: TOKEN, data: `0xd73dd623${addr(SPENDER)}${MAX}` }, 'Unlimited', 'addedValueuint256'],
  ['approveAndCall', { to: TOKEN, data: `0x3177029f${addr(SPENDER)}${MAX}` }, 'Unlimited', 'amountuint256'],
  [
    'approveAndCall with data',
    { to: TOKEN, data: `0xcae9ca51${addr(SPENDER)}${MAX}${word(96n)}${word(2n)}${'abcd'.padEnd(64, '0')}` },
    'Unlimited',
    'amountuint256',
  ],
  ['setApprovalForAll', { to: TOKEN, data: `0xa22cb465${addr(SPENDER)}${word(1n)}` }, 'All tokens', 'approvedbool'],
  [
    'EIP-2612 permit',
    { to: TOKEN, data: `0xd505accf${addr(OWNER)}${addr(SPENDER)}${MAX}${word(1_900_000_000n)}${sig}` },
    'Unlimited',
    'valueuint256',
  ],
  [
    'DAI permit',
    { to: TOKEN, data: `0x8fcbaf0c${addr(OWNER)}${addr(SPENDER)}${word(3n)}${word(1_900_000_000n)}${word(1n)}${sig}` },
    'Unlimited',
    'allowedbool',
  ],
  [
    'Permit2 approve',
    { to: PERMIT2, data: `0x87517c45${addr(TOKEN)}${addr(SPENDER)}${word(maxUint160)}${word(1_900_000_000n)}` },
    'Unlimited',
    'amountuint160',
  ],
];

// A balance change makes the single call's calldata start folded, behind the You send summary.
const USDC_OUT = {
  address: TOKEN.toLowerCase(),
  symbol: 'USDC',
  decimals: 6,
  diff: -1n,
  direction: 'out' as const,
  amountFormatted: '1',
  isNative: false,
};

const renderCalls = (calls: { to: string; data: string }[], withTransfer = true, folded = false) =>
  renderToStaticMarkup(
    <TransactionDialog
      open
      assetsOut={folded ? [USDC_OUT] : undefined}
      onOpenChange={() => undefined}
      transactions={[
        ...(withTransfer ? [{ to: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', value: '0x1', chainId: 84532 }] : []),
        ...calls.map((call) => ({ ...call, chainId: 84532 })),
      ]}
      walletAddress="0x71f2F1c2dc94cDaBFE29Cb355119f8683AE0969b"
      gasFee="0"
      gasFeeLoading={false}
      gasEstimationError=""
      sponsored
      onConfirm={async () => undefined}
      onCancel={() => undefined}
      isProcessing={false}
      networkName="Base Sepolia"
    />
  );

const render = (data: string[], withTransfer = true) =>
  renderCalls(
    data.map((d) => ({ to: TOKEN, data: d })),
    withTransfer
  );

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
/** Text of each call's header: the batch steps, or the single call's calldata card. */
const headers = (html: string) =>
  [...parse(html).querySelectorAll('[data-slot="accordion-trigger"]')].map((el) => el.textContent ?? '');
/** Text of the open calldata, or null when every call is folded. */
const openCalldata = (html: string) =>
  parse(html).querySelector('[data-slot="accordion-content"][data-state="open"]')?.textContent ?? null;

describe('TransactionDialog allowances', () => {
  it('has no separate approvals card', () => {
    expect(render([approveMax])).not.toContain('Token approvals');
  });

  it('flags an unlimited approve on its step in a batch', () => {
    expect(headers(render([approveMax]))).toEqual([
      expect.not.stringContaining('Unlimited'),
      expect.stringContaining('Unlimited'),
    ]);
  });

  it('flags a setApprovalForAll as access to all tokens', () => {
    expect(headers(render([setAll]))[1]).toContain('All tokens');
  });

  it('flags an unlimited approve sent as a single call', () => {
    expect(headers(render([approveMax], false))).toEqual([expect.stringContaining('Unlimited')]);
  });

  it.each(KINDS)('flags %s on its step header', (_, call, label) => {
    expect(headers(renderCalls([call]))[1]).toContain(label);
  });

  it.each(KINDS)('flags %s on the header of a folded single call', (_, call, label) => {
    const html = renderCalls([call], false, true);
    expect(openCalldata(html)).toBeNull();
    expect(headers(html)[0]).toContain(label);
  });

  it.each(KINDS)('flags %s in the calldata, on the argument that sets the allowance', (_, call, label, arg) => {
    const calldata = openCalldata(renderCalls([call], false)) ?? '';
    expect(calldata).toContain(`${arg}${label}`);
    expect(calldata.split(label).length - 1).toBe(1);
    expect(calldata).not.toContain(maxUint256.toString());
    expect(calldata).not.toContain(maxUint160.toString());
  });

  it('flags nothing on a call the lookup cannot read, even an unlimited approve', () => {
    const unreadable = { to: '0x00000000000000000000000000000000000000aa', data: approveMax };
    expect(renderCalls([unreadable])).not.toContain('Unlimited');
    expect(renderCalls([unreadable], false)).not.toContain('Unlimited');
  });

  it('flags nothing for a finite approve', () => {
    const html = render([approve5]);
    expect(html).not.toContain('Unlimited');
    expect(html).not.toContain('All tokens');
  });

  it('flags nothing when no call grants an allowance', () => {
    expect(render(['0x'])).not.toContain('Unlimited');
  });
});
