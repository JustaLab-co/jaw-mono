import { describe, it, expect } from 'vitest';

import { resolveBridgeAppName } from './bridge-app-name';

describe('resolveBridgeAppName', () => {
  it('keeps a plain name', () => {
    expect(resolveBridgeAppName('Claude (via JAW MCP)')).toBe('Claude (via JAW MCP)');
  });

  it('falls back to the CLI name when absent or not a string', () => {
    for (const raw of [undefined, null, 42, {}, ['x'], true]) {
      expect(resolveBridgeAppName(raw)).toBe('JAW CLI');
    }
  });

  it('trims and collapses whitespace', () => {
    expect(resolveBridgeAppName('  My \t\n  Agent  ')).toBe('My Agent');
  });

  it('falls back when nothing is left after normalizing', () => {
    expect(resolveBridgeAppName('')).toBe('JAW CLI');
    expect(resolveBridgeAppName(' \n\t ')).toBe('JAW CLI');
    expect(resolveBridgeAppName('\u0000‮​')).toBe('JAW CLI');
  });

  it('strips control and bidi characters', () => {
    expect(resolveBridgeAppName('Agent\u202eSTOP\u202c')).toBe('AgentSTOP');
    expect(resolveBridgeAppName('A\u0007gent\u2066x\u2069')).toBe('Agentx');
  });

  it('caps the length at 64 characters', () => {
    expect(resolveBridgeAppName('a'.repeat(100))).toBe('a'.repeat(64));
  });

  it('does not end on a space after the cap', () => {
    expect(resolveBridgeAppName('a'.repeat(63) + ' b')).toBe('a'.repeat(63));
  });

  it('removes default-ignorable code points', () => {
    expect(resolveBridgeAppName('A\u3164B')).toBe('AB');
    expect(resolveBridgeAppName('A\uFE0FB')).toBe('AB');
    expect(resolveBridgeAppName('A\u034FB')).toBe('AB');
    expect(resolveBridgeAppName('\u3164\u034F')).toBe('JAW CLI');
  });

  it('removes a format character outside the default-ignorable set', () => {
    expect(resolveBridgeAppName('A\u0600B')).toBe('AB');
  });

  it('removes invisible characters before collapsing whitespace', () => {
    expect(resolveBridgeAppName('A \u200b B')).toBe('A B');
    expect(resolveBridgeAppName('A\u200bB')).toBe('AB');
  });

  it('turns tabs and newlines into one space', () => {
    expect(resolveBridgeAppName('A\t\nB\r\nC')).toBe('A B C');
  });

  it('does not let leading space eat the cap', () => {
    expect(resolveBridgeAppName(' ' + 'a'.repeat(65))).toBe('a'.repeat(64));
  });

  it('caps by code points and never splits a surrogate pair', () => {
    const name = '😀'.repeat(70);
    expect(resolveBridgeAppName(name)).toBe('😀'.repeat(64));
  });

  it('keeps the suffix of an emoji-heavy name under 64 code points', () => {
    const name = `${'😀'.repeat(40)} (via JAW MCP)`;
    expect(Array.from(name)).toHaveLength(54);
    expect(resolveBridgeAppName(name)).toBe(name);
  });
});
