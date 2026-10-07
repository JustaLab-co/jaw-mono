// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const signMessage = vi.fn(async (_message: string) => '0xsig');
const chain = { id: 84532, rpcUrl: 'https://rpc.example' };
const signer = { signMessage, getChain: () => chain };
const get = vi.fn(async (_config: unknown) => signer);
vi.mock('@jaw.id/core', () => ({
  Account: { get: (config: unknown) => get(config) },
  standardErrorCodes: { provider: { userRejectedRequest: 4001 } },
}));
type ModalProps = {
  permissionRequest: { params: unknown[] };
  account: unknown;
  chain: unknown;
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
vi.mock('../OnboardingSection', () => ({
  SignInScreen: ({ onComplete }: { onComplete: (a: unknown) => void }) =>
    createElement('button', { id: 'login', onClick: () => onComplete({ address: OWNER }) }, 'login'),
}));

const { AuthorizeScreen } = await import('./index');
type ClientIdentity = import('../ClientHeader').ClientIdentity;

const OWNER = '0x1111111111111111111111111111111111111111';
const MCP = 'https://mcp.jaw.id';
const DETAILS = {
  uid: 'uid_1234567890',
  client: {
    clientId: 'https://evil.example/c.json',
    name: '<img src=x onerror=alert(1)>',
    host: 'evil.example',
    official: false,
    reservedName: false,
  },
  redirectHost: '127.0.0.1',
  scopes: [{ id: 'wallet:read', label: 'See your account, balances and grants' }],
  chainId: 84532,
  expiresAt: '2026-10-06T12:10:00.000Z',
  message: 'JAW connection consent\nApp: <img src=x onerror=alert(1)>\nInteraction: uid_1234567890\u202Etxt',
};

const NEXT = `${MCP}/interaction/uid_1234567890/complete?ticket=t`;
const SESSION = '0x4444444444444444444444444444444444444444';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const GRANT = {
  address: OWNER,
  spender: SESSION,
  expiry: 1790000000,
  chainId: 84532,
  permissions: {
    calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
    spends: [{ token: USDC, allowance: '2500000', unit: 'day', multiplier: 1 }],
  },
  capabilities: { prefundSpender: true },
};
const BUDGET_VIEW = {
  id: 'budget_1',
  status: 'pending',
  account: OWNER,
  chainId: 84532,
  expiresAt: '2026-10-06T12:10:00.000Z',
  preview: {
    kind: 'budget',
    requester: DETAILS.client,
    account: OWNER,
    chainId: 84532,
    spender: SESSION,
    token: USDC,
    allowance: '2500000',
    period: 'day',
    expiresAt: '2026-09-21T09:46:40.000Z',
  },
  previewHash: `0x${'ab'.repeat(32)}`,
  approve: { type: 'grant', grant: GRANT },
  reject: { type: 'message', message: 'JAW approval request budget_1: reject' },
};
const GRANTED = {
  account: OWNER,
  spender: SESSION,
  start: 1780000000,
  end: 1790000000,
  salt: '0x01',
  calls: [{ target: USDC, selector: '0xa9059cbb' }],
  spends: [{ token: USDC, allowance: '2500000', unit: 'day', multiplier: 1 }],
  permissionId: `0x${'cd'.repeat(32)}`,
  chainId: '0x14a34',
};

let root: Root;
let container: HTMLDivElement;
const posts: { url: string; body: unknown }[] = [];
let details: Omit<typeof DETAILS, 'client'> & { client: ClientIdentity } = DETAILS;
const assign = vi.fn();

beforeEach(() => {
  posts.length = 0;
  details = DETAILS;
  modal = null;
  signMessage.mockClear();
  assign.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/cli-key') return Response.json({ apiKey: 'agent-key' });
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push({ url, body });
        if (url.endsWith('/decision')) return Response.json({ ...BUDGET_VIEW, status: 'approved' });
        return Response.json(body.budget ? { next: NEXT, budgetRequestId: 'budget_1' } : { next: NEXT });
      }
      if (url === `${MCP}/api/approvals/budget_1`) return Response.json(BUDGET_VIEW);
      return Response.json(details);
    })
  );
  Object.defineProperty(window, 'location', { value: { assign }, configurable: true });
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
    root.render(
      createElement(QueryClientProvider, { client }, createElement(AuthorizeScreen, { uid: DETAILS.uid, mcpUrl: MCP }))
    );
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
const type = (value: string) =>
  act(async () => {
    const input = container.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());

describe('AuthorizeScreen', () => {
  it('renders the stored consent as inert text and signs exactly that string', async () => {
    await render();
    const shown = container.querySelector('[data-testid="consent-message"]')!.textContent;
    expect(shown).toBe(DETAILS.message);
    expect(container.querySelector('img')).toBeNull();

    await click(container.querySelector('#login'));
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Connect'));

    expect(get).toHaveBeenCalledWith({ chainId: 84532, apiKey: 'agent-key' });
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(signMessage.mock.calls[0][0]).toBe(shown);
    expect(posts).toEqual([
      { url: `${MCP}/interaction/uid_1234567890/consent`, body: { address: OWNER, signature: '0xsig' } },
    ]);
    expect(assign).toHaveBeenCalledWith(`${MCP}/interaction/uid_1234567890/complete?ticket=t`);
  });

  it('names a third-party client by its domain and warns when it calls itself JAW', async () => {
    details = { ...DETAILS, client: { ...DETAILS.client, name: 'JAW CLI', reservedName: true } };
    await render();
    expect(container.querySelector('h1')!.textContent).toBe('Connect evil.example');
    expect(container.textContent).toContain('Calls itself "JAW CLI"');
    expect(container.textContent).toContain('is not a JAW app');
    expect(container.textContent).not.toContain('Official JAW client');
  });

  it('labels only the first-party client official', async () => {
    details = {
      ...DETAILS,
      client: { clientId: 'jaw-cli', name: 'JAW CLI', host: null, official: true, reservedName: false },
    };
    await render();
    expect(container.querySelector('h1')!.textContent).toBe('Connect JAW CLI');
    expect(container.textContent).toContain('Official JAW client');
  });

  it('refuses a hand-back to another origin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST' ? Response.json({ next: 'https://evil.example/steal' }) : Response.json(DETAILS)
      )
    );
    assign.mockClear();
    await render();
    await click(container.querySelector('#login'));
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Connect'));
    expect(assign).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Unexpected hand-back address.');
  });

  it('posts a filled daily budget with the consent', async () => {
    await render();
    await type('2.5');
    await click(container.querySelector('#login'));
    await click(button('Connect'));
    expect(posts[0]).toEqual({
      url: `${MCP}/interaction/uid_1234567890/consent`,
      body: { address: OWNER, signature: '0xsig', budget: '2.5' },
    });
  });

  it.each(['0', '0.000000', '1.1234567', '-1', '1e3', '1234567890'])(
    'refuses a daily budget of %s before asking for the passkey',
    async (amount) => {
      await render();
      await type(amount);
      await click(container.querySelector('#login'));
      await click(button('Connect'));
      expect(signMessage).not.toHaveBeenCalled();
      expect(posts).toEqual([]);
      expect(container.textContent).toContain('Enter a daily budget in USDC');
    }
  );

  it('grants the budget before handing back to the app', async () => {
    await render();
    await type('2.5');
    await click(container.querySelector('#login'));
    await click(button('Connect'));
    await settle();
    expect(container.textContent).toContain('2.5 USDC per day');
    expect(modal!.permissionRequest.params[0]).toEqual(GRANT);
    expect(modal!.account).toBe(signer);
    expect(assign).not.toHaveBeenCalled();

    await act(async () => modal!.onSuccess(GRANTED));
    expect(posts[1]).toEqual({
      url: `${MCP}/api/approvals/budget_1/decision`,
      body: { verdict: 'approved', previewHash: BUDGET_VIEW.previewHash, permission: GRANTED },
    });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(NEXT);
  });

  it('hands back without a budget when the user skips it', async () => {
    await render();
    await type('2.5');
    await click(container.querySelector('#login'));
    await click(button('Connect'));
    await settle();
    await act(async () => modal!.onError(new Error('User rejected the request'), 4001));
    expect(container.querySelector('#permission-modal')).toBeNull();
    await click(button('Skip budget'));
    expect(posts.map((p) => p.url)).toEqual([`${MCP}/interaction/uid_1234567890/consent`]);
    expect(assign).toHaveBeenCalledWith(NEXT);
  });
});
