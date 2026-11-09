import { describe, expect, it } from 'vitest';
import {
  isSiweMessage,
  parseSiweMessage,
  getSiweOriginWarning,
  getSiweOriginWarningFromMessage,
  bestEffortSiweAddress,
} from './siwe';

const ADDRESS = '0x6270000000000000000000000000000000003847';

function siwe(parts: {
  domain?: string;
  address?: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  extra?: string;
}): string {
  const {
    domain = 'app.example',
    address = ADDRESS,
    statement,
    uri = 'https://app.example',
    version = '1',
    chainId = '1',
    nonce = 'abc12345',
    issuedAt = '2026-01-01T00:00:00.000Z',
    extra = '',
  } = parts;
  const head = `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n`;
  const body = statement ? `${statement}\n\n` : '';
  const fields =
    `URI: ${uri}\nVersion: ${version}\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}` + extra;
  return head + body + fields;
}

describe('isSiweMessage', () => {
  it('accepts a well-formed SIWE message', () => {
    expect(isSiweMessage(siwe({}))).toBe(true);
  });

  it('rejects a plain personal_sign message', () => {
    expect(isSiweMessage('Hello, World!')).toBe(false);
  });

  it('accepts a short/weak nonce (so the dialog can flag it, not fall back to plain sign)', () => {
    expect(isSiweMessage(siwe({ nonce: '1234' }))).toBe(true);
  });
});

