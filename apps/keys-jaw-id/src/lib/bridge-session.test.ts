// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { heldAccount, releaseHeldSession, sameAccount } from './bridge-session';

beforeEach(() => localStorage.clear());

describe('heldAccount', () => {
  it('is the first account the SDK store holds', () => {
    localStorage.setItem('jawsdk.store', JSON.stringify({ state: { account: { accounts: ['0xabc', '0xdef'] } } }));
    expect(heldAccount()).toBe('0xabc');
  });

  it.each([
    ['nothing stored', null],
    ['no accounts', '{"state":{"account":{}}}'],
    ['not JSON', '{oops'],
  ])('is absent for %s', (_, stored) => {
    if (stored !== null) localStorage.setItem('jawsdk.store', stored);
    expect(heldAccount()).toBeUndefined();
  });
});

describe('releaseHeldSession', () => {
  it('removes the signer and keeps everything else', () => {
    localStorage.setItem('JAWSDK:SignerConfig:SignerType', 'appSpecific');
    localStorage.setItem('jawsdk.store', '{}');
    releaseHeldSession();
    expect(localStorage.getItem('JAWSDK:SignerConfig:SignerType')).toBeNull();
    expect(localStorage.getItem('jawsdk.store')).toBe('{}');
  });
});

describe('sameAccount', () => {
  it('ignores letter case', () => {
    expect(sameAccount('0xAbC', '0xabc')).toBe(true);
    expect(sameAccount('0xabc', '0xabd')).toBe(false);
  });
});
