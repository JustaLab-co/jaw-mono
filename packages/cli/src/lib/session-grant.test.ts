import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parsePermissionsConfig } from '@jaw.id/agent';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const OWNER = '0x1111111111111111111111111111111111111111';
const SESSION = '0x2222222222222222222222222222222222222222';

const h = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  events: [] as string[],
  requests: [] as { method: string; params: unknown }[],
  closes: 0,
  savedKey: null as string | null,
  saved: null as Record<string, unknown> | null,
  injected: null as string | null,
  accountApiKey: undefined as string | undefined,
  ownerBlocked: null as string | null,
  unfunded: null as string | null,
  grantError: null as Error | null,
  grantedChecker: undefined as string | undefined,
  revokeError: null as Error | null,
}));

vi.mock('./config.js', () => ({ loadConfig: () => h.config }));

vi.mock('./keystore.js', () => ({
  generateSessionKey: () => '0x' + '11'.repeat(32),
  saveKeystore: (key: string) => {
    h.savedKey = key;
  },
}));

vi.mock('./session-config.js', () => ({
  saveSessionConfig: (config: Record<string, unknown>) => {
    h.saved = config;
  },
}));

vi.mock('./bridge-singleton.js', () => ({
  getBridge: async () => {
    h.events.push('bridge');
    if (h.injected) h.config.workspaceApiKey = h.injected;
    return {
      request: async (method: string, params: unknown) => {
        h.requests.push({ method, params });
        if (method === 'wallet_grantPermissions') {
          if (h.grantError) throw h.grantError;
          return {
            account: OWNER,
            spender: SESSION,
            start: 1_756_000_000,
            end: 1_756_604_800,
            salt: '0xabc',
            calls: [
              { target: USDC, selector: '0xa9059cbb', ...(h.grantedChecker ? { checker: h.grantedChecker } : {}) },
            ],
            spends: [{ token: USDC, allowance: '0x989680', unit: 'day', multiplier: 1 }],
            permissionId: '0xnew',
            chainId: '0x14a34',
          };
        }
        if (method === 'wallet_revokePermissions' && h.revokeError) throw h.revokeError;
        return {};
      },
      close: () => {
        h.closes += 1;
      },
    };
  },
}));

vi.mock('@jaw.id/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jaw.id/agent')>()),
  whyOwnerCannotFundSession: async () => h.ownerBlocked,
  whySpenderCannotPay: async () => h.unfunded,
}));

vi.mock('@jaw.id/core', () => ({
  Account: {
    fromLocalAccount: async (options: { apiKey?: string }) => {
      h.accountApiKey = options.apiKey;
      return { address: SESSION };
    },
  },
}));

const { grantSession, orphanOf, SessionGrantRefusal } = await import('./session-grant.js');

const permissions = parsePermissionsConfig({
  calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
  spends: [{ token: USDC, allowance: '0x989680', unit: 'day' }],
});

const input = (overrides: Partial<Parameters<typeof grantSession>[0]> = {}) => ({
  chainId: 84532,
  permissions,
  expiryDays: 7,
  x402: true,
  reuseKey: null,
  orphaned: [],
  apiKey: 'k',
  ...overrides,
});

let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  delete process.env.JAW_API_KEY;
  h.config = { apiKey: 'k' };
  h.events = [];
  h.requests = [];
  h.closes = 0;
  h.savedKey = null;
  h.saved = null;
  h.injected = null;
  h.accountApiKey = undefined;
  h.ownerBlocked = null;
  h.unfunded = null;
  h.grantError = null;
  h.grantedChecker = undefined;
  h.revokeError = null;
  stdout = vi.spyOn(process.stdout, 'write');
});

afterEach(() => {
  stdout.mockRestore();
});

