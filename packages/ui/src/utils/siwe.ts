/**
 * SIWE (Sign-In with Ethereum, EIP-4361) detection, parsing, and cross-domain
 * origin checks. Single source of truth shared by the keys.jaw.id popup and the
 * in-app ReactUIHandler.
 * https://eips.ethereum.org/EIPS/eip-4361
 */

import { parseSiweMessage as viemParseSiweMessage } from 'viem/siwe';

/**
 * Converts a hex string (with or without 0x prefix) to UTF-8.
 */
export function hexToUtf8(hex: string): string {
  const hexString = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(hexString.length / 2);

  for (let i = 0; i < hexString.length; i += 2) {
    bytes[i / 2] = parseInt(hexString.slice(i, i + 2), 16);
  }

  return new TextDecoder().decode(bytes);
}

/**
 * Detects whether a message (hex or plaintext) is a valid EIP-4361 SIWE message.
 */
export function isSiweMessage(message: string): boolean {
  if (!message) return false;

  try {
    const decodedMessage = message.startsWith('0x') ? hexToUtf8(message) : message;

    // Per EIP-4361: "<domain> wants you to sign in with your Ethereum account"
    if (!decodedMessage.includes('wants you to sign in with your Ethereum account')) {
      return false;
    }

    // Required SIWE fields. The nonce need only be present + alphanumeric here — we
    // deliberately DON'T enforce the 8-char minimum for detection, so a message with
    // a weak/short nonce still renders as SIWE and the dialog can flag it, rather than
    // silently falling back to the plain personal_sign screen.
    return (
      /URI:\s*.+/.test(decodedMessage) &&
      /Version:\s*1/.test(decodedMessage) &&
      /Chain ID:\s*\d+/.test(decodedMessage) &&
      /Nonce:\s*[a-zA-Z0-9]+/.test(decodedMessage) &&
      /Issued At:\s*.+/.test(decodedMessage)
    );
  } catch (error) {
    console.error('Error checking if message is SIWE:', error);
    return false;
  }
}

