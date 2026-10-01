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

/**
 * A paid row that reported one base unit against a thousand-unit ceiling.
 *
 * Written now, not on a fixed date: rows are given up on a week after `at`, so a
 * literal turned the whole suite red once the clock passed it. The cases that
 * need an old row pass their own `at`.
 */
const underReported = (over: Record<string, unknown> = {}) => ({
  at: new Date().toISOString(),
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
  // Every Permit2 nonce spent, which is what a settled payment leaves behind.
  // The cases about unspent nonces set their own.
  readContract.mockResolvedValue(2n ** 256n - 1n);
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

  it("does not count a transfer while the row's own nonce is unspent", async () => {
    appendX402Log(underReported());
    getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [transferLog(PAYER, PAY_TO, 1n)] });
    // The named transaction settled some other authorization to the same recipient.
    readContract.mockResolvedValue(0n);

    await reconcileSettlements(readX402Log());

    expect(figureFor('7')).toBe(1000n);
    expect(readX402Log().find((e) => e.nonce === '7')?.settlement).toBe('unverified');
  });

  it("does not let a later payment borrow an earlier settlement's transaction", async () => {
    appendX402Log(underReported({ nonce: '6', settlement: 'verified' }));
    appendX402Log(underReported());
    getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [transferLog(PAYER, PAY_TO, 1n)] });

    await reconcileSettlements(readX402Log());

    expect(figureFor('7')).toBe(1000n);
    expect(getTransactionReceipt).not.toHaveBeenCalled();
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
    // Eight failed `exact` attempts: no hash to look up, and their
    // authorizations are still live, so no consumption flag settles them yet.
    for (let i = 0; i < 8; i++) {
      appendX402Log(
        underReported({
          nonce: `stuck-${i}`,
          status: 'failed',
          scheme: 'exact',
          txHash: undefined,
          deadline: String(Math.floor(Date.now() / 1000) + 999),
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

describe('reconcileSettlements, a batch that cannot answer', () => {
  /**
   * The failure this split exists for: rows that stay answerable and never
   * answer. Taken from one end they hold every slot on every payment, and the
   * newest row, which is the one a live cap is still counting, is never asked
   * about.
   */
  it('reaches the newest row while older ones keep failing', async () => {
    for (let i = 0; i < 12; i++) {
      appendX402Log(
        underReported({
          nonce: String(i),
          at: `2026-09-10T00:00:${String(i).padStart(2, '0')}.000Z`,
          txHash: `0x${i.toString(16).padStart(64, '0')}`,
        })
      );
    }
    // Every receipt read fails except the newest row's, which settles at 1.
    getTransactionReceipt.mockImplementation(async () => {
      throw new Error('node did not answer');
    });
    const newest = readX402Log().at(-1);
    getTransactionReceipt.mockImplementation(async ({ hash }: { hash: string }) => {
      if (hash !== newest?.txHash) throw new Error('node did not answer');
      return {
        status: 'success',
        logs: [transferLog(PAYER, PAY_TO, 1n)],
      };
    });

    await reconcileSettlements(readX402Log());

    expect(figureFor('11')).toBe(1n);
  });
});

describe('reconcileSettlements, a row the chain never answers', () => {
  const WEEK_AGO = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  it('gives up after a week, keeping the ceiling and freeing the slot', async () => {
    // Mined, successful, and carrying no transfer of ours: the facilitator
    // routed it through an intermediary, so nothing here can ever answer it.
    appendX402Log(underReported({ nonce: 'stuck', at: WEEK_AGO }));
    getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] });
    readContract.mockResolvedValue(0n);

    await reconcileSettlements(readX402Log());

    const row = readX402Log().find((e) => e.nonce === 'stuck');
    expect(row?.settlement).toBe('abandoned');
    // Still worth its ceiling: nobody found out what moved.
    expect(figureFor('stuck')).toBe(1000n);

    // And no longer asked about.
    getTransactionReceipt.mockClear();
    await reconcileSettlements(readX402Log());
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('keeps asking about a row that is still young', async () => {
    appendX402Log(underReported({ nonce: 'fresh' }));
    getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] });
    readContract.mockResolvedValue(0n);

    await reconcileSettlements(readX402Log());

    expect(readX402Log().find((e) => e.nonce === 'fresh')?.settlement).toBe('unverified');
  });
});