describe('grantSession', () => {
  it('builds the account with the key the bridge just wrote, not the one it opened with', async () => {
    h.config = { workspaceApiKey: 'W_old' };
    h.injected = 'W_new';

    await grantSession(input({ apiKey: 'W_old' }));

    expect(h.accountApiKey).toBe('W_new');
  });

  it('prefers the api key flag over config when it re-reads', async () => {
    h.injected = 'W_new';

    await grantSession(input({ apiKeyFlag: 'from-flag' }));

    expect(h.accountApiKey).toBe('from-flag');
  });

  it('grants the session address the permissions and saves what came back', async () => {
    const before = Math.floor(Date.now() / 1000);
    const result = await grantSession(input());

    const grant = h.requests.find((r) => r.method === 'wallet_grantPermissions');
    expect(grant?.params).toEqual([
      {
        spender: SESSION,
        expiry: result.expiry,
        permissions,
        chainId: 84532,
        capabilities: { prefundSpender: true },
      },
    ]);
    expect(result.expiry).toBeGreaterThanOrEqual(before + 7 * 86400);
    expect(result.expiry).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 7 * 86400);
    expect(result).toEqual({
      ownerAddress: OWNER,
      sessionAddress: SESSION,
      permissionId: '0xnew',
      chainId: 84532,
      expiry: result.expiry,
      mode: 'eip7702',
      unfunded: null,
    });
    expect(h.saved).toMatchObject({
      ownerAddress: OWNER,
      sessionAddress: SESSION,
      permissionId: '0xnew',
      chainId: 84532,
      expiry: result.expiry,
      mode: 'eip7702',
    });
  });

  it('stores the permission struct the grant returned', async () => {
    await grantSession(input());

    expect(h.saved?.permission).toMatchObject({ salt: '0xabc', start: 1_756_000_000 });
  });

  it('saves the key it was told to reuse', async () => {
    const reuseKey = `0x${'33'.repeat(32)}` as const;

    await grantSession(input({ reuseKey }));

    expect(h.savedKey).toBe(reuseKey);
  });

  it('carries the orphaned permissions onto the new session', async () => {
    const old = orphanOf({ permissionId: '0xold', chainId: 84532, expiry: 1_800_000_000 });
    expect(old).toEqual({ id: '0xold', chainId: 84532, expiry: 1_800_000_000 });

    await grantSession(input({ orphaned: [old] }));

    expect(h.saved?.orphanedPermissions).toEqual([old]);
  });

  it('leaves orphanedPermissions out when there are none', async () => {
    await grantSession(input());

    expect(h.saved).not.toHaveProperty('orphanedPermissions');
  });

  it('calls onBrowser before the bridge opens', async () => {
    await grantSession(input({ onBrowser: () => h.events.push('hint') }));

    expect(h.events).toEqual(['hint', 'bridge']);
  });

  it('returns why the spender cannot pay under x402', async () => {
    h.unfunded = 'the session holds no USDC';

    const result = await grantSession(input());

    expect(result.unfunded).toBe('the session holds no USDC');
  });

  it('skips both funding checks without x402', async () => {
    h.ownerBlocked = 'owner has no USDC';
    h.unfunded = 'the session holds no USDC';

    const result = await grantSession(input({ x402: false }));

    expect(result.unfunded).toBeNull();
    expect(h.saved?.permissionId).toBe('0xnew');
  });

  it('closes the bridge on the way out of a grant that worked', async () => {
    await grantSession(input());

    expect(h.closes).toBe(1);
  });

  it('refuses with no api key, and closes the bridge without granting', async () => {
    h.config = {};

    const run = grantSession(input({ apiKey: undefined }));

    await expect(run).rejects.toBeInstanceOf(SessionGrantRefusal);
    await expect(run).rejects.toThrow(
      'Connected, but no API key came back and none is configured. ' +
        'Set one with `jaw config set apiKey <key>` and run this again.'
    );
    expect(h.closes).toBe(1);
    expect(h.requests).toEqual([]);
    expect(h.saved).toBeNull();
    expect(h.savedKey).toBeNull();
  });

  it('refuses when the owner cannot fund the session, and closes the bridge without granting', async () => {
    h.ownerBlocked = 'owner has no USDC';

    const run = grantSession(input());

    await expect(run).rejects.toBeInstanceOf(SessionGrantRefusal);
    await expect(run).rejects.toThrow('owner has no USDC');
    expect(h.closes).toBe(1);
    expect(h.requests.map((r) => r.method)).not.toContain('wallet_grantPermissions');
    expect(h.saved).toBeNull();
  });

  it('closes the bridge and passes the error through when the grant fails', async () => {
    h.grantError = new Error('User rejected the request');

    const run = grantSession(input());

    await expect(run).rejects.toThrow('User rejected the request');
    await expect(run).rejects.not.toBeInstanceOf(SessionGrantRefusal);
    expect(h.closes).toBe(1);
    expect(h.saved).toBeNull();
    expect(h.savedKey).toBeNull();
  });

  it('writes nothing to stdout', async () => {
    h.unfunded = 'the session holds no USDC';

    await grantSession(input({ orphaned: [{ id: '0xold', chainId: 84532, expiry: null }] }));
    h.config = {};
    await expect(grantSession(input({ apiKey: undefined }))).rejects.toThrow();

    expect(stdout).not.toHaveBeenCalled();
  });
});

// A wallet from before checkers grants a checked call with the zero checker: a wider rule than the
// one asked for, which must not become the session.
describe('grantSession and a dropped checker', () => {
  const CHECKER = '0x398b9d939E7E616E03eA99601c835C920621B2ca';
  const checked = parsePermissionsConfig({
    calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)', checker: CHECKER }],
  });
  const revokes = () => h.requests.filter((r) => r.method === 'wallet_revokePermissions');

  it('saves the session when the checker came back', async () => {
    h.grantedChecker = CHECKER;

    await grantSession(input({ permissions: checked }));

    expect(revokes()).toEqual([]);
    expect(h.saved?.permissionId).toBe('0xnew');
  });

  it('revokes the new permission and saves nothing when the checker did not come back', async () => {
    const failure = await grantSession(input({ permissions: checked })).catch((err: Error) => err);

    expect(failure).toBeInstanceOf(SessionGrantRefusal);
    expect((failure as Error).message).toContain(CHECKER);
    expect((failure as Error).message).toMatch(/revoked/);
    expect(revokes()).toEqual([{ method: 'wallet_revokePermissions', params: [{ id: '0xnew' }] }]);
    expect(h.saved).toBeNull();
    expect(h.savedKey).toBeNull();
    expect(h.closes).toBe(1);
  });

  it('saves it for `jaw session revoke` to reach, and still fails, when that revoke fails', async () => {
    h.revokeError = new Error('user rejected');

    const failure = await grantSession(input({ permissions: checked })).catch((err: Error) => err);

    expect(failure).toBeInstanceOf(SessionGrantRefusal);
    expect((failure as Error).message).toContain('jaw session revoke');
    expect((failure as Error).message).toContain('user rejected');
    expect(h.saved?.permissionId).toBe('0xnew');
  });
});
