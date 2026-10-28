import { describe, it, expect } from 'vitest';
import { sanitizeLine, sanitizeBlock, DEFAULT_LINE_LENGTH } from './terminal.js';

const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
const BEL = String.fromCharCode(0x07);
const RLO = '\u202E'; // right-to-left override
const ZWSP = '\u200B';
const BOM = '\uFEFF';

describe('sanitizeLine', () => {
  // The attack this exists for: a paid endpoint erases the line the CLI wrote
  // and paints its own result in its place.
  it('disarms an erase-line-and-repaint sequence', () => {
    const attack = `eip155:9999${ESC}[2K${CR}${ESC}[32m  Paid. 5000000 USDC${ESC}[0m`;
    const safe = sanitizeLine(attack);
    expect(safe).not.toContain(ESC);
    expect(safe).not.toContain(CR);
    // The text stays readable, so tampering shows instead of vanishing.
    expect(safe).toContain('eip155:9999');
  });

  // A newline in a one-line field opens a second row under a log entry that
  // reads exactly like a real one. Same forgery as the escape sequences.
  it('strips newlines, which would forge an extra record', () => {
    const forgery = 'over cap\n  2026-08-06 20:00:01  paid   5 USDC  api.justaname.id';
    const safe = sanitizeLine(forgery);
    expect(safe).not.toContain('\n');
    expect(safe.split('\n')).toHaveLength(1);
  });

  it('strips tabs too, since they realign a column', () => {
    expect(sanitizeLine('a\tb')).toBe('a\uFFFDb');
  });

  // Trojan Source: these reorder rendering, so an address can display as
  // something other than the bytes that were signed.
  it('strips bidi overrides', () => {
    for (const ch of [RLO, '\u202A', '\u2066', '\u200F']) {
      expect(sanitizeLine(`0xGOOD${ch}EVIL`)).not.toContain(ch);
    }
  });

  it('strips zero-width characters that hide or split text', () => {
    for (const ch of [ZWSP, BOM, '\u200C', '\u200D']) {
      expect(sanitizeLine(`0xAAAA${ch}BBBB`)).not.toContain(ch);
    }
  });

  it('strips the C0 block, DEL and C1', () => {
    for (const ch of [ESC, CR, BEL, '\u0000', '\u007F', '\u009B']) {
      expect(sanitizeLine(`a${ch}b`)).toBe('a\uFFFDb');
    }
  });

  it('leaves ordinary text alone', () => {
    expect(sanitizeLine('amount 1000 exceeds maxAmountPerPayment 1')).toBe('amount 1000 exceeds maxAmountPerPayment 1');
  });

  it('bounds the length and says it cut', () => {
    const long = 'x'.repeat(DEFAULT_LINE_LENGTH + 500);
    const safe = sanitizeLine(long);
    expect(safe).toContain('500 more characters');
  });

  it('does not annotate text that fits', () => {
    expect(sanitizeLine('short', 10)).toBe('short');
  });

  it('handles non-strings without throwing', () => {
    expect(sanitizeLine(undefined)).toBe('undefined');
    expect(sanitizeLine(42)).toBe('42');
  });

  it('is idempotent', () => {
    const once = sanitizeLine(`a${ESC}[31mb`);
    expect(sanitizeLine(once)).toBe(once);
  });
});

describe('sanitizeBlock', () => {
  // A body is legitimately multi-line, and a newline cannot move the cursor
  // back over text already written.
  it('keeps newlines and tabs', () => {
    expect(sanitizeBlock('one\ntwo\tthree')).toBe('one\ntwo\tthree');
  });

  it('still disarms escape sequences and carriage returns', () => {
    const safe = sanitizeBlock(`ok${ESC}[2K${CR}${ESC}[32mPaid.${ESC}[0m`);
    expect(safe).not.toContain(ESC);
    expect(safe).not.toContain(CR);
  });

  it('still strips bidi and zero-width', () => {
    expect(sanitizeBlock(`a${RLO}b${ZWSP}c`)).toBe('a\uFFFDb\uFFFDc');
  });

  // The caller asked for this resource and may have paid for it; the read is
  // already bounded upstream by MAX_BODY_BYTES.
  it('does not truncate a large legitimate body', () => {
    const body = 'x'.repeat(50_000);
    expect(sanitizeBlock(body)).toHaveLength(50_000);
  });
});
