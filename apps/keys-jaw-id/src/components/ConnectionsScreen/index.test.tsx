// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const signTypedData = vi.fn(async (_typedData: unknown) => '0xsig');
const chain = { id: 84532, rpcUrl: 'https://rpc.example' };
const signer = { signTypedData, getChain: () => chain };
const get = vi.fn(async (_config: unknown) => signer);
vi.mock('@jaw.id/core', () => ({
  Account: { get: (config: unknown) => get(config) },
  standardErrorCodes: { provider: { userRejectedRequest: 4001 } },
}));
vi.mock('@jaw.id/ui', async () => ({ PortalContainerContext: (await import('react')).createContext(null) }));
type ModalProps = {
  permissionRequest: { method: string; params: unknown[] };
  onSuccess: (result: unknown) => Promise<void>;
  onError: (error: Error, code: number) => void;
};
let modal: ModalProps | null = null;
vi.mock('../PermissionModal', () => ({
  PermissionModal: (props: ModalProps) => {
    modal = props;
    return createElement('div', { id: 'permission-modal' });
  },
}));
const OWNER = '0x1111111111111111111111111111111111111111';
vi.mock('../OnboardingSection', () => ({
  SignInScreen: ({ onComplete }: { onComplete: (a: unknown) => void }) =>
    createElement('button', { id: 'login', onClick: () => onComplete({ address: OWNER }) }, 'login'),
}));

const { ConnectionsScreen } = await import('./index');

const MCP = 'https://mcp.jaw.id';
const PAYER = '0x4444444444444444444444444444444444444444';
const PERMISSION = `0x${'cd'.repeat(32)}`;
const ACTIVE = {
  id: 'conn_1',
  status: 'active',
  chainId: 84532,
  client: {
    clientId: 'https://agent.example/client.json',
    name: 'JAW Wallet',
    host: 'agent.example',
    official: false,
    reservedName: true,
  },
  scopes: ['wallet:read', 'wallet:send'],
  createdAt: '2026-10-07T10:00:00.000Z',
  expiresAt: '2026-11-06T10:00:00.000Z',
  revokedAt: null,
  payer: PAYER,
  float: '70000',
  budgets: [
    {
      permissionId: PERMISSION,
      allowance: '1000000',
      period: 'day',
      expiresAt: '2026-11-06T10:00:00.000Z',
      state: 'active',
    },
  ],
  events: [
    { tool: 'jaw_pay_and_fetch', outcome: 'ok', requestId: 'r1', at: '2026-10-07T11:00:00.000Z' },
    { tool: 'jaw_status', outcome: 'error', requestId: 'r2', at: '2026-10-07T10:59:00.000Z' },
  ],
};
const REVOKED = {
  ...ACTIVE,
  status: 'revoked',
  revokedAt: '2026-10-07T12:00:00.000Z',
  budgets: [{ ...ACTIVE.budgets[0], state: 'revoke_on_chain' }],
};

let listed: object[] = [];
let expired = false;
let posts: { url: string; body: Record<string, unknown> }[] = [];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  listed = [ACTIVE];
  expired = false;
  posts = [];
  modal = null;
  signTypedData.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/cli-key') return Response.json({ apiKey: 'agent-key' });
      if (url === `${MCP}/api/connections` && init?.method !== 'POST') {
        return Response.json({ issuer: MCP, chainId: 84532 });
      }
      const body = JSON.parse(String(init?.body));
      posts.push({ url, body });
      if (expired) return Response.json({ error: 'invalid_request' }, { status: 400 });
      if (url.endsWith('/revoke')) {
        listed = [REVOKED];
        return Response.json(REVOKED);
      }
      return Response.json(listed);
    })
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(ConnectionsScreen, { mcpUrl: MCP })));
  });
  await settle();
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
const click = async (el: Element | null | undefined) => {
  await act(async () => (el as HTMLElement).click());
  await settle();
};

async function signIn() {
  await render();
  await click(container.querySelector('#login'));
}

