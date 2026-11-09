import { describe, expect, it } from 'vitest';
import { stringToHex, type Address, type Hex } from 'viem';
import { readTokens } from './readTokens';
import { readKey } from './table';
import { DECIMALS, SYMBOL, nodeFor, type Answer } from './tokenNode';

const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const OTHER = '0x1111111111111111111111111111111111111111';
const answers = (a: Answer, address = AAPL) => ({ [address.toLowerCase()]: a });
const readOne = async (a: Answer, timeoutMs?: number) =>
  (await readTokens([{ chainId: 4663, address: AAPL }], nodeFor(answers(a)), timeoutMs)).get(readKey(4663, AAPL));

describe('given tokens outside the pinned table', () => {
  it('when a token answers, then its symbol and 18 decimals are read', async () => {
    expect(await readOne({ symbol: 'AAPL', decimals: 18n })).toEqual({ symbol: 'AAPL', decimals: 18 });
  });

  it('when the symbol is padded, then it is trimmed', async () => {
    expect(await readOne({ symbol: ' AAPL ', decimals: 18n })).toEqual({ symbol: 'AAPL', decimals: 18 });
  });

  it('when the symbol is USDC, then it is read as USDC, and it is up to the caller not to trust it', async () => {
    expect(await readOne({ symbol: 'USDC', decimals: 6n })).toEqual({ symbol: 'USDC', decimals: 6 });
  });

  it('when symbol() reverts, then the bytes32 form is not asked', async () => {
    const asked: string[] = [];
    const node = nodeFor(answers({ symbol: 'AAPL', decimals: 18n, revert: 'symbol' }), asked);
    await readTokens([{ chainId: 4663, address: AAPL }], node);
    expect(asked.filter((q) => q.endsWith(SYMBOL))).toHaveLength(1);
  });

  it('when the string decode fails, then the bytes32 form is asked', async () => {
    const asked: string[] = [];
    const node = nodeFor(answers({ symbol: 'MKR', decimals: 18n, bytes32: true }), asked);
    await readTokens([{ chainId: 4663, address: AAPL }], node);
    expect(asked.filter((q) => q.endsWith(SYMBOL))).toHaveLength(2);
  });

  it('when the symbol is a bytes32 word, then it is decoded without its null bytes', async () => {
    expect(await readOne({ symbol: 'MKR', decimals: 18n, bytes32: true })).toEqual({ symbol: 'MKR', decimals: 18 });
  });

  it('when a bytes32 symbol is not printable text, then the token stays unread', async () => {
    expect(await readOne({ symbol: 'AA\nPL', decimals: 18n, bytes32: true })).toBeUndefined();
  });

  it.each([
    ['all zeros', '0x' + '00'.repeat(32)],
    ['not ASCII', stringToHex('ÄAPL', { size: 32 })],
    ['a null byte inside it', stringToHex('AA\u0000PL', { size: 32 })],
    ['32 printable characters', stringToHex('A'.repeat(32), { size: 32 })],
    ['bytes that are neither a string nor a word', '0xdeadbeef'],
  ] as [string, Hex][])('when the symbol is %s, then the token stays unread', async (_, symbolBytes) => {
    expect(await readOne({ symbolBytes, decimals: 18n })).toBeUndefined();
  });

  it('when a bytes32 symbol fills 16 characters, then it is read', async () => {
    const symbolBytes = stringToHex('B'.repeat(16), { size: 32 });
    expect(await readOne({ symbolBytes, decimals: 18n })).toEqual({ symbol: 'B'.repeat(16), decimals: 18 });
  });

  it('when decimals is 0, then the token is read with no decimals', async () => {
    expect(await readOne({ symbol: 'NODEC', decimals: 0n })).toEqual({ symbol: 'NODEC', decimals: 0 });
  });

  it.each([
    ['decimals() reverts', { symbol: 'AAPL', revert: 'decimals' }],
    ['symbol() reverts', { symbol: 'AAPL', decimals: 18n, revert: 'symbol' }],
    ['there is no code', { code: false }],
    ['decimals is 255', { symbol: 'AAPL', decimals: 255n }],
    ['decimals is 37', { symbol: 'AAPL', decimals: 37n }],
    ['decimals is past a byte', { symbol: 'AAPL', decimals: 2n ** 200n }],
    ['the symbol is empty', { symbol: '', decimals: 18n }],
    ['the symbol is blank', { symbol: '   ', decimals: 18n }],
    ['the symbol is 17 characters', { symbol: 'A'.repeat(17), decimals: 18n }],
    ['the symbol has a control character', { symbol: 'AA\nPL', decimals: 18n }],
    ['the symbol has a right-to-left mark', { symbol: 'AAPL‮', decimals: 18n }],
    ['the symbol has a look-alike letter', { symbol: 'USDС', decimals: 6n }],
  ] as [string, Answer][])('when %s, then the token stays unread', async (_, answer) => {
    expect(await readOne(answer)).toBeUndefined();
  });

  it('when decimals is 36 and the symbol 16 characters, then they are read', async () => {
    expect(await readOne({ symbol: 'A'.repeat(16), decimals: 36n })).toEqual({ symbol: 'A'.repeat(16), decimals: 36 });
  });

  it('when a token never answers, then it stays unread once the timeout passes', async () => {
    expect(await readOne({ hang: true }, 20)).toBeUndefined();
  });

  it('when one token fails, then the others are still read', async () => {
    const reads = await readTokens(
      [
        { chainId: 4663, address: AAPL },
        { chainId: 4663, address: OTHER },
      ],
      nodeFor({ ...answers({ symbol: 'AAPL', decimals: 18n }), ...answers({ code: false }, OTHER) })
    );
    expect([...reads.keys()]).toEqual([readKey(4663, AAPL)]);
  });

  it('when a token appears twice, then it is asked once, and each token goes to its own chain', async () => {
    const asked: Record<number, string[]> = { 1: [], 4663: [] };
    const reads = await readTokens(
      [
        { chainId: 4663, address: AAPL },
        { chainId: 4663, address: AAPL.toLowerCase() as Address },
        { chainId: 1, address: OTHER },
      ],
      (chainId) =>
        nodeFor(
          { ...answers({ symbol: 'AAPL', decimals: 18n }), ...answers({ symbol: 'ONE', decimals: 6n }, OTHER) },
          asked[chainId]
        )()
    );
    expect(asked[4663]).toEqual([`${AAPL.toLowerCase()} ${SYMBOL}`, `${AAPL.toLowerCase()} ${DECIMALS}`]);
    expect(asked[1]).toEqual([`${OTHER} ${SYMBOL}`, `${OTHER} ${DECIMALS}`]);
    expect(reads.size).toBe(2);
  });
});
