import { describe, it, expect } from 'vitest';

import { toDialogCalls } from './calls';

const TARGET = '0x3333333333333333333333333333333333333333';
const CHECKER = '0x8888888888888888888888888888888888888888';

/**
 * Both grant hosts, ReactUIHandler and keys.jaw.id, turn the requested calls into the rows the
 * dialog shows. The checker is part of what the passkey signs, so it has to survive that step in
 * both, or the screen shows a narrower permission than the one being signed.
 */
describe('the calls a grant screen shows', () => {
  it('keeps the checker the dapp asked for', () => {
    const [call] = toDialogCalls([{ target: TARGET, selector: '0xa9059cbb', checker: CHECKER }], {});

    expect(call.checker).toBe(CHECKER);
  });

  // The grant screen reads an undeployed checker's rule from how the grant will deploy it.
  it('keeps how the grant deploys the checker', () => {
    const checkerDeploy = { template: '0x6cA4dcc0D7F56b17ACfc167f3F62650C36Be296A', settings: '0x1234' };
    const [call] = toDialogCalls([{ target: TARGET, selector: '0xa9059cbb', checker: CHECKER, checkerDeploy }], {});

    expect(call.checkerDeploy).toEqual(checkerDeploy);
  });

  it('names a selector by its resolved signature, and falls back to the raw hex until it resolves', () => {
    const request = [{ target: TARGET, selector: '0xA9059CBB' }];

    expect(toDialogCalls(request, {})[0].functionSignature).toBe('0xA9059CBB');
    expect(toDialogCalls(request, { '0xa9059cbb': 'transfer(address,uint256)' })[0].functionSignature).toBe(
      'transfer(address,uint256)'
    );
  });

  it('prefers the signature the dapp sent over a lookup', () => {
    const [call] = toDialogCalls(
      [{ target: TARGET, selector: '0xa9059cbb', functionSignature: 'transfer(address,uint256)' }],
      { '0xa9059cbb': 'something_else()' }
    );

    expect(call.functionSignature).toBe('transfer(address,uint256)');
  });

  it('says so when a call has neither a selector nor a signature', () => {
    expect(toDialogCalls([{ target: TARGET }], {})[0].functionSignature).toBe('Unknown Function');
  });
});
