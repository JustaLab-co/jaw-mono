import { describe, it, expect } from 'vitest';

import { DEFAULT_BRIDGE_APP_NAME, resolveBridgeAppName } from './bridge-app-name';

describe('resolveBridgeAppName', () => {
  it('keeps a plain name', () => {
    expect(resolveBridgeAppName('Claude (via JAW MCP)')).toBe('Claude (via JAW MCP)');
  });

  it('falls back to the CLI name when absent or not a string', () => {
    for (const raw of [undefined, null, 42, {}, ['x'], true]) {
      expect(resolveBridgeAppName(raw)).toBe(DEFAULT_BRIDGE_APP_NAME);
    }
  });

  it('trims and collapses whitespace', () => {
    expect(resolveBridgeAppName('  My \t\n  Agent  ')).toBe('My Agent');
  });

  it('falls back when nothing is left after normalizing', () => {
    expect(resolveBridgeAppName('')).toBe(DEFAULT_BRIDGE_APP_NAME);
    expect(resolveBridgeAppName(' \n\t ')).toBe(DEFAULT_BRIDGE_APP_NAME);
    expect(resolveBridgeAppName('\u0000‮​')).toBe(DEFAULT_BRIDGE_APP_NAME);
  });

  it('strips control and bidi characters', () => {
    expect(resolveBridgeAppName('Agent‮STOP‬')).toBe('Agent STOP');
    expect(resolveBridgeAppName('A\u0007gent⁦x⁩')).toBe('A gent x');
  });

  it('caps the length at 64 characters', () => {
    expect(resolveBridgeAppName('a'.repeat(100))).toBe('a'.repeat(64));
  });

  it('does not end on a space after the cap', () => {
    expect(resolveBridgeAppName('a'.repeat(63) + ' b')).toBe('a'.repeat(63));
  });
});
