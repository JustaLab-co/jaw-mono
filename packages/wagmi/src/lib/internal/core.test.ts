import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { ConnectorNotConnectedError, type CreateConnectorFn, createConfig, createConnector, http } from '@wagmi/core';
import { arbitrum, mainnet } from 'viem/chains';
import { type EIP1193Parameters, type Hex, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  type Ceremony,
  SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  computeRecoveryId,
  computeRequestId,
  recoverTypedData,
  toOwnerBytes,
} from '@jaw.id/core';

import {
  addFunds,
  approveRecovery,
  cancelRecovery,
  getPermissions,
  getRecovery,
  getRecoveryStatus,
  setupRecovery,
  sign,
  startRecovery,
} from './core.js';
import { getRecoveryStatusQueryKey } from './query.js';

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

test('getRecovery forwards the address and never a chainId in wallet_getRecovery params', async () => {
  const { connector, requests } = fakeConnection();

  const result = await getRecovery(config, { connector: connector as never, address: ACCOUNT });

  expect(result).toBe('0xsignature');
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('wallet_getRecovery');
  // Recovery is account-level: the read spans every chain, so there is no
  // chain filter to forward, unlike wallet_getPermissions.
  expect((requests[0].params as [Record<string, unknown>])[0]).toEqual({ address: ACCOUNT });
});

test('setupRecovery forwards the config and never an address or a chainId', async () => {
  const { connector, requests } = fakeConnection();
  const recoveries = [{ commitment: ACCOUNT, delay: 172_800 }];
  const capabilities = { paymasterService: { url: 'https://pm.example' } };

  await setupRecovery(config, {
    connector: connector as never,
    address: ACCOUNT,
    recoveries,
    threshold: 1,
    capabilities,
  });

  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('wallet_setupRecovery');
  // `address` selects which connected account to act as, exactly as in the
  // other actions; the wallet acts as that account on the connected chain, so
  // neither travels in the params.
  expect((requests[0].params as [Record<string, unknown>])[0]).toStrictEqual({
    recoveries,
    threshold: 1,
    capabilities,
  });
});

test('cancelRecovery forwards the request id and never an address', async () => {
  const { connector, requests } = fakeConnection();
  const requestId = `0x${'ab'.repeat(32)}` as const;

  await cancelRecovery(config, { connector: connector as never, address: ACCOUNT, requestId });

  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('wallet_cancelRecovery');
  expect((requests[0].params as [Record<string, unknown>])[0]).toEqual({ requestId, capabilities: undefined });
});

// ============================================================================
// Recovery ceremony: startRecovery, getRecoveryStatus, approveRecovery
// ============================================================================

// anvil's third default key
const GUARDIAN = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const SUBJECT = `0x${'44'.repeat(64)}` as const;
const SALT = `0x${'22'.repeat(32)}` as const;
const REQUEST_ID = computeRequestId(ACCOUNT, SUBJECT, SALT);
const WALLET_ANSWER = { from: 'the wallet' };

/** A wagmi connector whose provider records what it is asked */
function recordingConnector(id: string, address: Hex, answer: (args: EIP1193Parameters) => unknown) {
  const requests: EIP1193Parameters[] = [];
  const connectorFn = createConnector(
    () =>
      ({
        id,
        name: id,
        type: id,
        getAccounts: async () => [address],
        // On Arbitrum: nothing in a ceremony is chain-bound.
        getChainId: async () => arbitrum.id,
        getProvider: async () => ({
          request: async (args: EIP1193Parameters) => {
            requests.push(args);
            return answer(args);
          },
        }),
      }) as never
  ) as CreateConnectorFn;
  return { connectorFn, requests };
}

