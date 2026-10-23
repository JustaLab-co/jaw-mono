import { describe, expect, it } from 'vitest';
import { readBridgeApprove } from './approve';
import { RELAY_USDC_APPROVE } from './fixtures';
import type { BridgeCall } from './view';

const DEPOSITORY = '0x4cD00E387622C35bDDB9b4c962C136462338BC31';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDBC = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';
const BASE_SPOKE_POOL = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64';
const PERIPHERY = '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const UNREADABLE = { kind: 'unreadable', provider: 'relay' };

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const approve = (spender: string, amount: string): BridgeCall => ({
  ...RELAY_USDC_APPROVE,
  data: '0x095ea7b3' + word(spender) + word(amount),
});

const usdc = { address: BASE_USDC, known: true, symbol: 'USDC', decimals: 6 };

describe('given the approve the MCP builds for a Relay USDC deposit on Base', () => {
  it('when it is read, then it names USDC, the exact 10 USDC and the Relay Depository', () => {
    expect(readBridgeApprove(RELAY_USDC_APPROVE)).toEqual({
      kind: 'approve',
      provider: 'relay',
      token: usdc,
      amount: 10_000_000n,
      spender: DEPOSITORY,
    });
  });

  it('when the token is USDbC, then it reads as an unknown token, never USDC', () => {
    expect(readBridgeApprove({ ...RELAY_USDC_APPROVE, to: USDBC })).toMatchObject({
      token: { address: USDBC, known: false },
    });
  });

  it('when the spender is the Across SpokePool or periphery on Base, then they read as Across', () => {
    expect(readBridgeApprove(approve(BASE_SPOKE_POOL, '989680'))).toMatchObject({
      provider: 'across',
      spender: BASE_SPOKE_POOL,
    });
    expect(readBridgeApprove(approve(PERIPHERY, '989680'))).toMatchObject({ provider: 'across', spender: PERIPHERY });
  });

  it('when the token address comes lowercase, then it still resolves to the pinned USDC', () => {
    expect(readBridgeApprove({ ...RELAY_USDC_APPROVE, to: BASE_USDC.toLowerCase() })).toMatchObject({ token: usdc });
  });

  it('when the amount changes, then the amount follows it', () => {
    expect(readBridgeApprove(approve(DEPOSITORY, '989681'))).toMatchObject({ amount: 10_000_001n });
  });
});

describe('given an approve whose spender is not a pinned bridge contract of its chain', () => {
  it('when the spender is any other address, then it is not recognized', () => {
    expect(readBridgeApprove(approve('0x1111111111111111111111111111111111111111', '989680'))).toBeUndefined();
  });

  it('when the shared Depository address is the spender on Linea, then it is not recognized', () => {
    expect(readBridgeApprove({ ...RELAY_USDC_APPROVE, chainId: 59144 })).toBeUndefined();
  });

  it('when the call is not an allowance change, then it is not recognized', () => {
    const transfer = '0xa9059cbb' + word(DEPOSITORY) + word('989680');
    expect(readBridgeApprove({ ...RELAY_USDC_APPROVE, data: transfer })).toBeUndefined();
  });
});

describe('given an allowance change to the pinned Depository that is not a plain approve', () => {
  it('when the approve carries a value, then it is unreadable', () => {
    expect(readBridgeApprove({ ...RELAY_USDC_APPROVE, value: '1' })).toEqual(UNREADABLE);
  });

  it('when the call is increaseAllowance, then it is unreadable', () => {
    const data = '0x39509351' + word(DEPOSITORY) + word('989680');
    expect(readBridgeApprove({ ...RELAY_USDC_APPROVE, data })).toEqual(UNREADABLE);
  });

  it('when the call is a Permit2 approve, then it is unreadable', () => {
    const data = '0x87517c45' + word(BASE_USDC) + word(DEPOSITORY) + word('989680') + word('ffffffffffff');
    expect(readBridgeApprove({ ...RELAY_USDC_APPROVE, to: PERMIT2, data })).toEqual(UNREADABLE);
  });

  it('when a byte trails the approve, then it is unreadable', () => {
    expect(readBridgeApprove({ ...RELAY_USDC_APPROVE, data: RELAY_USDC_APPROVE.data + '00' })).toEqual(UNREADABLE);
  });
});