describe('reconcileSettlements, rows nothing can ask about', () => {
  const WEEK_AGO = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  /**
   * An `exact` attempt that failed before a receipt: a nonce, no transaction to
   * look up, and no bitmap, since only `upto` signs against Permit2. No batch
   * ever reaches it, so without a sweep it holds its ceiling for the life of the
   * session total and keeps every compaction from folding it away.
   */
  it('retires a failed exact attempt once it is old enough', async () => {
    appendX402Log(
      underReported({ nonce: 'exact-fail', at: WEEK_AGO, scheme: 'exact', status: 'failed', txHash: undefined })
    );

    await reconcileSettlements(readX402Log());

    const row = readX402Log().find((e) => e.nonce === 'exact-fail');
    expect(row?.settlement).toBe('abandoned');
    // Still its ceiling: nobody ever found out whether it moved.
    expect(figureFor('exact-fail')).toBe(1000n);
    // And no chain read was made for it, because there is none to make.
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('leaves the same row alone while it is young', async () => {
    appendX402Log(underReported({ nonce: 'young', scheme: 'exact', status: 'failed', txHash: undefined }));

    await reconcileSettlements(readX402Log());

    expect(readX402Log().find((e) => e.nonce === 'young')?.settlement).toBe('unverified');
  });

  // A row written before `asset` was recorded matched no log at all, so a mined
  // transaction that did move funds read as "the chain has not said yet".
  it('finds the transfer on a row that carries no asset', async () => {
    appendX402Log(underReported({ nonce: '9', asset: undefined }));
    getTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [transferLog(PAYER, PAY_TO, 7n)],
    });

    await reconcileSettlements(readX402Log());

    expect(figureFor('9')).toBe(7n);
  });
});

describe('reconcileSettlements, an exact attempt the server reported as failed', () => {
  const NONCE = ('0x' + 'cd'.repeat(32)) as `0x${string}`;

  /** A failed `exact` attempt: signed and sent, no receipt, so no hash to look up. */
  const exactFailure = (over: Record<string, unknown> = {}) =>
    underReported({
      status: 'failed' as const,
      scheme: 'exact',
      amount: '1000',
      authorized: '1000',
      nonce: NONCE,
      txHash: undefined,
      deadline: String(Math.floor(Date.now() / 1000) - 60),
      ...over,
    });

  it('frees the ceiling of an authorization the token never consumed', async () => {
    appendX402Log(exactFailure());
    readContract.mockResolvedValue(false);

    await reconcileSettlements(readX402Log());

    expect(readX402Log().find((e) => e.nonce === NONCE)?.settlement).toBe('expired');
    expect(figureFor(NONCE)).toBe(0n);
  });

  it('records the payment the facilitator settled after answering that it had not', async () => {
    appendX402Log(exactFailure({ reason: 'settlement failed with status 400' }));
    // The nonce is spent: under `exact` that can only be the transfer the
    // signature fixed, whatever the server answered.
    readContract.mockResolvedValue(true);

    await reconcileSettlements(readX402Log());

    const row = readX402Log().find((e) => e.nonce === NONCE);
    expect(row?.settlement).toBe('verified');
    expect(row?.amount).toBe('1000');
    expect(figureFor(NONCE)).toBe(1000n);
  });

  it('never reads a figure above what the signature authorized', async () => {
    appendX402Log(exactFailure({ amount: '9999' }));
    readContract.mockResolvedValue(true);

    await reconcileSettlements(readX402Log());

    expect(figureFor(NONCE)).toBe(1000n);
  });

  it('asks nothing while the authorization is still live', async () => {
    appendX402Log(exactFailure({ deadline: String(Math.floor(Date.now() / 1000) + 600) }));

    await reconcileSettlements(readX402Log());

    expect(readContract).not.toHaveBeenCalled();
    expect(figureFor(NONCE)).toBe(1000n);
  });

  it('keeps the ceiling when the node does not answer, and asks again next time', async () => {
    appendX402Log(exactFailure());
    readContract.mockRejectedValue(new Error('rpc down'));

    await reconcileSettlements(readX402Log());
    expect(readX402Log().find((e) => e.nonce === NONCE)?.settlement).toBe('unverified');
    expect(figureFor(NONCE)).toBe(1000n);

    readContract.mockResolvedValue(false);
    await reconcileSettlements(readX402Log());
    expect(figureFor(NONCE)).toBe(0n);
  });

  it('puts no question to the token about a nonce EIP-3009 could not hold', async () => {
    appendX402Log(exactFailure({ nonce: 'hand-written' }));

    await reconcileSettlements(readX402Log());

    expect(readContract).not.toHaveBeenCalled();
    expect(figureFor('hand-written')).toBe(1000n);
  });

  it('prices a consumed authorization at what was signed, whatever the named transaction moved', async () => {
    appendX402Log(exactFailure({ status: 'paid', amount: '1', txHash: TX }));
    getTransactionReceipt.mockResolvedValue({ status: 'success', logs: [transferLog(PAYER, PAY_TO, 1n)] });
    readContract.mockResolvedValue(true);

    await reconcileSettlements(readX402Log());

    expect(figureFor(NONCE)).toBe(1000n);
  });

  it('leaves a row from before the ledger carried a scheme where it is', async () => {
    appendX402Log(exactFailure({ scheme: undefined }));

    await reconcileSettlements(readX402Log());

    expect(readContract).not.toHaveBeenCalled();
    expect(figureFor(NONCE)).toBe(1000n);
  });
});