export interface SiweMessageFields {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

const toIsoString = (d: Date | undefined): string | undefined =>
  d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;

/**
 * The five required EIP-4361 fields. Fresh per call — a `/g` regex carries `lastIndex`.
 * Counted rather than first-matched: viem's own suffix match is unanchored, so a block
 * embedded in the statement would shadow the real one. Unanchored at the start for the
 * same reason: a block that begins mid-line (`Connect. URI: ...`) is still the first one
 * viem reads, so it has to count as a second block and fail the parse.
 *
 * A single literal space is deliberate: viem's parser — which extracts the values — requires
 * canonical `URI: `, so admitting more here would locate a block whose fields viem still
 * cannot read. Detection (`isSiweMessage`) is looser on purpose, and the gap that opens is
 * closed by `getSiweOriginWarning` working without a parse rather than by loosening this.
 */
const requiredFieldBlock = () => /URI: .+\nVersion: .+\nChain ID: .+\nNonce: .+\nIssued At: .+$/gm;

/**
 * Statement region — between the address line and the field block. viem captures a
 * single line only, but multi-line statements are common and this is the text the user
 * is agreeing to.
 */
function statementBefore(decoded: string, fieldBlockIndex: number): string {
  // Line 0 is the "<domain> wants you to sign in..." header, line 1 the address.
  return decoded.slice(0, fieldBlockIndex).split('\n').slice(2).join('\n').trim();
}

/**
 * Parses a SIWE message, or null when it can't be read unambiguously.
 *
 * Fails closed: every required field must come from the message (a defaulted `chainId`
 * rendered Base sign-ins as "Chain ID: 1 · Ethereum"), and two field blocks are refused
 * rather than resolved in the dApp's favour. Callers show the raw message and assert
 * nothing about it, including skipping the cross-domain check.
 */
export function parseSiweMessage(message: string): SiweMessageFields | null {
  if (!isSiweMessage(message)) {
    return null;
  }

  try {
    const decoded = message.startsWith('0x') ? hexToUtf8(message) : message;

    // Zero blocks is malformed; two means one hides in the statement and nothing says
    // which is authoritative.
    const blocks = [...decoded.matchAll(requiredFieldBlock())];
    if (blocks.length !== 1) return null;

    const parsed = viemParseSiweMessage(decoded);
    if (!parsed.domain || !parsed.address || !parsed.uri || !parsed.version || !parsed.nonce) return null;

    const { chainId } = parsed;
    if (typeof chainId !== 'number' || !Number.isFinite(chainId) || chainId <= 0) return null;

    const issuedAt = toIsoString(parsed.issuedAt);
    if (!issuedAt) return null;

    return {
      domain: parsed.domain,
      address: parsed.address,
      statement: parsed.statement || statementBefore(decoded, blocks[0].index ?? 0) || undefined,
      uri: parsed.uri,
      version: parsed.version,
      chainId,
      nonce: parsed.nonce,
      issuedAt,
      expirationTime: toIsoString(parsed.expirationTime),
      notBefore: toIsoString(parsed.notBefore),
      requestId: parsed.requestId,
      resources: parsed.resources,
    };
  } catch (error) {
    console.error('Error parsing SIWE message:', error);
    return null;
  }
}

/**
 * Resolves the lowercased host from a SIWE `domain` (a bare authority) or `uri`.
 * @returns the host, or null if empty/unparseable.
 */
function parseSiweHost(value?: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Domain and URI on a best-effort basis, for a message that did NOT parse.
 *
 * Deliberately permissive where `parseSiweMessage` is strict: it reads the two fields the
 * phishing check needs and ignores everything else. Nothing here is shown to the user as a
 * fact — it only feeds `getSiweOriginWarning`, whose output is a warning plus a mandatory
 * acknowledgement. Being wrong costs a spurious warning; being absent costs the hard block.
 *
 * No lazy regex on the header: `.+?` and `\s+` overlap on whitespace, nothing caps message
 * length on this path, and the dApp controls the string — a padded message made the
 * backtracking quadratic (~1s at 40 KB), freezing the dialog before the user could reject.
 * EIP-4361 puts the header on line 1, so it is read from line 1 alone, with indexOf.
 */
function bestEffortOriginFields(decoded: string): { domain?: string; uri?: string } {
  // Per EIP-4361 line 1 is "<domain> wants you to sign in with your Ethereum account:".
  const newline = decoded.indexOf('\n');
  const firstLine = newline === -1 ? decoded : decoded.slice(0, newline);
  const marker = firstLine.indexOf('wants you to sign in with your Ethereum account');
  const domain = marker > 0 && /\s/.test(firstLine[marker - 1]) ? firstLine.slice(0, marker).trim() : undefined;
  // Lenient about whitespace after the colon, unlike the canonical field block.
  const uri = /^URI:[^\S\n]*(\S+)/m.exec(decoded);
  return { domain: domain || undefined, uri: uri?.[1] };
}

export function bestEffortSiweAddress(decoded: string): string | undefined {
  // [^\S\n] rather than \s: the multiline ^/$ anchors already visit every line, and letting
  // the whitespace class cross newlines re-opens the quadratic-backtracking overlap above.
  const line = /^[^\S\n]*(0x[a-fA-F0-9]{40})[^\S\n]*$/m.exec(decoded);
  return line?.[1];
}

/**
 * The phishing warning for a raw message, whether or not it parses.
 *
 * Prefer this over pairing `parseSiweMessage` with `getSiweOriginWarning`: the parse is strict
 * by design (fails closed rather than inventing fields), and gating the warning on it let a
 * dapp suppress the cross-domain block — and with it the mandatory "I accept the risk"
 * checkbox — by writing a message that detects as SIWE but does not parse. `isSiweMessage`
 * accepts `\s*` after each colon where the parser needs a canonical single space, so a tab or
 * no space at all was enough. The fallback means the block no longer depends on formatting.
 */
export function getSiweOriginWarningFromMessage(requestOrigin: string, decodedMessage: string): string | undefined {
  const parsed = parseSiweMessage(decodedMessage);
  const fields = parsed ? { domain: parsed.domain, uri: parsed.uri } : bestEffortOriginFields(decodedMessage);
  return getSiweOriginWarning(requestOrigin, fields);
}

/**
 * Per EIP-4361 the SIWE `domain` must be the origin requesting the signature.
 * Returns a warning when the asserted domain/uri host differs from the origin
 * the user is actually on (cross-domain phishing), or undefined when they match
 * or cannot be compared.
 */
export function getSiweOriginWarning(
  requestOrigin: string,
  siwe: { domain?: string; uri?: string }
): string | undefined {
  const originHost = parseSiweHost(requestOrigin);
  const siweHost = parseSiweHost(siwe.domain) ?? parseSiweHost(siwe.uri);
  if (!originHost || !siweHost || originHost === siweHost) return undefined;
  return `This sign-in request is for "${siweHost}" but the requesting site is "${originHost}". This may be a phishing attempt.`;
}
