import { describe, expect, it } from 'vitest';
import { toFunctionSelector, zeroAddress } from 'viem';
import {
  PROD_RELAY_DEPOSIT,
  RELAY_NATIVE_DEPOSIT,
  RELAY_USDC_DEPOSIT,
  RELAY_USDC_FEE_DEPOSIT,
  SIGNER,
} from './fixtures';
import { transferOf } from './transfer';
import { readRelayCall } from './relay';
import type { BridgeCall } from './view';
import { snapshotContracts } from './table';

const contracts = snapshotContracts();

const RELAY_HIDDEN =
  'Relay keeps the destination chain and the recipient in an order outside this transaction. This screen cannot show them. Confirm only if you started this transfer yourself.';
const DEPOSITORY = '0x4cD00E387622C35bDDB9b4c962C136462338BC31';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDBC = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';
const OTHER = '0x1111111111111111111111111111111111111111';
const UNREADABLE = { kind: 'unreadable', provider: 'relay' };

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
/** Replaces the 32-byte argument at `index` of the calldata. */
function withArg(call: BridgeCall, index: number, hex: string): BridgeCall {
  const data = call.data ?? '';
  const start = 10 + index * 64;
  return { ...call, data: data.slice(0, start) + word(hex) + data.slice(start + 64) };
}

function relayTransfer(call: BridgeCall) {
  const read = readRelayCall(contracts, call);
  return read?.kind === 'deposit' ? transferOf(contracts, read, SIGNER) : read;
}

const eth = (amount: bigint) => ({
  chainId: 8453,
  amount,
  token: { address: zeroAddress, known: true, symbol: 'ETH', decimals: 18 },
});
const usdc = (amount: bigint) => ({
  chainId: 8453,
  amount,
  token: { address: BASE_USDC, known: true, symbol: 'USDC', decimals: 6 },
});
const OTHER_CREDITED = `The account credited is not this account: ${OTHER}.`;

describe('given a Relay depositNative on the pinned Base Depository', () => {
  it('when the prod fixture is read, then it shows 0.01 ETH on Base credited to this account and the order', () => {
    expect(relayTransfer(PROD_RELAY_DEPOSIT)).toEqual({
      transfer: {
        provider: 'relay',
        title: 'Deposit to Relay',
        origin: { name: 'Base', nativeSymbol: 'ETH' },
        send: eth(10_000_000_000_000_000n),
        details: [
          { label: 'Credited to', value: 'This account', copy: SIGNER },
          {
            label: 'Order',
            value: '0x739a…6b7c',
            copy: '0x739af6f7fa984d7ce20472855ad1d0df78cbb8ba948de13115dfdc1797d36b7c',
          },
        ],
      },
      notices: [RELAY_HIDDEN],
      outsideTable: false,
    });
  });

  it('when the relay-native fixture is read, then its order id is its own', () => {
    const read = relayTransfer(RELAY_NATIVE_DEPOSIT);
    expect(read).toMatchObject({ transfer: { title: 'Deposit to Relay' } });
    expect(read).toHaveProperty('transfer.details.1', {
      label: 'Order',
      value: '0x61fb…536e',
      copy: '0x61fb170c281e35e82af8773e6b9c0cbc065e9f74abe896149ad6a480eaf9536e',
    });
  });

  it('when the value comes as hex from core, then it reads the same amount', () => {
    const read = relayTransfer({ ...PROD_RELAY_DEPOSIT, value: '0x354a6ba7a18000' });
    expect(read).toHaveProperty('transfer.send', eth(15_000_000_000_000_000n));
  });

  it('when the value changes, then the amount sent follows it', () => {
    const read = relayTransfer({ ...PROD_RELAY_DEPOSIT, value: '2500000000000000000000' });
    expect(read).toHaveProperty('transfer.send', eth(2_500_000_000_000_000_000_000n));
  });

  it('when the depositor is another account, then it is printed in full with a notice', () => {
    const read = relayTransfer(withArg(PROD_RELAY_DEPOSIT, 0, OTHER));
    expect(read).toHaveProperty('transfer.details.0', { label: 'Credited to', value: OTHER, copy: OTHER });
    expect(read).toHaveProperty('notices', [RELAY_HIDDEN, OTHER_CREDITED]);
  });

  it('when the id changes, then the order row changes', () => {
    const read = relayTransfer(withArg(PROD_RELAY_DEPOSIT, 1, 'ab'.repeat(32)));
    expect(read).toHaveProperty('transfer.details.1.value', '0xabab…abab');
  });

  it('when a byte trails the calldata, then it is unreadable', () => {
    expect(relayTransfer({ ...PROD_RELAY_DEPOSIT, data: PROD_RELAY_DEPOSIT.data + '00' })).toEqual(UNREADABLE);
  });

  it('when the value is 0, then it is unreadable', () => {
    expect(relayTransfer({ ...PROD_RELAY_DEPOSIT, value: '0' })).toEqual(UNREADABLE);
    expect(relayTransfer({ ...PROD_RELAY_DEPOSIT, value: undefined })).toEqual(UNREADABLE);
  });

  it('when the value is not a number, then it is unreadable', () => {
    expect(relayTransfer({ ...PROD_RELAY_DEPOSIT, value: 'ten' })).toEqual(UNREADABLE);
  });
});

