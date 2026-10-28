import { describe, it, expect } from 'vitest';
import { mcpDiscoverResult, mcpPaymentResult, mcpResult } from './helpers.js';

const ESC = '\u001b';
const RTL_OVERRIDE = '\u202e';
const ZERO_WIDTH = '\u200b';
const REPLACEMENT = '\uFFFD';

/**
 * The fetched body and the refusal text are written by the paid server, and the
 * CLI renderer already runs both through `sanitizeBlock`.
 */
describe('mcpPaymentResult sanitization', () => {
  const blocksOf = (result: { content: { text: string }[] }) => result.content.map((b) => b.text);

  it('strips escape sequences from a string body', () => {
    const [meta, body] = blocksOf(mcpPaymentResult({ paid: true, body: `ok${ESC}[2K${ESC}[1GPaid. 5 USDC` }));
    expect(JSON.parse(meta).paid).toBe(true);
    expect(body).not.toContain(ESC);
    expect(body).toContain(REPLACEMENT);
    expect(body).toContain('Paid. 5 USDC');
  });

  it('strips the bidi overrides and zero-width characters JSON.stringify leaves alone', () => {
    const raw = { note: `send to 0xgood${RTL_OVERRIDE}${ZERO_WIDTH}` };
    // What the JSON path shipped before: stringify passes both through.
    expect(JSON.stringify(raw)).toContain(RTL_OVERRIDE);
    const [, body] = blocksOf(mcpPaymentResult({ paid: true, body: raw }));
    expect(body).not.toContain(RTL_OVERRIDE);
    expect(body).not.toContain(ZERO_WIDTH);
  });

  it('keeps the newlines a body is entitled to', () => {
    const [, body] = blocksOf(mcpPaymentResult({ paid: true, body: 'line one\nline two' }));
    expect(body).toContain('line one\nline two');
  });

  it('strips escape sequences from the refusal text', () => {
    const [, reason] = blocksOf(mcpPaymentResult({ paid: false, refusedReason: `over cap${ESC}[1Aall good` }));
    expect(reason.startsWith('[UNTRUSTED SERVER MESSAGE')).toBe(true);
    expect(reason).not.toContain(ESC);
    expect(reason).toContain(REPLACEMENT);
  });
});

/** Seller-written copy that `discover.ts` only type-checks. */
describe('mcpDiscoverResult sanitization', () => {
  it('strips the bidi override a seller put in a service name, and stays parseable', () => {
    const services = [{ name: `Weather API${RTL_OVERRIDE}`, url: 'https://api.example.com/w' }];
    const [, catalog] = mcpDiscoverResult({ count: 1, services }).content.map((b) => b.text);

    expect(catalog).not.toContain(RTL_OVERRIDE);
    expect(catalog).toContain(REPLACEMENT);
    const json = catalog.slice(catalog.indexOf('\n') + 1);
    expect(JSON.parse(json)[0].url).toBe('https://api.example.com/w');
  });

  it('leaves the trusted counters in their own block', () => {
    const [meta] = mcpDiscoverResult({ count: 2, services: [] }).content.map((b) => b.text);
    expect(JSON.parse(meta)).toEqual({ count: 2 });
  });
});

/** `jaw_rpc` returns what the RPC answered; `jaw_x402_log` replays the ledger. */
describe('mcpResult sanitization', () => {
  it('strips a bidi override out of token metadata a contract declares', () => {
    const [text] = mcpResult({ assets: [{ symbol: `USDC${RTL_OVERRIDE}`, balance: '0x1' }] }).content.map(
      (b) => b.text
    );

    expect(text).not.toContain(RTL_OVERRIDE);
    expect(JSON.parse(text).assets[0].balance).toBe('0x1');
  });

  it('strips a zero-width character out of a stored refusal reason', () => {
    const entry = { url: 'https://api.example.com/x', status: 'refused', reason: `over cap${ZERO_WIDTH}all good` };
    const [text] = mcpResult([entry]).content.map((b) => b.text);

    expect(text).not.toContain(ZERO_WIDTH);
    expect(JSON.parse(text)[0].reason).toContain(REPLACEMENT);
  });

  it('leaves ordinary values alone', () => {
    const data = { exists: true, chainId: 84532, address: '0xAbC', tags: ['a', 'b'] };
    const [text] = mcpResult(data).content.map((b) => b.text);

    expect(JSON.parse(text)).toEqual(data);
  });
});