/** A config holding the JAW connector and an injected-style wallet, neither connected */
function ceremonyConfig() {
  const jaw = recordingConnector('jaw', ACCOUNT, () => WALLET_ANSWER);
  // The guardian's wallet signs for real what it is asked to sign.
  const wallet = recordingConnector('injected', GUARDIAN.address, (args) => {
    if (args.method !== 'eth_signTypedData_v4') throw new Error(`unexpected ${args.method}`);
    const [, typedData] = args.params as [Hex, string];
    return GUARDIAN.signTypedData(JSON.parse(typedData));
  });
  const ceremonyConfig = createConfig({
    chains: [mainnet, arbitrum],
    connectors: [jaw.connectorFn, wallet.connectorFn],
    transports: { [mainnet.id]: http(), [arbitrum.id]: http() },
  });
  const [jawConnector, walletConnector] = ceremonyConfig.connectors;

  /** Records the connector as wagmi's connect action does */
  const connect = (connector: typeof jawConnector) =>
    ceremonyConfig.setState((x) => ({
      ...x,
      connections: new Map(x.connections).set(connector.uid, {
        accounts: [connector.id === 'jaw' ? ACCOUNT : GUARDIAN.address],
        chainId: arbitrum.id,
        connector,
      }),
      current: connector.uid,
      status: 'connected',
    }));

  return {
    config: ceremonyConfig,
    jaw: { connector: jawConnector, requests: jaw.requests },
    wallet: { connector: walletConnector, requests: wallet.requests },
    connect,
  };
}

test('startRecovery asks the JAW provider with no connection', async () => {
  const { config, jaw, wallet } = ceremonyConfig();

  await expect(startRecovery(config, { account: ACCOUNT })).resolves.toBe(WALLET_ANSWER);
  await expect(startRecovery(config)).resolves.toBe(WALLET_ANSWER);

  expect(jaw.requests).toEqual([
    { method: 'wallet_startRecovery', params: [{ account: ACCOUNT }] },
    { method: 'wallet_startRecovery', params: [{ account: undefined }] },
  ]);
  expect(wallet.requests).toEqual([]);
});

test('startRecovery and getRecoveryStatus go to JAW even when another wallet is connected', async () => {
  const { config, jaw, wallet, connect } = ceremonyConfig();
  connect(wallet.connector);

  await startRecovery(config, { account: ACCOUNT });
  await getRecoveryStatus(config, { requestId: REQUEST_ID });

  // Only the JAW wallet serves these methods.
  expect(jaw.requests.map((r) => r.method)).toEqual(['wallet_startRecovery', 'wallet_getRecoveryStatus']);
  expect(wallet.requests).toEqual([]);
});

test('getRecoveryStatus reads the request from the JAW provider, connected or not', async () => {
  const { config, jaw, connect } = ceremonyConfig();

  await expect(getRecoveryStatus(config, { requestId: REQUEST_ID })).resolves.toBe(WALLET_ANSWER);
  connect(jaw.connector);
  await expect(getRecoveryStatus(config, { requestId: REQUEST_ID })).resolves.toBe(WALLET_ANSWER);

  expect(jaw.requests).toEqual([
    { method: 'wallet_getRecoveryStatus', params: [{ requestId: REQUEST_ID }] },
    { method: 'wallet_getRecoveryStatus', params: [{ requestId: REQUEST_ID }] },
  ]);
});

test('approveRecovery asks the JAW provider, connected or not, and nothing else', async () => {
  const { config, jaw, wallet, connect } = ceremonyConfig();

  // The JAW wallet signs the guardian in itself, so no connection is needed.
  await expect(approveRecovery(config, { requestId: REQUEST_ID })).resolves.toBe(WALLET_ANSWER);
  connect(jaw.connector);
  await expect(approveRecovery(config, { requestId: REQUEST_ID })).resolves.toBe(WALLET_ANSWER);

  expect(jaw.requests).toEqual([
    { method: 'wallet_approveRecovery', params: [{ requestId: REQUEST_ID }] },
    { method: 'wallet_approveRecovery', params: [{ requestId: REQUEST_ID }] },
  ]);
  expect(wallet.requests).toEqual([]);
});