describe('given a Relay depositErc20 on the pinned Base Depository', () => {
  it('when relay-usdc is read, then it shows 10 USDC on Base and what the depository pulls', () => {
    expect(relayTransfer(RELAY_USDC_DEPOSIT)).toEqual({
      transfer: {
        provider: 'relay',
        title: 'Deposit to Relay',
        origin: { name: 'Base', nativeSymbol: 'ETH' },
        send: usdc(10_000_000n),
        details: [
          { label: 'Credited to', value: 'This account', copy: SIGNER },
          {
            label: 'Order',
            value: '0x0de6…3c54',
            copy: '0x0de6aaacb71ffd230278e6aa855c6159b4e9e4be35ed782c48d74b1b42193c54',
          },
        ],
      },
      notices: [RELAY_HIDDEN],
      outsideTable: false,
    });
  });

  it('when relay-usdc-fee is read, then it reads the same amount with its own order', () => {
    expect(relayTransfer(RELAY_USDC_FEE_DEPOSIT)).toHaveProperty('transfer.details.1.value', '0x4aef…607f');
  });

  it('when the amount changes, then the amount sent and the pull follow it', () => {
    const read = relayTransfer(withArg(RELAY_USDC_DEPOSIT, 2, '1312d01'));
    expect(read).toHaveProperty('transfer.send', usdc(20_000_001n));
    expect(readRelayCall(contracts, withArg(RELAY_USDC_DEPOSIT, 2, '1312d01'))).toHaveProperty(
      'send.amount',
      20_000_001n
    );
  });

  it('when the token is USDbC, then it reads as an unknown token, never USDC', () => {
    const read = relayTransfer(withArg(RELAY_USDC_DEPOSIT, 1, USDBC));
    expect(read).toHaveProperty('transfer.send.token', { address: USDBC, known: false });
    expect(read).toHaveProperty(
      'notices.1',
      `This screen does not know the token ${USDBC}. Check it before you confirm.`
    );
  });

  it('when the token is the zero address, then it is unreadable, never read as native ETH', () => {
    expect(relayTransfer(withArg(RELAY_USDC_DEPOSIT, 1, '0'))).toEqual(UNREADABLE);
  });

  it('when the depositor is another account, then it is printed in full with a notice', () => {
    const read = relayTransfer(withArg(RELAY_USDC_DEPOSIT, 0, OTHER));
    expect(read).toHaveProperty('transfer.details.0', { label: 'Credited to', value: OTHER, copy: OTHER });
    expect(read).toHaveProperty('notices.1', OTHER_CREDITED);
  });

  it('when the id changes, then the order row changes', () => {
    expect(relayTransfer(withArg(RELAY_USDC_DEPOSIT, 3, 'cd'.repeat(32)))).toHaveProperty(
      'transfer.details.1.value',
      '0xcdcd…cdcd'
    );
  });

  it('when it carries a value, then it is unreadable', () => {
    expect(relayTransfer({ ...RELAY_USDC_DEPOSIT, value: '1' })).toEqual(UNREADABLE);
  });

  it('when a byte trails the calldata, then it is unreadable', () => {
    expect(relayTransfer({ ...RELAY_USDC_DEPOSIT, data: RELAY_USDC_DEPOSIT.data + '00' })).toEqual(UNREADABLE);
  });

  it('when it is the 3-argument depositErc20 that takes the whole allowance, then it is unreadable', () => {
    const selector = toFunctionSelector('function depositErc20(address depositor, address token, bytes32 id)');
    const data = selector + word(SIGNER) + word(BASE_USDC) + 'ab'.repeat(32);
    expect(relayTransfer({ ...RELAY_USDC_DEPOSIT, data })).toEqual(UNREADABLE);
  });

  it('when it is transferAndMulticall or any other selector, then it is unreadable', () => {
    expect(relayTransfer({ ...RELAY_USDC_DEPOSIT, data: '0xf9e4bab4' + word('20') })).toEqual(UNREADABLE);
  });
});

describe('given a call that is not to the pinned Depository of its chain', () => {
  it('when the target is a lookalike with the same calldata, then it is not recognized', () => {
    expect(relayTransfer({ ...RELAY_USDC_DEPOSIT, to: OTHER })).toBeUndefined();
  });

  it('when the shared Depository address is used on Linea, whose Depository differs, then it is not recognized', () => {
    expect(relayTransfer({ ...RELAY_USDC_DEPOSIT, chainId: 59144 })).toBeUndefined();
  });

  it('when the chain has no Relay entry or is not in the table, then it is not recognized', () => {
    expect(relayTransfer({ ...RELAY_USDC_DEPOSIT, chainId: 11155420 })).toBeUndefined();
    expect(relayTransfer({ ...RELAY_USDC_DEPOSIT, chainId: 999 })).toBeUndefined();
  });

  it('when the target is the checksummed Depository, then it is recognized', () => {
    expect(readRelayCall(contracts, { ...RELAY_USDC_DEPOSIT, to: DEPOSITORY })).toHaveProperty('kind', 'deposit');
  });
});