describe('parseSiweMessage', () => {
  it('extracts the core fields', () => {
    const p = parseSiweMessage(siwe({ chainId: '8453', nonce: 'deadbeef99' }))!;
    expect(p.domain).toBe('app.example');
    expect(p.address).toBe(ADDRESS);
    expect(p.uri).toBe('https://app.example');
    expect(p.version).toBe('1');
    expect(p.chainId).toBe(8453);
    expect(p.nonce).toBe('deadbeef99');
    expect(p.issuedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('captures the statement', () => {
    const p = parseSiweMessage(siwe({ statement: 'Sign in to Example.' }))!;
    expect(p.statement).toBe('Sign in to Example.');
  });

  it('parses expiration and resources', () => {
    const p = parseSiweMessage(
      siwe({
        extra:
          '\nExpiration Time: 2036-01-01T00:00:00.000Z\nResources:\n- https://app.example/scope/read\n- https://app.example/scope/write',
      })
    )!;
    expect(p.expirationTime).toBe('2036-01-01T00:00:00.000Z');
    expect(p.resources).toEqual(['https://app.example/scope/read', 'https://app.example/scope/write']);
  });

  // The regression this suite exists for: a dApp must NOT be able to spoof the
  // displayed URI/Chain ID by embedding those tokens in the free-text statement.
  it('does not let a statement spoof the URI or chain id', () => {
    const p = parseSiweMessage(
      siwe({
        statement: 'Trust me. URI: https://evil.example Chain ID: 999',
        uri: 'https://app.example',
        chainId: '1',
      })
    )!;
    expect(p.uri).toBe('https://app.example');
    expect(p.chainId).toBe(1);
    expect(p.statement).toContain('evil.example');
  });

  it('returns null for a non-SIWE message', () => {
    expect(parseSiweMessage('Hello, World!')).toBeNull();
  });
});

describe('parseSiweMessage — fails closed instead of inventing fields', () => {
  // Detection is lax where viem's grammar is strict, so passing the former while
  // failing the latter used to yield defaults: a Base sign-in read "Chain ID: 1".
  const noSpaceAfterColon = siwe({ chainId: '8453' }).replace('URI: ', 'URI:');

  it('refuses a malformed field block rather than defaulting chainId to 1', () => {
    expect(isSiweMessage(noSpaceAfterColon)).toBe(true); // still detected as SIWE
    expect(parseSiweMessage(noSpaceAfterColon)).toBeNull();
  });

  it.each([
    ['URI', 'URI: https://app.example\n'],
    ['Version', 'Version: 1\n'],
    ['Chain ID', 'Chain ID: 1\n'],
    ['Nonce', 'Nonce: abc12345\n'],
  ])('refuses when the required %s line is absent', (_label, line) => {
    expect(parseSiweMessage(siwe({}).replace(line, ''))).toBeNull();
  });

  it('refuses a non-positive chain id', () => {
    expect(parseSiweMessage(siwe({ chainId: '0' }))).toBeNull();
  });

  // viem's unanchored suffix match took the FIRST hit, so an embedded block shadowed
  // the real one — displaying evil.example / 999 for a message signing 8453.
  it('refuses a message carrying two field blocks rather than picking one', () => {
    const spoofed = siwe({
      statement:
        'Please sign in.\nURI: https://evil.example\nVersion: 1\nChain ID: 999\nNonce: aaaaaaaa\nIssued At: 2020-01-01T00:00:00.000Z',
      uri: 'https://app.example',
      chainId: '8453',
    });
    expect(isSiweMessage(spoofed)).toBe(true);
    expect(parseSiweMessage(spoofed)).toBeNull();
  });

  // The same shadowing with the embedded block starting mid-line: a line-anchored count
  // saw one block, while viem read evil.example, chain 999 and the statement's request id.
  it('refuses a second field block that starts mid-line', () => {
    const spoofed = siwe({
      statement:
        'Please sign in. URI: https://evil.example\nVersion: 1\nChain ID: 999\nNonce: aaaaaaaa\nIssued At: 2020-01-01T00:00:00.000Z\nRequest ID: SPOOF1',
      uri: 'https://app.example',
      chainId: '8453',
      extra: '\nRequest ID: K7MXQ4',
    });
    expect(isSiweMessage(spoofed)).toBe(true);
    expect(parseSiweMessage(spoofed)).toBeNull();
  });
});

describe('parseSiweMessage — multi-line statement', () => {
  // viem captures a single line, so a two-line statement was dropped entirely and the
  // dialog rendered no box — the text being agreed to vanished with no warning.
  it('recovers a multi-line statement in full', () => {
    const p = parseSiweMessage(siwe({ statement: 'Line one of the terms.\nLine two of the terms.' }))!;
    expect(p).not.toBeNull();
    expect(p.statement).toBe('Line one of the terms.\nLine two of the terms.');
  });

  it('keeps the real fields alongside a recovered statement', () => {
    const p = parseSiweMessage(siwe({ statement: 'First line.\nSecond line.', chainId: '8453' }))!;
    expect(p.chainId).toBe(8453);
    expect(p.uri).toBe('https://app.example');
    expect(p.nonce).toBe('abc12345');
  });

  it('leaves statement undefined when there is none', () => {
    expect(parseSiweMessage(siwe({}))!.statement).toBeUndefined();
  });
});

describe('a refused message asserts nothing — including its domain', () => {
  // Deliberate, and pinned so changing it is a conscious act: no domain means callers
  // run no cross-domain check, so malforming the block suppresses the phishing warning.
  const broken = siwe({ domain: 'evil.example' }).replace('URI: ', 'URI:');

  it('is refused despite a readable head', () => {
    expect(isSiweMessage(broken)).toBe(true);
    expect(parseSiweMessage(broken)).toBeNull();
  });

  it('yields no domain for the caller to run an origin check against', () => {
    expect(parseSiweMessage(broken)?.domain).toBeUndefined();
  });

  it('still warns on a well-formed message from a foreign domain', () => {
    const p = parseSiweMessage(siwe({ domain: 'evil.example' }))!;
    expect(p.domain).toBe('evil.example');
    expect(getSiweOriginWarning('https://app.example', { domain: p.domain, uri: p.uri })).toContain('evil.example');
  });
});

describe('getSiweOriginWarning', () => {
  it('warns when the SIWE domain differs from the request origin', () => {
    const warning = getSiweOriginWarning('https://app.example', { domain: 'bank.com', uri: 'https://bank.com' });
    expect(warning).toContain('bank.com');
    expect(warning).toContain('app.example');
  });

  it('is silent when the hosts match', () => {
    expect(getSiweOriginWarning('https://app.example', { domain: 'app.example' })).toBeUndefined();
  });

  it('falls back to the uri host when domain is absent', () => {
    expect(getSiweOriginWarning('https://app.example', { uri: 'https://evil.example' })).toContain('evil.example');
  });

  it('is silent (fails open) when nothing is comparable', () => {
    expect(getSiweOriginWarning('https://app.example', {})).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The cross-domain warning must not depend on the message parsing.
//
// `isSiweMessage` accepts `\s*` after each field colon; the parser (viem) needs a canonical single
// space. A dapp can sit in that gap — the message reaches the SIWE dialog, the parse returns null,
// and every parse-gated protection disappears, including the MANDATORY "I accept the risk"
// checkbox that the cross-domain warning carries. So the warning is computed with a best-effort
// fallback instead.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe('getSiweOriginWarningFromMessage', () => {
  const phishing = (uriLine: string) =>
    [
      'evil.com wants you to sign in with your Ethereum account:',
      '0x1111111111111111111111111111111111111111',
      '',
      'Sign in please',
      '',
      uriLine,
      'Version: 1',
      'Chain ID: 1',
      'Nonce: abc12345',
      'Issued At: 2026-01-01T00:00:00Z',
    ].join('\n');

  it('warns on a canonical message whose domain differs from the requesting origin', () => {
    const warning = getSiweOriginWarningFromMessage('https://example.com', phishing('URI: https://evil.com'));
    expect(warning).toMatch(/evil\.com/);
    expect(warning).toMatch(/example\.com/);
  });

  it.each([
    ['no space after the colon', 'URI:https://evil.com'],
    ['a tab after the colon', 'URI:\thttps://evil.com'],
    ['a newline after the colon', 'URI:\nhttps://evil.com'],
    ['two spaces after the colon', 'URI:  https://evil.com'],
  ])('still warns when the message does not parse — %s', (_label, uriLine) => {
    const message = phishing(uriLine);
    // Precondition: this is exactly the detect-but-don't-parse gap.
    expect(isSiweMessage(message)).toBe(true);
    expect(getSiweOriginWarningFromMessage('https://example.com', message)).toMatch(/phishing/i);
  });

  it('stays silent when the domain matches, parsed or not', () => {
    for (const uriLine of ['URI: https://example.com', 'URI:\thttps://example.com']) {
      const message = [
        'example.com wants you to sign in with your Ethereum account:',
        '0x1111111111111111111111111111111111111111',
        '',
        'Sign in',
        '',
        uriLine,
        'Version: 1',
        'Chain ID: 1',
        'Nonce: abc12345',
        'Issued At: 2026-01-01T00:00:00Z',
      ].join('\n');
      expect(getSiweOriginWarningFromMessage('https://example.com', message)).toBeUndefined();
    }
  });

  it('agrees with the parse-based helper whenever the message does parse', () => {
    const message = phishing('URI: https://evil.com');
    const parsed = parseSiweMessage(message)!;
    expect(getSiweOriginWarningFromMessage('https://example.com', message)).toBe(
      getSiweOriginWarning('https://example.com', { domain: parsed.domain, uri: parsed.uri })
    );
  });
});

// The account-mismatch advisory hangs off the declared address. When the parse failed it silently
// evaluated to false — the wrong failure mode, since the dapp writes the message and so would choose
// whether the advisory appears.
describe('bestEffortSiweAddress', () => {
  const message = (address: string, uriLine = 'URI:\thttps://example.com') =>
    [
      'example.com wants you to sign in with your Ethereum account:',
      address,
      '',
      'Sign in',
      '',
      uriLine,
      'Version: 1',
      'Chain ID: 1',
      'Nonce: abc12345',
      'Issued At: 2026-01-01T00:00:00Z',
    ].join('\n');

  it('recovers the address from a message that does not parse', () => {
    const addr = '0x1111111111111111111111111111111111111111';
    const m = message(addr);
    expect(isSiweMessage(m)).toBe(true);
    expect(parseSiweMessage(m)).toBeNull();
    expect(bestEffortSiweAddress(m)).toBe(addr);
  });

  it('agrees with the parser when the message does parse', () => {
    const addr = '0x2222222222222222222222222222222222222222';
    const m = message(addr, 'URI: https://example.com');
    expect(parseSiweMessage(m)?.address?.toLowerCase()).toBe(addr);
    expect(bestEffortSiweAddress(m)?.toLowerCase()).toBe(addr);
  });

  it('is shape-checked, not checksum-checked — it is only ever compared case-insensitively', () => {
    const mixed = '0xAbCdEf1111111111111111111111111111111111';
    expect(bestEffortSiweAddress(message(mixed))).toBe(mixed);
  });

  it.each([
    ['too short', '0xabc'],
    ['not hex', '0xzzzz111111111111111111111111111111111111'],
    ['no prefix', '1111111111111111111111111111111111111111'],
  ])('returns undefined for an address-like line that is %s', (_label, bad) => {
    expect(bestEffortSiweAddress(message(bad))).toBeUndefined();
  });

  it('ignores an address that shares its line with other text', () => {
    const m = [
      'example.com wants you to sign in with your Ethereum account:',
      'spender 0x1111111111111111111111111111111111111111 approved',
      '',
      'URI: https://example.com',
    ].join('\n');
    expect(bestEffortSiweAddress(m)).toBeUndefined();
  });
});

// The dapp controls the message and nothing caps its length on this path, so the best-effort
// readers must run in linear time. The lazy-regex header reader was quadratic — `.+?` and `\s+`
// overlap on whitespace — and a padded 400 KB personal_sign payload froze the dialog for ~98s,
// denying the user the ability to reject. Bounds are generous for CI; the broken versions
// exceed them by orders of magnitude.
describe('best-effort readers are not quadratic on padded input', () => {
  it('handles a whitespace-padded non-parsing message quickly, and still warns', () => {
    const message = [
      `${' '.repeat(400_000)}x`,
      'wants you to sign in with your Ethereum account',
      '0x1111111111111111111111111111111111111111',
      '',
      'URI:\thttps://evil.com',
      'Version: 1',
      'Chain ID: 1',
      'Nonce: abc12345',
      'Issued At: 2026-01-01T00:00:00Z',
    ].join('\n');
    // Precondition: detected as SIWE, refused by the parser — the best-effort path.
    expect(isSiweMessage(message)).toBe(true);
    expect(parseSiweMessage(message)).toBeNull();

    const start = performance.now();
    const warning = getSiweOriginWarningFromMessage('https://example.com', message);
    expect(performance.now() - start).toBeLessThan(500);
    // The padding must not cost the phishing warning either: the URI fallback still reads.
    expect(warning).toMatch(/evil\.com/);
  });

  it('recovers no address from a whitespace-padded message quickly', () => {
    const message = '\n'.repeat(200_000) + ' '.repeat(200_000);
    const start = performance.now();
    expect(bestEffortSiweAddress(message)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(500);
  });
});
