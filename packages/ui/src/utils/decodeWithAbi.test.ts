import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi, toFunctionSelector, type Abi, type Hex } from 'viem';
import { decodeWithAbi } from './decodeWithAbi';

const abi4 = parseAbi(['function depositErc20(address depositor, address token, uint256 amount, bytes32 id)']);
const abi3 = parseAbi(['function depositErc20(address depositor, address token, bytes32 id)']);

const data = encodeFunctionData({
  abi: abi4,
  functionName: 'depositErc20',
  args: [
    '0xfAbc9dDe6d43b39E087122A80f05E80615110b65',
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    2000000n,
    '0x10483249e9edca4aa45c8cf3ed823f1a87145e338bf684c9cfe4daf1285546d3',
  ],
});

describe('decodeWithAbi', () => {
  it('uses the overload the selector names, not the first one with the same name', () => {
    const decoded = decodeWithAbi([...abi3, ...abi4], data);
    expect(decoded?.signature).toBe('depositErc20(address, address, uint256, bytes32)');
    expect(decoded?.params.map((p) => [p.type, p.value])).toEqual([
      ['address', '0xfAbc9dDe6d43b39E087122A80f05E80615110b65'],
      ['address', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
      ['uint256', '2000000'],
      ['bytes32', '0x10483249e9edca4aa45c8cf3ed823f1a87145e338bf684c9cfe4daf1285546d3'],
    ]);
  });

  it('decodes calldata with a suffix and reports the bytes it did not decode', () => {
    const decoded = decodeWithAbi(abi4, `${data}8021802180218021` as Hex);
    expect(decoded?.signature).toBe('depositErc20(address, address, uint256, bytes32)');
    expect(decoded?.trailing).toBe('0x8021802180218021');
  });

  it('reports no tail on exact calldata', () => {
    expect(decodeWithAbi(abi4, data)?.trailing).toBeUndefined();
  });

  it.each([
    [
      'uint128 vs uint256',
      'function f(uint128 a, address b)',
      'function f(uint256 a, address b)',
      'f(uint128, address)',
    ],
    ['bytes32 vs string', 'function g(bytes32 a)', 'function g(string a)', 'g(bytes32)'],
    ['address vs bytes20', 'function h(address a)', 'function h(bytes20 a)', 'h(address)'],
  ])('picks the overload by selector for %s in either declaration order', (_, called, other, sig) => {
    const callAbi = parseAbi([called]);
    const otherAbi = parseAbi([other]);
    const args = sig.startsWith('g')
      ? ['0x' + '11'.repeat(32)]
      : sig.startsWith('h')
        ? ['0xfAbc9dDe6d43b39E087122A80f05E80615110b65']
        : [5n, '0xfAbc9dDe6d43b39E087122A80f05E80615110b65'];
    const calldata = encodeFunctionData({ abi: callAbi, functionName: callAbi[0].name, args: args as never });
    expect(decodeWithAbi([...callAbi, ...otherAbi], calldata)?.signature).toBe(sig);
    expect(decodeWithAbi([...otherAbi, ...callAbi], calldata)?.signature).toBe(sig);
  });

  it('returns null when no ABI entry has the selector', () => {
    expect(decodeWithAbi(abi3, data)).toBeNull();
  });

  it('drops a decode whose address word has dirty high bytes, which re-encodes differently', () => {
    const body = data.slice(10);
    const dirty = `0x${data.slice(2, 10)}ff${body.slice(2)}` as Hex;
    expect(decodeWithAbi(abi4, dirty)).toBeNull();
  });

  it('never shows a signature that fails to re-encode to the calldata, over random and truncated bodies', () => {
    const selector = toFunctionSelector(abi4[0]);
    let seed = 1;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    const hex = (bytes: number) =>
      Array.from({ length: bytes }, () => (next() % 256).toString(16).padStart(2, '0')).join('');

    for (let i = 0; i < 300; i++) {
      const input = `${selector}${hex(next() % 160)}` as Hex;
      const decoded = decodeWithAbi(abi4, input);
      if (!decoded) continue;
      const types = decoded.params.map((p) => p.type).join(',');
      expect(decoded.signature).toBe(`depositErc20(${types.replaceAll(',', ', ')})`);
      const again = encodeFunctionData({
        abi: abi4,
        functionName: 'depositErc20',
        args: decoded.params.map((p, j) => (j === 2 ? BigInt(p.value) : p.value)) as never,
      });
      expect(again.toLowerCase()).toBe(input.toLowerCase());
    }
  });

  it('decodes nothing for every truncation of valid calldata', () => {
    for (let len = 10; len < data.length; len += 2) {
      expect(decodeWithAbi(abi4, data.slice(0, len) as Hex)).toBeNull();
    }
  });

  it('labels params by ABI name, falls back to their index, and keeps rawValue for addresses only', () => {
    const unnamed = parseAbi(['function depositErc20(address, address token, uint256, bytes32)']);
    const decoded = decodeWithAbi(unnamed, data);
    expect(decoded?.params.map((p) => p.name)).toEqual(['param0', 'token', 'param2', 'param3']);
    expect(decoded?.params.map((p) => p.rawValue)).toEqual([
      '0xfAbc9dDe6d43b39E087122A80f05E80615110b65',
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      undefined,
      undefined,
    ]);
  });

  it('decodes a function with no arguments to an empty param list', () => {
    const noArgs = parseAbi(['function pause()']);
    const calldata = encodeFunctionData({ abi: noArgs, functionName: 'pause' });
    expect(decodeWithAbi(noArgs, calldata)).toMatchObject({ signature: 'pause()', params: [] });
  });

  it.each([
    ['no name or inputs', { type: 'function', selector: '0x12345678', stateMutability: 'view' }],
    ['a name and no inputs', { type: 'function', name: 'mystery', selector: '0x12345678', stateMutability: 'view' }],
  ])('skips an unresolved whatsabi entry with %s, before or after the called one', (_, unresolved) => {
    const entry = unresolved as unknown as Abi[number];
    expect(decodeWithAbi([entry, ...abi4], data)?.signature).toBe('depositErc20(address, address, uint256, bytes32)');
    expect(decodeWithAbi([...abi4, entry], data)?.signature).toBe('depositErc20(address, address, uint256, bytes32)');
  });
});
