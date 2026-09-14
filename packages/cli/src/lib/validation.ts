import type { PermissionsConfig } from './types.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;
// The SDK hands `allowance` straight to BigInt(), which takes decimal and hex
// alike, and the permissions doc shows the decimal form
// (parseUnits('100', 6).toString()). Accepting only hex here would make the CLI
// stricter than the SDK it wraps, and the documented example would not validate.
const ALLOWANCE_RE = /^(0x[0-9a-fA-F]+|[0-9]+)$/;
const VALID_SPEND_UNITS = new Set(['minute', 'hour', 'day', 'week', 'month', 'year', 'forever']);

export function parsePermissionsConfig(raw: unknown): PermissionsConfig {
  const errors: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid permissions:\n  - Must be an object');
  }

  const obj = raw as Record<string, unknown>;
  const calls = obj.calls as unknown[] | undefined;
  const spends = obj.spends as unknown[] | undefined;

  if (!calls && !spends) {
    throw new Error('Invalid permissions:\n  - Must include at least "calls" or "spends"');
  }

  if (calls !== undefined) {
    if (!Array.isArray(calls) || calls.length === 0) {
      errors.push('calls: Must be a non-empty array');
    } else {
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i] as Record<string, unknown>;
        if (!c || typeof c !== 'object') {
          errors.push(`calls.${i}: Must be an object`);
          continue;
        }
        if (typeof c.target !== 'string' || !ADDRESS_RE.test(c.target)) {
          errors.push(`calls.${i}.target: Must be a valid 0x address (40 hex chars)`);
        }
        if (c.selector !== undefined && (typeof c.selector !== 'string' || !SELECTOR_RE.test(c.selector))) {
          errors.push(`calls.${i}.selector: Must be a 4-byte hex selector (e.g. 0xa9059cbb)`);
        }
      }
    }
  }

  if (spends !== undefined) {
    if (!Array.isArray(spends) || spends.length === 0) {
      errors.push('spends: Must be a non-empty array');
    } else {
      for (let i = 0; i < spends.length; i++) {
        const s = spends[i] as Record<string, unknown>;
        if (!s || typeof s !== 'object') {
          errors.push(`spends.${i}: Must be an object`);
          continue;
        }
        if (typeof s.token !== 'string' || !ADDRESS_RE.test(s.token)) {
          errors.push(`spends.${i}.token: Must be a valid 0x address (40 hex chars)`);
        }
        if (typeof s.allowance !== 'string' || !ALLOWANCE_RE.test(s.allowance)) {
          errors.push(`spends.${i}.allowance: Must be a decimal or 0x hex integer`);
        }
        if (typeof s.unit !== 'string' || !VALID_SPEND_UNITS.has(s.unit)) {
          errors.push(`spends.${i}.unit: Must be one of: ${[...VALID_SPEND_UNITS].join(', ')}`);
        }
        if (s.multiplier !== undefined && (!Number.isInteger(s.multiplier) || (s.multiplier as number) < 1)) {
          errors.push(`spends.${i}.multiplier: Must be a positive integer`);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid permissions:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  return raw as PermissionsConfig;
}

export function isValidKeysUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const isTrustedHost =
      parsed.hostname.endsWith('.jaw.id') ||
      parsed.hostname === 'jaw.id' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1';
    const isSecure = parsed.protocol === 'https:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    return isTrustedHost && isSecure;
  } catch {
    return false;
  }
}

export function isValidRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const isTrustedHost =
      parsed.hostname.endsWith('.jaw.id') ||
      parsed.hostname === 'jaw.id' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1';
    const isSecure = parsed.protocol === 'wss:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    const isWebSocket = parsed.protocol === 'wss:' || parsed.protocol === 'ws:';
    return isTrustedHost && isSecure && isWebSocket;
  } catch {
    return false;
  }
}
