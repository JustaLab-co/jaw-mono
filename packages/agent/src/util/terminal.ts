/**
 * Make server-controlled text safe to print.
 *
 * A paid endpoint controls its response body, and parts of its 402 challenge
 * reach our refusal messages, which are stored in the payment ledger and
 * reprinted by `jaw x402 log`. Printed raw, an escape sequence lets that server
 * erase the line the CLI just wrote and paint its own in place: a resource that
 * was never paid for can render a convincing green "Paid. 5 USDC" the CLI never
 * emitted, and once in the ledger it does so on every later read.
 *
 * Two shapes, because the danger differs. A newline inside a one-line field
 * forges an extra row that reads as a genuine record, while inside a response
 * body it is just a newline. Only the human renderers need any of this: JSON
 * output escapes control characters on its own.
 */

/**
 * Characters that are invisible or reorder what follows them, in any context.
 *
 * Bidi overrides (U+202A-U+202E, U+2066-U+2069) are the Trojan Source trick:
 * they flip rendering direction, so an address can display as something other
 * than the bytes that were signed. The zero-width family hides text outright,
 * splitting an address to the eye while leaving it intact to a copy. Neither is
 * a control character in the C0 or C1 sense, so stripping those alone misses
 * both. U+2028 and U+2029 break lines the way a newline does.
 */
const INVISIBLE_AND_BIDI = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** C0 except tab and newline, DEL, and the C1 block. For multi-line text. */
// eslint-disable-next-line no-control-regex
const BLOCK_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Every C0 control, DEL and C1. For text that must stay on one line. */
// eslint-disable-next-line no-control-regex
const LINE_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Left in place of a stripped character, so tampering shows rather than vanishing. */
const REPLACEMENT = '\uFFFD';

export const DEFAULT_LINE_LENGTH = 200;

function bound(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  // Say it was cut. A silently truncated error message reads as a complete one.
  return `${text.slice(0, maxLength)}\u2026 (${text.length - maxLength} more characters)`;
}

/**
 * Disarm a value that has to render as a single line: a refusal reason, a
 * network id, a host, a transaction hash.
 *
 * Newlines go with everything else here. A reason carrying one would otherwise
 * open a second line under a log entry, indistinguishable from the real row
 * above it, which is the same forgery the escape sequences allow.
 */
export function sanitizeLine(value: unknown, maxLength: number = DEFAULT_LINE_LENGTH): string {
  const text = typeof value === 'string' ? value : String(value);
  return bound(text.replace(LINE_CONTROLS, REPLACEMENT).replace(INVISIBLE_AND_BIDI, REPLACEMENT), maxLength);
}

/**
 * Disarm a response body, keeping its shape.
 *
 * Newlines and tabs survive, since a body is legitimately multi-line and
 * neither can move the cursor back over text already written. Nothing is
 * truncated: the caller asked for this resource and may well have paid for it,
 * and the read is already bounded upstream by MAX_BODY_BYTES.
 */
export function sanitizeBlock(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.replace(BLOCK_CONTROLS, REPLACEMENT).replace(INVISIBLE_AND_BIDI, REPLACEMENT);
}
