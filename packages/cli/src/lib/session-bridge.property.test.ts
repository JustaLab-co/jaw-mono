/**
 * What the session key sends when an MCP client writes the arguments.
 *
 * Target and selector checks happen in `JustaPermissionManager`, which is
 * audited and out of scope here. What this side owns is narrower and easy to
 * break in a refactor: every autonomous send goes out under the permission the
 * session file names and no other, the calls reach core untouched so the
 * contract judges exactly what was asked, and nothing outside the four session
 * methods touches the account at all.
 *
 * `@jaw.id/core` is replaced by a trap that records what it was handed. The key
 * derivation is real viem.
 */
import fc from 'fast-check';
import { decodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { PERMIT2_ADDRESS } from '../x402/permit2.js';

fc.configureGlobal({ seed: 0x5e55, numRuns: 100 });

const SESSION_KEY = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const SESSION_ADDRESS = privateKeyToAccount(SESSION_KEY).address;
const PERMISSION_ID = '0x' + '77'.repeat(32);
const CHAIN_ID = 84532;
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SUPPORTED = ['eth_requestAccounts', 'eth_accounts', 'wallet_sendCalls', 'wallet_getCallsStatus'];
const hex = (length: number) =>
  fc.string({ unit: fc.constantFrom(...'0123456789abcdef'), minLength: length, maxLength: length });

let expiry = 0;

vi.mock('./keystore.js', () => ({ loadSessionKey: () => SESSION_KEY }));
vi.mock('./config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('./session-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-config.js')>()),
  loadSessionConfig: () => ({
    ownerAddress: '0x1111111111111111111111111111111111111111',
    sessionAddress: SESSION_ADDRESS,
    permissionId: PERMISSION_ID,
    chainId: CHAIN_ID,
    expiry,
    createdAt: '2026-01-01T00:00:00.000Z',
    mode: 'eip7702',
  }),
}));

const sent: unknown[][] = [];
const statusAsked: unknown[] = [];
vi.mock('@jaw.id/core', () => ({
  Account: {
    fromLocalAccount: async (_config: unknown, local: { address: string }) => ({
      address: local.address,
      sendCalls: async (...args: unknown[]) => {
        sent.push(args);
        return { id: '0xbatch', chainId: CHAIN_ID };
      },
      getCallStatus: async (id: unknown) => {
        statusAsked.push(id);
        return { status: 200 };
      },
    }),
  },
}));

const { SessionBridge } = await import('./session-bridge.js');

const newBridge = () => new SessionBridge({ apiKey: 'test', chainId: CHAIN_ID, paymasterUrl: 'https://pm.test' });

/** Payloads an MCP client might send, including ones that try to name a different permission or sender. */
const hostileKeys = fc.record(
  {
    permissionId: fc.oneof(hex(64), fc.constant('0x' + '66'.repeat(32))),
    from: fc.constant('0x2222222222222222222222222222222222222222'),
    chainId: fc.oneof(fc.integer(), fc.string()),
    capabilities: fc.anything(),
  },
  { requiredKeys: [] }
);
const call = fc.record(
  {
    to: fc.oneof(
      hex(40).map((h) => '0x' + h),
      fc.string()
    ),
    value: fc.oneof(fc.constant('0x0'), fc.string()),
    data: fc.oneof(fc.constant('0xa9059cbb'), fc.string()),
    permissionId: fc.constant('0x' + '66'.repeat(32)),
  },
  { requiredKeys: [] }
);
const payload = fc.tuple(hostileKeys, fc.array(call, { maxLength: 4 })).map(([extra, calls]) => ({ ...extra, calls }));
const sendParams = fc.oneof(
  payload,
  payload.map((p) => [p]),
  fc.anything()
);

