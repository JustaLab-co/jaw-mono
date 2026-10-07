// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const signMessage = vi.fn(async (_message: string) => '0xsig');
const get = vi.fn(async (_config: unknown) => ({ signMessage }));
vi.mock('@jaw.id/core', () => ({ Account: { get: (config: unknown) => get(config) } }));
vi.mock('../OnboardingSection', () => ({
  SignInScreen: ({ onComplete }: { onComplete: (a: unknown) => void }) =>
    createElement('button', { id: 'login', onClick: () => onComplete({ address: OWNER }) }, 'login'),
}));

const { AuthorizeScreen } = await import('./index');

const OWNER = '0x1111111111111111111111111111111111111111';
const MCP = 'https://mcp.jaw.id';
// Hostile text in the client name and a message with a right-to-left override.
const DETAILS = {
  uid: 'uid_1234567890',
  client: {
    id: 'https://evil.example/c.json',
    name: '<img src=x onerror=alert(1)>',
    host: 'evil.example',
    official: false,
  },
  redirectHost: '127.0.0.1',
  scopes: [{ id: 'wallet:read', label: 'See your account, balances and grants' }],
  chainId: 84532,
  expiresAt: '2026-10-06T12:10:00.000Z',
  message: 'JAW connection consent\nApp: <img src=x onerror=alert(1)>\nInteraction: uid_1234567890\u202Etxt',
};

let root: Root;
let container: HTMLDivElement;
const posts: { url: string; body: unknown }[] = [];
const assign = vi.fn();

beforeEach(() => {
  posts.length = 0;
  signMessage.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/cli-key') return Response.json({ apiKey: 'agent-key' });
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ next: `${MCP}/interaction/uid_1234567890/complete?ticket=t` });
      }
      return Response.json(DETAILS);
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
