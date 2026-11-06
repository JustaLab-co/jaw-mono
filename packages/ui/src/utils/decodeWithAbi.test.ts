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

  it('keeps a decode whose address word has dirty high bytes and marks it non-canonical', () => {
    const dirty = `${data.slice(0, 10)}ff${data.slice(12)}` as Hex;
    const decoded = decodeWithAbi(abi4, dirty);
    expect(decoded?.signature).toBe('depositErc20(address, address, uint256, bytes32)');
    expect(decoded?.params[0].value).toBe('0xfAbc9dDe6d43b39E087122A80f05E80615110b65');
    expect(decoded?.nonCanonical).toBe(true);
  });

  it('keeps a decode whose bytes4 word has nonzero padding and marks it non-canonical', () => {
    const g = parseAbi(['function g(bytes4 a)']);
    const calldata = encodeFunctionData({ abi: g, functionName: 'g', args: ['0x12345678'] });
    const decoded = decodeWithAbi(g, `${calldata.slice(0, -2)}ff` as Hex);
    expect(decoded?.params[0].value).toBe('0x12345678');
    expect(decoded?.nonCanonical).toBe(true);
  });

  it('returns null for a uint8 word with dirty high bits, which viem rejects', () => {
    const f = parseAbi(['function f(uint8 a)']);
    const calldata = encodeFunctionData({ abi: f, functionName: 'f', args: [5] });
    expect(decodeWithAbi(f, `${calldata.slice(0, 10)}ff${calldata.slice(12)}` as Hex)).toBeNull();
  });

  it('reports no tail on a non-canonical decode, since the end of the arguments is unknown', () => {
    const dirty = `${data.slice(0, 10)}ff${data.slice(12)}8021802180218021` as Hex;
    const decoded = decodeWithAbi(abi4, dirty);
    expect(decoded?.nonCanonical).toBe(true);
    expect(decoded?.trailing).toBeUndefined();
  });

  it('counts the bytes a non-canonical decode runs past the re-encoded call', () => {
    const dirty = `${data.slice(0, 10)}ff${data.slice(12)}`;
    expect(decodeWithAbi(abi4, `${dirty}deadbeef` as Hex)?.extraBytes).toBe(4);
    expect(decodeWithAbi(abi4, dirty as Hex)?.extraBytes).toBeUndefined();
    expect(decodeWithAbi(abi4, `${data}deadbeef` as Hex)?.extraBytes).toBeUndefined();
  });

  it('returns null for calldata with an odd number of hex digits', () => {
    const erc20 = parseAbi(['function approve(address spender, uint256 amount)']);
    const calldata = encodeFunctionData({
      abi: erc20,
      functionName: 'approve',
      args: ['0x1111111111111111111111111111111111111111', 5n],
    });
    expect(decodeWithAbi(erc20, `${calldata.slice(0, 40)}1${calldata.slice(40)}` as Hex)).toBeNull();
  });

  it('does not mark canonical calldata as non-canonical', () => {
    expect(decodeWithAbi(abi4, data)?.nonCanonical).toBeUndefined();
    expect(decodeWithAbi(abi4, `${data}8021` as Hex)?.nonCanonical).toBeUndefined();
  });

  it('marks every decode that does not re-encode to the calldata, over random bodies', () => {
    const selector = toFunctionSelector(abi4[0]);
    const body = data.slice(10);
    let seed = 1;
    const rand = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
    const digit = () => rand(16).toString(16);
    let dirty = 0;

    // Bodies of 240 to 339 hex digits: odd, word-aligned and not. The first 100 are random, the
    // rest are valid calldata with up to two digits changed.
    for (let i = 0; i < 400; i++) {
      const digits = 240 + (i % 100);
      const chars = Array.from({ length: digits }, (_, j) => (i >= 100 && j < body.length ? body[j] : digit()));
      for (let k = rand(3); k > 0; k--) chars[rand(digits)] = digit();
      const input = `${selector}${chars.join('')}` as Hex;
      const decoded = decodeWithAbi(abi4, input);
      expect(!!decoded).toBe(digits % 2 === 0 && digits >= 256);
      if (!decoded) continue;
      const types = decoded.params.map((p) => p.type).join(',');
      expect(decoded.signature).toBe(`depositErc20(${types.replaceAll(',', ', ')})`);
      // Every argument is static, so each one is read from its own word.
      const word = (j: number) => input.slice(10 + 64 * j, 74 + 64 * j);
      expect(decoded.params.map((p) => p.value.toLowerCase())).toEqual([
        `0x${word(0).slice(24)}`,
        `0x${word(1).slice(24)}`,
        BigInt(`0x${word(2)}`).toString(),
        `0x${word(3)}`,
      ]);
      const again = encodeFunctionData({
        abi: abi4,
        functionName: 'depositErc20',
        args: decoded.params.map((p, j) => (j === 2 ? BigInt(p.value) : p.value)) as never,
      });
      if (decoded.nonCanonical) {
        dirty++;
        expect(input.toLowerCase().startsWith(again.toLowerCase())).toBe(false);
        expect(decoded.trailing).toBeUndefined();
      } else {
        expect(`${again}${decoded.trailing?.slice(2) ?? ''}`.toLowerCase()).toBe(input.toLowerCase());
      }
    }
    expect(dirty).toBeGreaterThan(0);
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

  it('decodes a struct argument holding a uint256 instead of dropping it', () => {
    const router = parseAbi([
      'struct Params { address tokenIn; address tokenOut; uint24 fee; uint256 amountIn; }',
      'function exactInputSingle(Params params)',
    ]);
    const calldata = encodeFunctionData({
      abi: router,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: '0xfAbc9dDe6d43b39E087122A80f05E80615110b65',
          tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          fee: 3000,
          amountIn: 2000000n,
        },
      ],
    });
    const decoded = decodeWithAbi(router, calldata);
    expect(decoded?.params.map((p) => [p.name, p.value])).toEqual([
      [
        'params',
        '{"tokenIn":"0xfAbc9dDe6d43b39E087122A80f05E80615110b65","tokenOut":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","fee":3000,"amountIn":"2000000"}',
      ],
    ]);
  });

  it('shows struct arguments as their component types in the signature and each param', () => {
    const router = parseAbi([
      'struct Fee { uint24 bps; }',
      'struct Leg { address pool; Fee fee; }',
      'function route(Leg[] legs, Leg last, uint256 amount)',
    ]);
    const leg = { pool: '0xfAbc9dDe6d43b39E087122A80f05E80615110b65', fee: { bps: 3000 } } as const;
    const calldata = encodeFunctionData({ abi: router, functionName: 'route', args: [[leg], leg, 5n] });
    const decoded = decodeWithAbi(router, calldata);
    expect(decoded?.signature).toBe('route((address,(uint24))[], (address,(uint24)), uint256)');
    expect(decoded?.params.map((p) => p.type)).toEqual(['(address,(uint24))[]', '(address,(uint24))', 'uint256']);
    expect(toFunctionSelector(`route(${decoded?.params.map((p) => p.type).join(',')})`)).toBe(calldata.slice(0, 10));
  });

  it.each([
    ['no name or inputs', { type: 'function', selector: '0x12345678', stateMutability: 'view' }],
    ['a name and no inputs', { type: 'function', name: 'mystery', selector: '0x12345678', stateMutability: 'view' }],
  ])('skips an unresolved whatsabi entry with %s, before or after the called one', (_, unresolved) => {
    const entry = unresolved as unknown as Abi[number];
    expect(decodeWithAbi([entry, ...abi4], data)?.signature).toBe('depositErc20(address, address, uint256, bytes32)');
    expect(decodeWithAbi([...abi4, entry], data)?.signature).toBe('depositErc20(address, address, uint256, bytes32)');
  });

  it('skips an entry that cannot be hashed and still decodes with the called one after it', () => {
    const broken = {
      type: 'function',
      name: 'broken',
      inputs: [{ type: 'tuple', name: 'p', components: undefined }],
      outputs: [],
      stateMutability: 'view',
    } as unknown as Abi[number];
    expect(() => toFunctionSelector(broken as never)).toThrow();
    expect(decodeWithAbi([broken, ...abi4], data)?.signature).toBe('depositErc20(address, address, uint256, bytes32)');
  });
});
