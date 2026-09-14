import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem';

const TEST_ROOT = path.join(os.tmpdir(), 'jaw-settlement-test');

vi.mock('../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-settlement-test');
  return { PATHS: { root, x402Log: p.join(root, 'x402-log.jsonl') } };
});

const getTransactionReceipt = vi.fn();
const readContract = vi.fn();
vi.mock('./balance.js', () => ({
  publicClientFor: () => ({ getTransactionReceipt, readContract }),
}));

const { reconcileSettlements } = await import('./settlement.js');
const { appendX402Log, readX402Log, spendFigureOf } = await import('./ledger.js');

const PAYER = '0x1111111111111111111111111111111111111111';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TX = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** A `Transfer` log as a node returns it, so the decoder under test does the decoding. */
const transferLog = (from: string, to: string, value: bigint, token = USDC) => ({
  address: token,
  topics: encodeEventTopics({
    abi: [TRANSFER],
    eventName: 'Transfer',
    args: { from: from as `0x${string}`, to: to as `0x${string}` },
  }),
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});

/** A paid row that reported one base unit against a thousand-unit ceiling. */
const underReported = (over: Record<string, unknown> = {}) => ({
  at: '2026-09-10T00:00:00.000Z',
  url: 'https://api.example.com/x',
  payer: PAYER,
  status: 'paid' as const,
  amount: '1',
  authorized: '1000',
  scheme: 'upto',
  asset: USDC,
  network: 'eip155:84532',
  payTo: PAY_TO,
  nonce: '7',
  txHash: TX,
  deadline: String(Math.floor(Date.now() / 1000) + 3600),
  settlement: 'unverified' as const,
  ...over,
});

const figureFor = (nonce: string) => {
  const row = readX402Log().find((e) => e.nonce === nonce);
  if (!row) throw new Error(`no ledger row with nonce ${nonce}`);
  return spendFigureOf(row);
};

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  getTransactionReceipt.mockReset();
  readContract.mockReset();
});
afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('reconcileSettlements', () => {
  it('keeps a fabricated hash at its ceiling, and keeps it there on the next run', async () => {
    appendX402Log(underReported());
    // No such transaction: the node has nothing to return for a hash nobody sent.
    getTransactionReceipt.mockRejectedValue(new Error('transaction not found'));

    await reconcileSettlements(readX402Log());
    expect(figureFor('7')).toBe(1000n);

    await reconcileSettlements(readX402Log());
    expect(figureFor('7')).toBe(1000n);
  });

  it('counts the transfer in the transaction, not the figure the receipt claimed', async () => {
    appendX402Log(underReported());
    getTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [transferLog(PAYER, PAY_TO, 400n)],
    });

    await reconcileSettlements(readX402Log());

    expect(figureFor('7')).toBe(400n);
  });

  it('ignores transfers in the same transaction that are not ours', async () => {
    appendX402Log(underReported());
    getTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [
        transferLog('0x3333333333333333333333333333333333333333', PAY_TO, 900n),
        transferLog(PAYER, PAY_TO, 400n),
        transferLog(PAYER, PAY_TO, 25n, '0x9999999999999999999999999999999999999999'),
      ],
    });

    await reconcileSettlements(readX402Log());

    expect(figureFor('7')).toBe(400n);
  });

  it('leaves the row alone when the node does not answer, and does not throw', async () => {
    appendX402Log(underReported());
    getTransactionReceipt.mockRejectedValue(new Error('timed out'));
    readContract.mockRejectedValue(new Error('timed out'));

    await expect(reconcileSettlements(readX402Log())).resolves.toBeDefined();

    expect(figureFor('7')).toBe(1000n);
    expect(readX402Log().find((e) => e.nonce === '7')?.settlement).toBe('unverified');
  });

  it('zeroes a row whose deadline passed with its nonce unconsumed', async () => {
    appendX402Log(underReported({ txHash: undefined, deadline: String(Math.floor(Date.now() / 1000) - 60) }));
    // Bit 7 of word 0 clear: nothing ever spent this authorization.
    readContract.mockResolvedValue(0n);

    await reconcileSettlements(readX402Log());

    expect(figureFor('7')).toBe(0n);
  });

  it('keeps a row at its ceiling when the deadline passed but the nonce was consumed', async () => {
    appendX402Log(underReported({ txHash: undefined, deadline: String(Math.floor(Date.now() / 1000) - 60) }));
    readContract.mockResolvedValue(1n << 7n);

    await reconcileSettlements(readX402Log());

    expect(figureFor('7')).toBe(1000n);
  });

  it('returns the folded rows without a second read of the file', async () => {
    appendX402Log(underReported());
    getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [transferLog(PAYER, PAY_TO, 400n)] });

    const reconciled = await reconcileSettlements(readX402Log());

    expect(spendFigureOf(reconciled[0])).toBe(400n);
  });

  it('asks the chain nothing when every row is already answered', async () => {
    appendX402Log(underReported({ settlement: 'verified', amount: '400' }));

    await reconcileSettlements(readX402Log());

    expect(getTransactionReceipt).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('a real transaction carrying none of our transfers is no evidence, not evidence of zero', async () => {
    appendX402Log(underReported());
    // A mined, successful transaction anyone can copy off an explorer.
    getTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [
        transferLog('0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444', 900n),
      ],
    });

    await reconcileSettlements(readX402Log());

    expect(figureFor('7')).toBe(1000n);
    expect(readX402Log().find((e) => e.nonce === '7')?.settlement).toBe('unverified');
  });

  it('never counts more than the signature authorized', async () => {
    appendX402Log(underReported());
    getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [transferLog(PAYER, PAY_TO, 9000n)] });

    await reconcileSettlements(readX402Log());

    // Two of our payments in one settlement show both transfers to each row,
    // and the ceiling is the most either can have cost.
    expect(figureFor('7')).toBe(1000n);
  });

  it('rows nobody can ask about do not take a slot in the batch', async () => {
    // Eight failed `exact` attempts: no hash to look up and no Permit2 bitmap.
    for (let i = 0; i < 8; i++) {
      appendX402Log(
        underReported({
          nonce: `stuck-${i}`,
          status: 'failed',
          scheme: 'exact',
          txHash: undefined,
          deadline: String(Math.floor(Date.now() / 1000) - 999),
        })
      );
    }
    appendX402Log(underReported());
    getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [transferLog(PAYER, PAY_TO, 400n)] });

    await reconcileSettlements(readX402Log());

    expect(figureFor('7')).toBe(400n);
  });

  it('an unreadable deadline does not read as past', async () => {
    appendX402Log(underReported({ txHash: undefined, deadline: 'abc' }));
    readContract.mockResolvedValue(0n);

    await reconcileSettlements(readX402Log());

    expect(figureFor('7')).toBe(1000n);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('a row that throws on the way to the chain does not fail the payment', async () => {
    // `payer` is not a string, which is what a hand-edited ledger can hold.
    appendX402Log(underReported({ payer: 12345 as unknown as string }));
    getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [transferLog(PAYER, PAY_TO, 400n)] });

    await expect(reconcileSettlements(readX402Log())).resolves.toBeDefined();

    expect(figureFor('7')).toBe(1000n);
  });
});
