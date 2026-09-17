import { describe, expect, it } from 'vitest';
import { INTERACTIVE_METHODS, SILENT_METHODS, isSilentMethod, requiresInteraction } from './method-policy.js';

describe('method-policy', () => {
    it('classifies read-only reconnect methods as silent', () => {
        expect(isSilentMethod('eth_accounts')).toBe(true);
        expect(isSilentMethod('eth_chainId')).toBe(true);
        expect(isSilentMethod('net_version')).toBe(true);
        expect(isSilentMethod('wallet_getCapabilities')).toBe(true);
    });

    it('never classifies a connecting/signing/authority method as silent', () => {
        for (const method of [
            'eth_requestAccounts',
            'wallet_connect',
            'wallet_sendCalls',
            'wallet_sign',
            'personal_sign',
            'eth_signTypedData_v4',
            'eth_sendTransaction',
            'wallet_grantPermissions',
            'wallet_revokePermissions',
            // Shows the account's own address on a wallet surface. Serving it
            // headlessly would let a page read the address with no user gesture.
            'wallet_addFunds',
        ]) {
            expect(isSilentMethod(method)).toBe(false);
            expect(requiresInteraction(method)).toBe(true);
        }
    });

    it('fails safe: an unknown method is interactive, never silent', () => {
        expect(isSilentMethod('eth_totallyNewMethod')).toBe(false);
        expect(requiresInteraction('eth_totallyNewMethod')).toBe(true);
    });

    it('requiresInteraction is the exact complement of isSilentMethod', () => {
        for (const method of [...SILENT_METHODS, ...INTERACTIVE_METHODS, 'unknown_method']) {
            expect(requiresInteraction(method)).toBe(!isSilentMethod(method));
        }
    });

    it('keeps the silent and interactive sets disjoint (no method is both)', () => {
        const overlap = SILENT_METHODS.filter((m) => INTERACTIVE_METHODS.includes(m));
        expect(overlap).toEqual([]);
    });

    it('treats every silent method as a non-mutating read (allow-list guard)', () => {
        // A signing/sending/granting verb must never sneak into the silent set.
        const forbidden = /sign|send|grant|revoke|connect|requestAccounts/i;
        for (const method of SILENT_METHODS) {
            expect(method).not.toMatch(forbidden);
        }
    });
});