beforeEach(() => {
  expiry = Math.floor(Date.now() / 1000) + 3600;
  sent.length = 0;
  statusAsked.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('autonomous sends', () => {
  it('always go out under the stored permission, with the calls as given', async () => {
    await fc.assert(
      fc.asyncProperty(sendParams, async (params) => {
        sent.length = 0;
        await newBridge()
          .request('wallet_sendCalls', params)
          .catch(() => undefined);

        expect(sent.length).toBeLessThanOrEqual(1);
        if (sent.length === 0) return;
        const [calls, options, ...rest] = sent[0];
        expect(options).toEqual({ permissionId: PERMISSION_ID });
        // No paymaster override from the payload: the bridge's own resolution is the only one.
        expect(rest).toEqual([]);
        const given = Array.isArray(params) ? params[0] : params;
        expect(calls).toBe((given as { calls: unknown }).calls);
      })
    );
  });

  it('a method outside the session set never reaches the account', async () => {
    // Real wallet method names first: a random string almost never lands next
    // to one of the four, and that is where a loosened check would let one in.
    const method = fc.oneof(
      { weight: 1, arbitrary: fc.string() },
      {
        weight: 3,
        arbitrary: fc.constantFrom(
          'wallet_sendCallsSync',
          'wallet_getCallsStatusV2',
          'wallet_showCallsStatus',
          'wallet_getCapabilities',
          'wallet_switchEthereumChain',
          'wallet_addEthereumChain',
          'wallet_watchAsset',
          'wallet_connect',
          'wallet_disconnect',
          'wallet_getAssets',
          'wallet_getPermissions',
          'wallet_requestPermissions',
          'eth_signTransaction',
          'eth_sign',
          'eth_chainId',
          'eth_call',
          'eth_accounts_',
          'personal_sign',
          'eth_signTypedData_v4',
          'eth_sendTransaction',
          'wallet_sign',
          'wallet_grantPermissions',
          'wallet_revokePermissions',
          'eth_sendRawTransaction',
          'WALLET_SENDCALLS',
          'wallet_sendCalls ',
          '__proto__',
          'constructor'
        ),
      }
    );
    await fc.assert(
      fc.asyncProperty(method, fc.anything(), async (m, params) => {
        fc.pre(!SUPPORTED.includes(m));
        sent.length = 0;
        statusAsked.length = 0;

        await expect(newBridge().request(m, params)).rejects.toThrow();
        expect(sent).toEqual([]);
        expect(statusAsked).toEqual([]);
      })
    );
  });

  it('send in the last second before the expiry and not at it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    expiry = Math.floor(Date.now() / 1000) + 60;
    const bridge = newBridge();

    vi.setSystemTime((expiry - 1) * 1000);
    await bridge.request('wallet_sendCalls', [{ calls: [] }]);
    expect(sent).toHaveLength(1);

    vi.setSystemTime(expiry * 1000);
    await expect(bridge.request('wallet_sendCalls', [{ calls: [] }])).rejects.toThrow(/expired/);
    expect(sent).toHaveLength(1);
  });

  it('stop at the expiry even when the session is already loaded', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 7 * 86_400 }), async (past) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
        expiry = Math.floor(Date.now() / 1000) + 60;
        const bridge = newBridge();
        await bridge.request('eth_accounts');

        vi.setSystemTime(Date.now() + (60 + past) * 1000);
        sent.length = 0;
        await expect(bridge.request('wallet_sendCalls', [{ calls: [] }])).rejects.toThrow(/expired/);
        expect(sent).toEqual([]);
        vi.useRealTimers();
      }),
      { numRuns: 50 }
    );
  });
});

describe('the Permit2 approval, the one send outside the permission', () => {
  it('refuses any token but the registry USDC for the session chain, without sending', async () => {
    const token = fc.oneof(
      hex(40).map((h) => '0x' + h),
      fc.string(),
      fc.constant('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
    );
    await fc.assert(
      fc.asyncProperty(token, async (t) => {
        fc.pre(t.toLowerCase() !== USDC_BASE_SEPOLIA.toLowerCase());
        sent.length = 0;
        await expect(newBridge().approvePermit2(t as `0x${string}`)).rejects.toThrow(/Refusing/);
        expect(sent).toEqual([]);
      })
    );
  });

  it('for USDC in any spelling, approves exactly Permit2 for the maximum, with no permission', async () => {
    const spelling = fc
      .array(fc.boolean(), { minLength: 40, maxLength: 40 })
      .map(
        (upper) =>
          '0x' + [...USDC_BASE_SEPOLIA.slice(2)].map((c, i) => (upper[i] ? c.toUpperCase() : c.toLowerCase())).join('')
      );
    await fc.assert(
      fc.asyncProperty(spelling, async (t) => {
        sent.length = 0;
        await newBridge().approvePermit2(t as `0x${string}`);

        expect(sent).toHaveLength(1);
        const [calls, options] = sent[0] as [Array<{ to: string; data: `0x${string}` }>, unknown];
        expect(options).toBeUndefined();
        expect(calls).toHaveLength(1);
        expect(calls[0].to.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase());
        const decoded = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
        expect(decoded.functionName).toBe('approve');
        expect(decoded.args).toEqual([PERMIT2_ADDRESS, maxUint256]);
      }),
      { numRuns: 50 }
    );
  });
});
