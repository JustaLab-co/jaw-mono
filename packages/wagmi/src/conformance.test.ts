// @vitest-environment jsdom
/**
 * wagmi conformance against a real @jaw.id/core.
 *
 * Connector.test.ts and connect-shape.test.ts replace the provider with a stub,
 * so they pin what the connector does with an answer, not whether core still
 * gives that answer. Here nothing in core is mocked: `JAW.create` builds the
 * real provider, signer, store and error module in AppSpecific mode. The only
 * stand-in is the person, a `UIHandler` that approves or rejects the way the
 * dialogs would. A change in core that moves an event, an error code or a
 * response shape fails here, and Nx affected runs this file on every core
 * change because the vitest config resolves core to its source.
 *
 * Expected values come from the standards both sides agree on, not from running
 * the code: EIP-1193 events and error codes (4001, 4200), EIP-3326 for an
 * unknown chain (4902), and wagmi's connection state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mode, type UIRequest, type UIResponse } from '@jaw.id/core';
import { getAddress, UserRejectedRequestError } from 'viem';
import { base, mainnet, sepolia } from 'viem/chains';

// Lowercase on purpose: the wallet may answer in any casing, the dapp must
// always see a checksummed address.
const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';

type Answer = (request: UIRequest) => UIResponse;

/** Stands in for the person looking at the dialog. */
const user = { seen: [] as UIRequest[], answer: signInAs(ALICE) };

function signInAs(address: string): Answer {
  return (request) => ({
    id: request.id,
    approved: true,
    data: { accounts: [{ address, capabilities: {} }] },
  });
}

const refuse: Answer = (request) => ({ id: request.id, approved: false });

type Provider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): void;
};

/**
 * A fresh page load: new module instances, so core only knows what it
 * rehydrates from localStorage.
 */
async function openPage(preference: { authTTL?: number } = {}) {
  vi.resetModules();
  const wagmi = await import('@wagmi/core');
  const { jaw } = await import('./lib/Connector.js');

  const config = wagmi.createConfig({
    chains: [base, mainnet, sepolia],
    connectors: [
      jaw({
        apiKey: 'test-api-key',
        defaultChainId: base.id,
        preference: {
          ...preference,
          mode: Mode.AppSpecific,
          uiHandler: {
            request: async <T>(request: UIRequest) => {
              user.seen.push(request);
              return user.answer(request) as UIResponse<T>;
            },
          },
        },
      }),
    ],
    transports: { [base.id]: wagmi.http(), [mainnet.id]: wagmi.http(), [sepolia.id]: wagmi.http() },
  });
  const connector = config.connectors[0];
  const provider = (await connector.getProvider()) as Provider;
  return { wagmi, config, connector, provider };
}

type Page = Awaited<ReturnType<typeof openPage>>;

async function connected(preference?: { authTTL?: number }): Promise<Page> {
  const page = await openPage(preference);
  await page.wagmi.connect(page.config, { connector: page.connector });
  return page;
}

/** What the dapp reads from wagmi is what core holds. */
async function expectInSync({ wagmi, config, provider }: Page, address: string, chainId: number) {
  const connection = wagmi.getConnection(config);
  expect(connection.status).toBe('connected');
  expect(connection.address).toBe(getAddress(address));
  expect(connection.chainId).toBe(chainId);

  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  expect(accounts.map((a) => getAddress(a))).toEqual([getAddress(address)]);
  expect(await provider.request({ method: 'eth_chainId' })).toBe(`0x${chainId.toString(16)}`);
}

async function expectDisconnected({ wagmi, config, provider }: Page) {
  expect(wagmi.getConnection(config).status).toBe('disconnected');
  expect(await provider.request({ method: 'eth_accounts' })).toEqual([]);
}

