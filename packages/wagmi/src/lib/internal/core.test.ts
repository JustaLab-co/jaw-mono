import { expect, test } from 'vitest';
import { createConfig, http } from '@wagmi/core';
import { arbitrum, mainnet } from 'viem/chains';
import type { EIP1193Parameters } from 'viem';

import { addFunds, getPermissions, sign } from './core.js';

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;

function fakeConnection() {
  const requests: EIP1193Parameters[] = [];
  const connector = {
    getAccounts: async () => [ACCOUNT],
    // Connector sits on Arbitrum while the caller targets mainnet.
    getChainId: async () => arbitrum.id,
    getProvider: async () => ({
      request: async (args: EIP1193Parameters) => {
        requests.push(args);
        return '0xsignature';
      },
    }),
  };
  return { connector, requests };
}

const config = createConfig({
  chains: [mainnet, arbitrum],
  transports: { [mainnet.id]: http(), [arbitrum.id]: http() },
});

test('sign forwards hex chainId and address in wallet_sign params', async () => {
  const { connector, requests } = fakeConnection();

  const result = await sign(config, {
    connector: connector as never,
    address: ACCOUNT,
    chainId: mainnet.id,
    request: { type: '0x45', data: { message: 'Hello World' } },
  });

  expect(result).toBe('0xsignature');
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('wallet_sign');
  const params = (requests[0].params as [Record<string, unknown>])[0];
  expect(params.chainId).toBe('0x1');
  expect(params.address).toBe(ACCOUNT);
  expect(params.request).toEqual({ type: '0x45', data: { message: 'Hello World' } });
});

test('sign does not require the connector to be on the target chain', async () => {
  const { connector } = fakeConnection();

  // Before assertChainId: false this threw ConnectorChainMismatchError
  // (connector on Arbitrum, chainId targeting mainnet) before any RPC went out.
  await expect(
    sign(config, {
      connector: connector as never,
      chainId: mainnet.id,
      request: { type: '0x45', data: { message: 'Hello World' } },
    })
  ).resolves.toBe('0xsignature');
});

test('sign omits chainId from params when not provided', async () => {
  const { connector, requests } = fakeConnection();

  await sign(config, {
    connector: connector as never,
    request: { type: '0x45', data: { message: 'Hello World' } },
  });

  const params = (requests[0].params as [Record<string, unknown>])[0];
  expect(params.chainId).toBeUndefined();
});

test('getPermissions forwards hex chainId and address in wallet_getPermissions params', async () => {
  const { connector, requests } = fakeConnection();

  await getPermissions(config, {
    connector: connector as never,
    address: ACCOUNT,
    chainId: mainnet.id,
  });

  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('wallet_getPermissions');
  const params = (requests[0].params as [Record<string, unknown>])[0];
  expect(params.address).toBe(ACCOUNT);
  // Before this test the param was silently dropped and the response spanned every chain.
  expect(params.chainId).toBe('0x1');
});

test('getPermissions omits chainId from params when not provided', async () => {
  const { connector, requests } = fakeConnection();

  await getPermissions(config, {
    connector: connector as never,
    address: ACCOUNT,
  });

  const params = (requests[0].params as [Record<string, unknown>])[0];
  expect(params.chainId).toBeUndefined();
});

test('addFunds forwards only the chain, never a destination', async () => {
  const { connector, requests } = fakeConnection();

  const result = await addFunds(config, {
    connector: connector as never,
    address: ACCOUNT,
    chainId: mainnet.id,
  });

  // Null, not the provider's answer: there is no outcome to report.
  expect(result).toBeNull();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('wallet_addFunds');

  // `address` selects which connected account to act as, exactly as in the
  // other actions. It must not travel as a destination the wallet would honour.
  const params = (requests[0].params as [Record<string, unknown>])[0];
  expect(params).toEqual({ chainId: mainnet.id });
  expect(params.address).toBeUndefined();
});

test('addFunds does not require the connector to be on the named chain', async () => {
  const { connector, requests } = fakeConnection();

  // The connector sits on Arbitrum. Nothing is sent, and the address is the
  // same on every chain, so naming mainnet must not be a chain mismatch.
  await expect(
    addFunds(config, { connector: connector as never, address: ACCOUNT, chainId: mainnet.id })
  ).resolves.toBeNull();
  expect(requests).toHaveLength(1);
});

test('addFunds takes no arguments at all', async () => {
  const { connector, requests } = fakeConnection();

  await expect(addFunds(config, { connector: connector as never })).resolves.toBeNull();
  expect((requests[0].params as [Record<string, unknown>])[0]).toEqual({ chainId: undefined });
});
