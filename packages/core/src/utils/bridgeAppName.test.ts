import { describe, it, expect } from 'vitest';

import { BRIDGE_APP_NAME_MAX_LENGTH, sanitizeBridgeAppName } from './bridgeAppName.js';

describe('sanitizeBridgeAppName', () => {
    it('keeps a plain name', () => {
        expect(sanitizeBridgeAppName('Claude (via JAW MCP)')).toBe('Claude (via JAW MCP)');
    });

    it('returns an empty string when nothing is left', () => {
        expect(sanitizeBridgeAppName('')).toBe('');
        expect(sanitizeBridgeAppName(' \n\t ')).toBe('');
        expect(sanitizeBridgeAppName('\u0000\u202e\u200b')).toBe('');
    });

    it('flattens whitespace and removes invisible characters', () => {
        expect(sanitizeBridgeAppName('  My \t\n  Agent  ')).toBe('My Agent');
        expect(sanitizeBridgeAppName('Agent\u202eSTOP\u202c')).toBe('AgentSTOP');
        expect(sanitizeBridgeAppName('A\u3164B')).toBe('AB');
        expect(sanitizeBridgeAppName('A\u0600B')).toBe('AB');
        expect(sanitizeBridgeAppName('A \u200b B')).toBe('A B');
    });

    it('caps at 64 code points by default without splitting a surrogate pair', () => {
        expect(BRIDGE_APP_NAME_MAX_LENGTH).toBe(64);
        expect(sanitizeBridgeAppName('a'.repeat(100))).toBe('a'.repeat(64));
        expect(sanitizeBridgeAppName('😀'.repeat(70))).toBe('😀'.repeat(64));
        expect(sanitizeBridgeAppName('a'.repeat(63) + ' b')).toBe('a'.repeat(63));
    });

    it('takes a smaller cap for a caller that appends its own suffix', () => {
        const suffix = ' (via JAW MCP)';
        const cap = BRIDGE_APP_NAME_MAX_LENGTH - suffix.length;
        const name = sanitizeBridgeAppName('x'.repeat(100), cap) + suffix;
        expect(Array.from(name)).toHaveLength(BRIDGE_APP_NAME_MAX_LENGTH);
    });
});