describe('approveRecovery with a wallet other than JAW', () => {
  const API_KEY = 'app-api-key';
  const APPROVAL = { collected: 1, threshold: 2, queued: false };
  const ceremony: Ceremony = {
    requestId: REQUEST_ID,
    account: ACCOUNT,
    subject: SUBJECT,
    salt: SALT,
    expiry: '2030-01-01T00:00:00.000Z',
    createdAt: '2029-12-31T00:00:00.000Z',
    threshold: 2,
    collected: 0,
    guardians: [
      {
        recoveryId: computeRecoveryId(ACCOUNT, SIGNATURE_RECOVERY_PROVIDER_ADDRESS, toOwnerBytes(GUARDIAN.address)),
        provider: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
        commitment: toOwnerBytes(GUARDIAN.address),
        delay: 60,
        approvedAt: null,
      },
    ],
    chains: [],
  };

  // The recovery backend, at the network edge: core's own client runs unchanged.
  const original = axios.defaults.adapter;
  let sent: InternalAxiosRequestConfig[];

  beforeEach(() => {
    sent = [];
    const backend: AxiosAdapter = async (request) => {
      sent.push(request);
      const reply = (data: unknown) => ({
        data: { result: { data, error: null } },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: request,
      });
      if (request.method === 'get' && request.url === `/recovery/v2/ceremonies/${REQUEST_ID}`) return reply(ceremony);
      if (request.method === 'post' && request.url === `/recovery/v2/ceremonies/${REQUEST_ID}/approvals`) {
        return reply(APPROVAL);
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    axios.defaults.adapter = backend;
  });

  afterEach(() => {
    axios.defaults.adapter = original;
  });

  test('the connected wallet signs the ceremony typed data and the proof is posted with the key', async () => {
    const { config, jaw, wallet, connect } = ceremonyConfig();
    connect(wallet.connector);

    await expect(approveRecovery(config, { requestId: REQUEST_ID, apiKey: API_KEY })).resolves.toEqual(APPROVAL);

    // One signature, by the guardian's address, and nothing asked of JAW.
    expect(jaw.requests).toEqual([]);
    expect(wallet.requests.map((r) => r.method)).toEqual(['eth_signTypedData_v4']);
    expect((wallet.requests[0].params as [Hex, string])[0].toLowerCase()).toBe(GUARDIAN.address.toLowerCase());

    const approval = sent.find((request) => request.method === 'post');
    expect(approval?.headers['x-api-key']).toBe(API_KEY);
    const body = JSON.parse(approval?.data as string) as { recoveryId: Hex; proof: Hex };
    expect(body.recoveryId).toBe(ceremony.guardians[0].recoveryId);
    // The proof recovers to the guardian over core's Recover typed data for this
    // ceremony, so that is exactly what the wallet was asked to sign.
    const signer = await recoverTypedDataAddress({
      ...recoverTypedData({ account: ACCOUNT, subject: SUBJECT, salt: SALT, expiry: ceremony.expiry }),
      signature: body.proof,
    });
    expect(signer).toBe(GUARDIAN.address);
  });

  test('without an apiKey it throws before anything is read or signed', async () => {
    const { config, wallet, connect } = ceremonyConfig();
    connect(wallet.connector);

    await expect(approveRecovery(config, { requestId: REQUEST_ID })).rejects.toThrow(
      'approveRecovery: apiKey is required to approve with a wallet other than JAW'
    );
    expect(wallet.requests).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('a wallet given but not connected is refused before anything is read or signed', async () => {
    const { config, wallet } = ceremonyConfig();
    const disconnected = { ...wallet.connector, getAccounts: async () => [] };

    await expect(
      approveRecovery(config, { requestId: REQUEST_ID, connector: disconnected as never, apiKey: API_KEY })
    ).rejects.toThrow(ConnectorNotConnectedError);
    expect(wallet.requests).toEqual([]);
    expect(sent).toEqual([]);
  });
});

test('getRecoveryStatusQueryKey carries only the request id', () => {
  expect(getRecoveryStatusQueryKey({ requestId: REQUEST_ID })).toEqual(['recoveryStatus', { requestId: REQUEST_ID }]);
  expect(getRecoveryStatusQueryKey({})).toEqual(['recoveryStatus', { requestId: undefined }]);
});
