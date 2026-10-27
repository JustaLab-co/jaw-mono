import { describe, expect, it } from 'vitest';
import { storedGrantRequest, type GrantRequest, type PermissionCall, type PermissionSpend } from './permission';

// Every field set, through `Required`: a field added to one of these types does not compile here
// until it is filled in, and then fails the round trip below if the stored schema strips it.
const call: Required<PermissionCall> = {
  target: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  functionSignature: 'transfer(address,uint256)',
  checker: '0x398b9d939E7E616E03eA99601c835C920621B2ca',
};
const spend: Required<PermissionSpend> = {
  token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  allowance: '50000',
  unit: 'day',
  multiplier: 1,
};
const grant: Required<GrantRequest> = {
  spender: '0xF729fe95DE2cafbab0643434fe65F6df2F4F15FB',
  expiry: 1_793_197_201,
  chainId: '0x14a34',
  permissions: { calls: [call], spends: [spend] },
  capabilities: { prefundSpender: true },
};

describe('a grant request a resumed link stores', () => {
  it('comes back with every field it was stored with', () => {
    expect(storedGrantRequest.parse(grant)).toEqual(grant);
  });
});
