import { describe, expect, it } from 'vitest';
import { concat, type Address, type Hex } from 'viem';
import { predictCheckerAddress } from '@jaw.id/core';

import { readChecker } from './checkerRule';

// The four entries of packages/core/vectors/checker-calls.json: each `checker` is the address the
// deployed factory returned for that template and settings on Base Sepolia.
const ARG_IN = '0x6cA4dcc0D7F56b17ACfc167f3F62650C36Be296A' as Address;
const ARG_AT_MOST = '0x3AB44b0ad082A2643Ab807c99e738D3e4C7BA60c' as Address;
const VALUE_AT_MOST = '0x54f1Ca09e52e0f86Ea9CA4c91458cd1E96CFdA0D' as Address;

const ONLY_LANDLORD = {
  template: ARG_IN,
  settings:
    '0xa9059cbb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000001a4d' as Hex,
  checker: '0x4f8365A8A4C6FD48e6f95FA3a089C654061DF765' as Address,
};
const SWAP_PAYS_WALLET = {
  template: ARG_IN,
  settings:
    '0x04e45aaf00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000001000000000000000000000000acc0acc0acc0acc0acc0acc0acc0acc0acc0acc0' as Hex,
  checker: '0x0E439Ae5E258C4fd38aDCe2Ce62e8E0d5b3Ae2Ae' as Address,
};
const UP_TO_100 = {
  template: ARG_AT_MOST,
  settings:
    '0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000056bc75e2d63100000' as Hex,
  checker: '0xF2D7a1eE699ad34eE8BE9b23CdAFC1551D8ea664' as Address,
};
const SEND_UP_TO_0_1 = {
  template: VALUE_AT_MOST,
  settings:
    '0xe0e0e0e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000016345785d8a0000' as Hex,
  checker: '0xA17Bba51730D9F772Ee177A29c59D5b52931B693' as Address,
};

/** A deployed clone's runtime code: the 45-byte proxy for `template`, then the settings. */
const cloneCode = (template: Address, settings: Hex): Hex =>
  concat(['0x363d3d373d3d3d363d73', template, '0x5af43d82803e903d91602b57fd5bf3', settings]);

describe('a checker the grant is about to deploy', () => {
  it('reads an ArgIn rule from its checkerDeploy', () => {
    const { checker, ...checkerDeploy } = ONLY_LANDLORD;
    expect(readChecker(checker, { checkerDeploy })).toEqual({
      status: 'ours',
      rule: {
        kind: 'argIn',
        selector: '0xa9059cbb',
        slot: 0n,
        allowed: ['0x0000000000000000000000000000000000000000000000000000000000001a4d'],
      },
    });
  });

  it('reads the "this wallet" rule with the ACCOUNT placeholder kept as it is', () => {
    const { checker, ...checkerDeploy } = SWAP_PAYS_WALLET;
    expect(readChecker(checker, { checkerDeploy })).toMatchObject({
      status: 'ours',
      rule: {
        kind: 'argIn',
        selector: '0x04e45aaf',
        slot: 3n,
        allowed: ['0x000000000000000000000000acc0acc0acc0acc0acc0acc0acc0acc0acc0acc0'],
      },
    });
  });

  it('reads an ArgAtMost rule', () => {
    const { checker, ...checkerDeploy } = UP_TO_100;
    expect(readChecker(checker, { checkerDeploy })).toEqual({
      status: 'ours',
      rule: { kind: 'argAtMost', selector: '0xa9059cbb', slot: 1n, max: 100n * 10n ** 18n },
    });
  });

  it('reads a ValueAtMost rule', () => {
    const { checker, ...checkerDeploy } = SEND_UP_TO_0_1;
    expect(readChecker(checker, { checkerDeploy })).toEqual({
      status: 'ours',
      rule: { kind: 'valueAtMost', selector: '0xe0e0e0e0', max: 10n ** 17n },
    });
  });

  it('is custom when the deploy would create a different contract than the checker', () => {
    const { template, settings } = ONLY_LANDLORD;
    expect(readChecker(UP_TO_100.checker, { checkerDeploy: { template, settings } })).toEqual({ status: 'custom' });
  });

  it('is custom when its template is not one of ours, even though the address matches', () => {
    const template = '0x1111111111111111111111111111111111111111' as Address;
    const checker = predictCheckerAddress(template, ONLY_LANDLORD.settings);
    expect(readChecker(checker, { checkerDeploy: { template, settings: ONLY_LANDLORD.settings } })).toEqual({
      status: 'custom',
    });
  });
});

describe('a checker that is already deployed', () => {
  it('reads the rule from its code', () => {
    const { checker, template, settings } = UP_TO_100;
    expect(readChecker(checker, { code: cloneCode(template, settings) })).toEqual({
      status: 'ours',
      rule: { kind: 'argAtMost', selector: '0xa9059cbb', slot: 1n, max: 100n * 10n ** 18n },
    });
  });

  // Anyone can deploy code shaped like our clone. Only the factory's address for that template
  // and those settings proves it is one.
  it('is custom when code shaped like our clone sits at an address our factory did not make', () => {
    const { template, settings } = ONLY_LANDLORD;
    const lookalike = '0x9999999999999999999999999999999999999999' as Address;
    expect(readChecker(lookalike, { code: cloneCode(template, settings) })).toEqual({ status: 'custom' });
  });

  it('is custom when its code is anything else', () => {
    expect(readChecker(ONLY_LANDLORD.checker, { code: '0x6080604052' })).toEqual({ status: 'custom' });
  });

  it('is custom when there is no code and nothing says how to deploy it', () => {
    expect(readChecker(ONLY_LANDLORD.checker, { code: '0x' })).toEqual({ status: 'custom' });
    expect(readChecker(ONLY_LANDLORD.checker, {})).toEqual({ status: 'custom' });
  });
});

describe('our checker with settings its template cannot read', () => {
  // The contract reverts on every check, so the function it guards can never run.
  it('is broken when the settings are another template’s', () => {
    const settings = UP_TO_100.settings;
    const checker = predictCheckerAddress(ARG_IN, settings);
    expect(readChecker(checker, { checkerDeploy: { template: ARG_IN, settings } })).toEqual({ status: 'broken' });
  });

  it('is broken when the selector word has bytes after its first four, which Solidity refuses', () => {
    const settings = `0xa9059cbb01${UP_TO_100.settings.slice(12)}` as Hex;
    const checker = predictCheckerAddress(ARG_AT_MOST, settings);
    expect(readChecker(checker, { checkerDeploy: { template: ARG_AT_MOST, settings } })).toEqual({
      status: 'broken',
    });
  });

  it('is broken when the settings are empty', () => {
    const checker = predictCheckerAddress(VALUE_AT_MOST, '0x');
    expect(readChecker(checker, { checkerDeploy: { template: VALUE_AT_MOST, settings: '0x' } })).toEqual({
      status: 'broken',
    });
  });
});
