// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { consentTypedData } from '@jaw.id/agent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const signTypedData = vi.fn(async (_typedData: unknown) => '0xsig');
const get = vi.fn(async (_config: unknown) => ({ signTypedData }));
vi.mock('@jaw.id/core', () => ({ Account: { get: (config: unknown) => get(config) } }));
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
  typedData: consentTypedData(84532, {
    issuer: MCP,
    interaction: 'uid_1234567890\u202Etxt',
    clientId: 'https://evil.example/c.json',
    clientName: '<img src=x onerror=alert(1)>',
    scopes: 'wallet:read',
    expires: '2026-10-06T12:10:00.000Z',
  }),
};

let root: Root;
let container: HTMLDivElement;
const posts: { url: string; body: unknown }[] = [];
let details: Omit<typeof DETAILS, 'client'> & { client: ClientIdentity } = DETAILS;
const assign = vi.fn();

beforeEach(() => {
  posts.length = 0;
  details = DETAILS;
  signTypedData.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/cli-key') return Response.json({ apiKey: 'agent-key' });
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ next: `${MCP}/interaction/uid_1234567890/complete?ticket=t` });
      }
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

const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());

describe('AuthorizeScreen', () => {
  it('renders every signed field as inert text and signs exactly that typed data', async () => {
    await render();
    const shown = [...container.querySelectorAll('[data-testid="consent-message"] dd')].map((d) => d.textContent);
    expect(shown).toEqual([...Object.values(DETAILS.typedData.message), '84532']);
    expect(container.querySelector('img')).toBeNull();

    await click(container.querySelector('#login'));
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Connect'));

    expect(get).toHaveBeenCalledWith({ chainId: 84532, apiKey: 'agent-key' });
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(signTypedData.mock.calls[0][0]).toEqual(DETAILS.typedData);
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
});
