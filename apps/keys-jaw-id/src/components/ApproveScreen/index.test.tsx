// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { rejectionTypedData } from '@jaw.id/agent/reserved';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const signMessage = vi.fn(async (_message: string) => '0xsig');
const signTypedData = vi.fn(async (_typedData: unknown) => '0xsig');
const get = vi.fn(async (_config: unknown) => ({ signMessage, signTypedData }));
let signedInAs = '';
vi.mock('@jaw.id/core', () => ({ Account: { get: (config: unknown) => get(config) } }));
vi.mock('../OnboardingSection', () => ({
  SignInScreen: ({ onComplete }: { onComplete: (a: unknown) => void }) =>
    createElement('button', { id: 'login', onClick: () => onComplete({ address: signedInAs }) }, 'login'),
}));

const { ApproveScreen } = await import('./index');

const OWNER = '0x1111111111111111111111111111111111111111';
const MCP = 'https://mcp.jaw.id';
const STORED = 'Pay to: 0x2222222222222222222222222222222222222222\n<b>bold</b> 1 USDC\u202E0001';
const VIEW = {
  id: 'q3L0x7mJ2c1VfN8aYw4p9A',
  status: 'pending',
  account: OWNER,
  chainId: 84532,
  expiresAt: '2026-10-06T12:10:00.000Z',
  preview: {
    kind: 'signature',
    requester: {
      clientId: 'https://evil.example/client.json',
      name: '<script>x</script>',
      host: 'evil.example',
      official: false,
      reservedName: false,
    },
    text: 'Pay to: 0x2222222222222222222222222222222222222222\n<b>bold</b> 1 USDC⟦U+202E⟧0001',
    warnings: ['hidden_characters', 'address_like', 'markup_like'],
  },
  previewHash: `0x${'ab'.repeat(32)}`,
  approve: { type: 'message', message: STORED },
  reject: {
    type: 'typed_data',
    typedData: rejectionTypedData(84532, 'q3L0x7mJ2c1VfN8aYw4p9A'),
  },
};

let root: Root;
let container: HTMLDivElement;
let posts: unknown[];

let view: typeof VIEW = VIEW;

beforeEach(() => {
  view = VIEW;
  posts = [];
  signMessage.mockClear();
  signTypedData.mockClear();
  signedInAs = OWNER;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/cli-key') return Response.json({ apiKey: 'agent-key' });
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return Response.json({ ...VIEW, status: body.verdict });
      }
      return Response.json(view);
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
    root.render(
      createElement(QueryClientProvider, { client }, createElement(ApproveScreen, { id: VIEW.id, mcpUrl: MCP }))
    );
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
}

const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());

describe('ApproveScreen', () => {
  it('renders the server preview as inert text with its warnings', async () => {
    await render();
    expect(container.querySelector('[data-testid="approval-message"]')!.textContent).toBe(VIEW.preview.text);
    expect(container.querySelector('b, script')).toBeNull();
    expect(container.textContent).toContain('hidden or direction-changing characters');
    expect(container.textContent).toContain('<script>x</script>');
  });

  it('signs the stored payload exactly as received and posts only verdict, signature and preview hash', async () => {
    await render();
    await click(container.querySelector('#login'));
    await click(button('Approve'));
    expect(get).toHaveBeenCalledWith({ chainId: 84532, apiKey: 'agent-key' });
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(signMessage.mock.calls[0][0]).toBe(STORED);
    expect(posts).toEqual([{ verdict: 'approved', signature: '0xsig', previewHash: VIEW.previewHash }]);
    expect(container.textContent).toContain('Approved.');
  });

  it('signs the stored rejection typed data to reject', async () => {
    await render();
    await click(container.querySelector('#login'));
    await click(button('Reject'));
    expect(signMessage).not.toHaveBeenCalled();
    expect(signTypedData.mock.calls[0][0]).toEqual(VIEW.reject.typedData);
    expect(posts).toEqual([{ verdict: 'rejected', signature: '0xsig', previewHash: VIEW.previewHash }]);
  });

  it('names the requester by its domain and warns when it calls itself JAW', async () => {
    view = {
      ...VIEW,
      preview: { ...VIEW.preview, requester: { ...VIEW.preview.requester, name: 'JAW CLI', reservedName: true } },
    };
    await render();
    expect(container.querySelector('h1')!.textContent).toBe('Signature request from evil.example');
    expect(container.textContent).toContain('Calls itself "JAW CLI"');
    expect(container.textContent).toContain('is not a JAW app');
  });

  it('offers no decision to another account', async () => {
    signedInAs = '0x3333333333333333333333333333333333333333';
    await render();
    await click(container.querySelector('#login'));
    expect(button('Approve')).toBeUndefined();
    expect(button('Reject')).toBeUndefined();
    expect(container.textContent).toContain('This request is for');
    expect(signMessage).not.toHaveBeenCalled();
  });
});