describe('ConnectionsScreen', () => {
  it('signs in with a JAW sign-in for this server, valid ten minutes, and lists with that proof', async () => {
    const before = Date.now();
    await signIn();
    expect(get).toHaveBeenCalledWith({ chainId: 84532, apiKey: 'agent-key' });
    const typed = signTypedData.mock.calls[0][0] as {
      domain: { name: string };
      primaryType: string;
      message: { issuer: string; expires: string };
    };
    expect(typed.domain.name).toBe('JAW');
    expect(typed.primaryType).toBe('ConnectionsSignIn');
    expect(typed.message.issuer).toBe(MCP);
    const ahead = new Date(typed.message.expires).getTime() - before;
    expect(ahead).toBeGreaterThanOrEqual(9 * 60_000);
    expect(ahead).toBeLessThanOrEqual(11 * 60_000);
    expect(posts).toEqual([
      {
        url: `${MCP}/api/connections`,
        body: { account: OWNER, chainId: 84532, expires: typed.message.expires, signature: '0xsig' },
      },
    ]);
  });

  it('names the client by its domain first, and shows scopes, budget, float and recent events', async () => {
    await signIn();
    const text = container.textContent ?? '';
    expect(container.querySelector('h2')?.textContent).toContain('agent.example');
    expect(text).toContain('Calls itself "JAW Wallet"');
    expect(text).toContain('"JAW Wallet" is not a JAW app');
    expect(text).toContain('wallet:read, wallet:send');
    expect(text).toContain('1 USDC per day');
    expect(text).toContain('0.07 USDC');
    expect(text).toContain('jaw_pay_and_fetch');
    expect(text).toContain('jaw_status');
  });

  it('warns that the float stays behind, then revokes on the server and opens the on-chain revoke', async () => {
    await signIn();
    await click(button('Revoke'));
    expect(container.textContent).toContain('0.07 USDC in its payer');
    expect(container.textContent).toContain('jaw_disconnect');
    expect(posts.filter((p) => p.url.endsWith('/revoke'))).toEqual([]);

    await click(button('Revoke anyway'));
    expect(posts.at(-1)).toMatchObject({ url: `${MCP}/api/connections/conn_1/revoke`, body: { account: OWNER } });
    expect(modal?.permissionRequest).toEqual({
      method: 'wallet_revokePermissions',
      params: [{ id: PERMISSION, address: OWNER }],
    });

    listed = [{ ...REVOKED, budgets: [{ ...ACTIVE.budgets[0], state: 'revoked' }] }];
    await act(async () => modal?.onSuccess({}));
    await settle();
    expect(posts.at(-1)?.url).toBe(`${MCP}/api/connections`);
    expect(container.textContent).toContain('Revoked');
    expect(container.textContent).toContain('0.07 USDC is left in the payer');
    expect(button('Revoke on chain')).toBeUndefined();
  });

  it('keeps a budget the chain still shows approved listed with a retry', async () => {
    listed = [REVOKED];
    await signIn();
    expect(container.textContent).toContain('Still approved on chain');
    await click(button('Revoke on chain'));
    expect(modal?.permissionRequest.params).toEqual([{ id: PERMISSION, address: OWNER }]);
  });

  it('warns about the float even when it could not be read', async () => {
    listed = [{ ...ACTIVE, float: null }];
    await signIn();
    await click(button('Revoke'));
    expect(container.textContent).toContain('could not be read');
    expect(container.textContent).toContain('jaw_disconnect');
  });

  it('asks to sign in again when the sign-in expired on a refresh of the list', async () => {
    listed = [REVOKED];
    await signIn();
    await click(button('Revoke on chain'));
    expired = true;
    await act(async () => modal?.onSuccess({}));
    await settle();
    expect(container.querySelector('#login')).not.toBeNull();
    expect(container.textContent).toContain('Your sign-in expired');
  });

  it('opens the next budget still approved on chain after one is revoked', async () => {
    const SECOND = `0x${'ef'.repeat(32)}`;
    const both = [
      { ...ACTIVE.budgets[0], state: 'revoke_on_chain' },
      { ...ACTIVE.budgets[0], permissionId: SECOND, state: 'revoke_on_chain' },
    ];
    listed = [{ ...REVOKED, budgets: both }];
    await signIn();
    await click(button('Revoke on chain'));
    expect(modal?.permissionRequest.params).toEqual([{ id: PERMISSION, address: OWNER }]);
    listed = [{ ...REVOKED, budgets: [{ ...both[0], state: 'revoked' }, both[1]] }];
    await act(async () => modal?.onSuccess({}));
    await settle();
    expect(modal?.permissionRequest.params).toEqual([{ id: SECOND, address: OWNER }]);
  });
});