beforeEach(() => {
  localStorage.clear();
  user.seen = [];
  user.answer = signInAs(ALICE);
  // The provider builds a Communicator even in AppSpecific, and it fetches the
  // trusted hosts list. Nothing here depends on it, and CI must stay offline.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wagmi conformance against a real core', () => {
  describe('connect', () => {
    it('puts wagmi and core on the same account and chain', async () => {
      const page = await openPage();
      const result = await page.wagmi.connect(page.config, { connector: page.connector });

      expect(result).toEqual({ accounts: [getAddress(ALICE)], chainId: base.id });
      await expectInSync(page, ALICE, base.id);
    });

    it('lands both sides on the chain the dapp asked for', async () => {
      const page = await openPage();
      await page.wagmi.connect(page.config, { connector: page.connector, chainId: mainnet.id });

      await expectInSync(page, ALICE, mainnet.id);
    });

    it('reaches the dapp as 4001 when the user refuses, and stays disconnected', async () => {
      user.answer = refuse;
      const page = await openPage();

      await expect(page.wagmi.connect(page.config, { connector: page.connector })).rejects.toMatchObject({
        code: 4001,
      });
      await expectDisconnected(page);
    });

    // Known gap in the connector. Its catch means to rethrow a refusal as
    // viem's UserRejectedRequestError, as wagmi's own connectors do, but it
    // matches on the message and core says "User rejected the request", which
    // none of its patterns cover. The dapp gets core's plain serialized error:
    // `code` survives, `name` and `instanceof` checks do not. Turn this into a
    // plain `it` once the connector matches on the code.
    it.fails('reaches the dapp as the UserRejectedRequestError wagmi dapps check for', async () => {
      user.answer = refuse;
      const page = await openPage();

      await expect(page.wagmi.connect(page.config, { connector: page.connector })).rejects.toBeInstanceOf(
        UserRejectedRequestError
      );
    });
  });

  describe('reconnect', () => {
    it('restores the session after a reload without asking the user', async () => {
      await connected();
      const asked = user.seen.length;

      const reloaded = await openPage();
      await reloaded.wagmi.reconnect(reloaded.config);

      await expectInSync(reloaded, ALICE, base.id);
      expect(user.seen).toHaveLength(asked);
    });

    async function reloadExpired() {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        await connected({ authTTL: 60 });
        vi.setSystemTime(Date.now() + 61_000);
        const reloaded = await openPage({ authTTL: 60 });
        await reloaded.wagmi.reconnect(reloaded.config);
        return reloaded;
      } finally {
        vi.useRealTimers();
      }
    }

    it('reloads an expired session as disconnected, still without asking', async () => {
      const reloaded = await reloadExpired();

      expect(reloaded.wagmi.getConnection(reloaded.config).status).toBe('disconnected');
      // Only the sign-in from before the reload.
      expect(user.seen).toHaveLength(1);
    });

    // Known gap in core. The expiry check empties the restored signer's
    // accounts but keeps the signer, so the next silent read falls through to
    // handleUnauthenticatedRequest and is refused with 4100 instead of
    // answering []. Turn this into a plain `it` once core is fixed.
    it.fails('keeps answering eth_accounts with [] after the expiry', async () => {
      const reloaded = await reloadExpired();

      expect(await reloaded.provider.request({ method: 'eth_accounts' })).toEqual([]);
    });
  });

  describe('disconnect', () => {
    it('clears both sides, and the session does not come back on reload', async () => {
      const page = await connected();
      await page.wagmi.disconnect(page.config);
      await expectDisconnected(page);

      const reloaded = await openPage();
      await reloaded.wagmi.reconnect(reloaded.config);
      await expectDisconnected(reloaded);
    });

    it('reaches wagmi when the wallet side ends the session', async () => {
      const page = await connected();
      await page.provider.request({ method: 'wallet_disconnect' });

      await expectDisconnected(page);
    });
  });

  describe('switchChain', () => {
    it('moves core and wagmi together', async () => {
      const page = await connected();
      const chain = await page.wagmi.switchChain(page.config, { chainId: mainnet.id });

      expect(chain.id).toBe(mainnet.id);
      await expectInSync(page, ALICE, mainnet.id);
    });

    it('speaks hex chain ids on the wire, both ways', async () => {
      const page = await connected();
      // Pass-through spy: core still answers, the test only reads the request.
      const request = vi.spyOn(page.provider, 'request');
      const emitted: unknown[] = [];
      page.provider.on('chainChanged', (chainId) => emitted.push(chainId));

      await page.wagmi.switchChain(page.config, { chainId: mainnet.id });

      // EIP-3326 takes a hex chainId; core also accepts a number, so only the
      // request itself shows what the connector sent.
      expect(request).toHaveBeenCalledWith({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
      // EIP-1193 chainChanged carries a hex string. The connector's Number()
      // would hide a number here, other dapps reading the provider would not.
      expect(emitted).toEqual(['0x1']);
    });

    it('refuses a chain core does not support with 4902, and nothing moves', async () => {
      // Sepolia is configured in wagmi but is a testnet, which core only
      // offers with preference.showTestnets.
      const page = await connected();

      await expect(page.wagmi.switchChain(page.config, { chainId: sepolia.id })).rejects.toMatchObject({
        code: 4902,
      });
      await expectInSync(page, ALICE, base.id);
    });

    it('reaches wagmi when the switch goes straight to the provider', async () => {
      const page = await connected();
      await page.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });

      await expectInSync(page, ALICE, mainnet.id);
    });
  });

  describe('account change', () => {
    it('moves wagmi to the account the user signs in with next', async () => {
      const page = await connected();
      user.answer = signInAs(BOB);

      // A fresh wallet_connect with capabilities always reaches the user, the
      // way a dapp asks for a new SIWE signature.
      await page.provider.request({
        method: 'wallet_connect',
        params: [{ capabilities: { signInWithEthereum: { nonce: 'abcdef12', chainId: '0x2105' } } }],
      });

      await expectInSync(page, BOB, base.id);
    });
  });

  describe('errors on requests', () => {
    it('a refused signature reaches the dapp as 4001', async () => {
      const page = await connected();
      user.answer = refuse;

      await expect(page.wagmi.signMessage(page.config, { message: 'hello' })).rejects.toMatchObject({ code: 4001 });
      // wagmi hex-encodes the message; the dialog must still get the text.
      expect(user.seen.at(-1)).toMatchObject({ type: 'personal_sign', data: { message: 'hello' } });
      await expectInSync(page, ALICE, base.id);
    });

    it('a method core does not offer reaches the dapp as 4200', async () => {
      const page = await connected();
      const client = await page.wagmi.getConnectorClient(page.config);

      await expect(
        client.request({ method: 'eth_sign', params: [getAddress(ALICE), '0x00'] } as never)
      ).rejects.toMatchObject({ code: 4200 });
    });
  });
});
