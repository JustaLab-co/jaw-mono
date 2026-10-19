import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  parseAbi,
  type Hex,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { setTestEnv } from '@/connections/testkit';
import { readContracts, type Read } from './read-contracts';

setTestEnv();

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EOA = '0x1111111111111111111111111111111111111111';
const HOLDER = '0x2222222222222222222222222222222222222222';

const multicall = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) returns ((bool success, bytes returnData)[])',
]);

// A node that answers Multicall3 by running `answer` on each inner call; null means that call reverts.
function node(answer: (target: string, data: Hex) => Hex | null) {
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === 'eth_chainId') return '0x2105';
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const { data } = (params as [{ data: Hex }])[0];
    const { args } = decodeFunctionData({ abi: multicall, data });
    const returnData = args[0].map((c) => {
      const out = answer(c.target, c.callData);
      return out ? { success: true, returnData: out } : { success: false, returnData: '0x' as Hex };
    });
    return encodeFunctionResult({ abi: multicall, functionName: 'aggregate3', result: returnData });
  };
  const client = createPublicClient({ chain: base, transport: custom({ request }) });
  return () => client as unknown as PublicClient;
}

const usdc = node((target, data) => {
  if (target === EOA) return '0x';
  const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
  if (functionName === 'decimals') return encodeFunctionResult({ abi: erc20Abi, functionName, result: 6 });
  if (functionName === 'symbol') return encodeFunctionResult({ abi: erc20Abi, functionName, result: 'USDC' });
  if (functionName === 'balanceOf')
    return encodeFunctionResult({ abi: erc20Abi, functionName, result: 12_345_678_901_234_567_890n });
  return null;
});

const read = (functionName: string, args?: unknown[], address = USDC): Read => ({
  address,
  abi: erc20Abi as unknown as Read['abi'],
  functionName,
  args,
});

const values = (r: Awaited<ReturnType<typeof readContracts>>) => {
  if (!('structuredContent' in r)) throw new Error('refused');
  return r.structuredContent.results;
};

describe('jaw_read_contracts', () => {
  it('encodes each read and decodes decimals, symbol and balanceOf in one batch', async () => {
    const out = await readContracts(
      { chainId: 8453, reads: [read('decimals'), read('symbol'), read('balanceOf', [HOLDER])] },
      usdc
    );
    expect(values(out)).toEqual([
      { ok: true, value: 6 },
      { ok: true, value: 'USDC' },
      { ok: true, value: '12345678901234567890' },
    ]);
  });

  it('gives a reverting read its own error and still returns the others', async () => {
    const out = await readContracts(
      { chainId: 8453, reads: [read('decimals'), read('totalSupply'), read('symbol')] },
      usdc
    );
    const [a, b, c] = values(out);
    expect(a).toEqual({ ok: true, value: 6 });
    expect(b).toMatchObject({ ok: false });
    expect(c).toEqual({ ok: true, value: 'USDC' });
  });

  it('names a non-contract address instead of returning nothing', async () => {
    const out = await readContracts({ chainId: 8453, reads: [read('decimals', undefined, EOA)] }, usdc);
    expect(values(out)).toEqual([{ ok: false, error: expect.stringContaining('not a contract') }]);
  });

  it('refuses a chain JAW does not serve without opening a client', async () => {
    const out = await readContracts({ chainId: 1337, reads: [read('decimals')] }, () => {
      throw new Error('client opened');
    });
    expect(out).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('1337') }] });
  });

  it('refuses a function the ABI lacks, naming it', async () => {
    const out = await readContracts({ chainId: 8453, reads: [read('decimals'), read('nope')] }, usdc);
    expect(out).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('"nope"') }] });
  });

  it('refuses an event name or an unmatchable selector instead of failing the call', async () => {
    const selector: Read = {
      address: USDC,
      abi: [{ type: 'function', name: 'decimals' }],
      functionName: '0x313ce567',
    };
    for (const bad of [read('Transfer'), selector]) {
      const out = await readContracts({ chainId: 8453, reads: [read('decimals'), bad] }, usdc);
      expect(out).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Read 1: /) }] });
    }
  });

  it('refuses a read whose args do not encode instead of calling the contract a non-contract', async () => {
    for (const bad of [read('balanceOf', []), read('balanceOf', ['1.5']), read('balanceOf')]) {
      const out = await readContracts({ chainId: 8453, reads: [read('decimals'), bad] }, usdc);
      expect(out).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Read 1: .*not encode/) }] });
    }
  });
});
