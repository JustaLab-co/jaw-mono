import { describe, expect, it } from 'vitest';

import { sendFromAnswer, sendFromStatus, type Send } from './send-status';

const submitted: Send = { phase: 'submitted', id: '0x1', chainId: 84532 };
const txHash = '0xdead';

describe('sendFromAnswer', () => {
  it('reads the id and chain of a send', () => {
    expect(sendFromAnswer({ id: '0x1', chainId: 84532 })).toEqual(submitted);
  });

  it('reads a chain id given as hex', () => {
    expect(sendFromAnswer({ id: '0x1', chainId: '0x14a34' })).toEqual(submitted);
  });

  it('ignores an answer that is not a send', () => {
    for (const data of [null, undefined, ['0xabc'], { id: 1, chainId: 1 }, { id: '0x1' }]) {
      expect(sendFromAnswer(data)).toBeUndefined();
    }
  });
});

describe('sendFromStatus', () => {
  it('stays submitted while pending', () => {
    expect(sendFromStatus(submitted, { status: 100 })).toBe(submitted);
  });

  it('confirms with the hash of the receipt', () => {
    const status = { status: 200, receipts: [{ transactionHash: txHash }] };
    expect(sendFromStatus(submitted, status)).toEqual({ ...submitted, phase: 'confirmed', txHash });
  });

  it('stays submitted when 200 has no receipt yet', () => {
    expect(sendFromStatus(submitted, { status: 200, receipts: [] })).toBe(submitted);
  });

  it('fails with the hash when it reverted on chain', () => {
    const status = { status: 500, receipts: [{ transactionHash: txHash }] };
    expect(sendFromStatus(submitted, status)).toEqual({ ...submitted, phase: 'failed', txHash });
  });

  it('fails with no hash when it never landed', () => {
    expect(sendFromStatus(submitted, { status: 400 })).toEqual({ ...submitted, phase: 'failed' });
  });

  it('keeps the send on an answer it cannot read', () => {
    expect(sendFromStatus(submitted, undefined)).toBe(submitted);
  });
});
