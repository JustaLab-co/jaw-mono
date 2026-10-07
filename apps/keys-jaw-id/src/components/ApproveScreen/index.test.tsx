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
let signedInAs = '';
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
  reject: { type: 'message', message: 'JAW approval request q3L0x7mJ2c1VfN8aYw4p9A: reject' },
};

const SESSION = '0x4444444444444444444444444444444444444444';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const GRANT = {
  address: OWNER,
  spender: SESSION,
  expiry: 1790000000,
  chainId: 84532,
  permissions: {
    calls: [{ target: USDC, functionSignature: 'transfer(address,uint256)' }],
    spends: [{ token: USDC, allowance: '5000000', unit: 'day', multiplier: 1 }],
  },
  capabilities: { prefundSpender: true },
};
const BUDGET_VIEW = {
  ...VIEW,
  preview: {
    kind: 'budget',
    requester: VIEW.preview.requester,
    account: OWNER,
    chainId: 84532,
    spender: SESSION,
    token: USDC,
    allowance: '5000000',
    period: 'day',
    expiresAt: '2026-09-21T09:46:40.000Z',
  },
  approve: { type: 'grant', grant: GRANT },
};
const GRANTED = {
  account: OWNER,
  spender: SESSION,
  start: 1780000000,
  end: 1790000000,
  salt: '0x01',
  calls: [{ target: USDC, selector: '0xa9059cbb' }],
  spends: [{ token: USDC, allowance: '5000000', unit: 'day', multiplier: 1 }],
  permissionId: `0x${'cd'.repeat(32)}`,
  chainId: '0x14a34',
};

let root: Root;
let container: HTMLDivElement;
let posts: unknown[];

let view: object = VIEW;
let refusals: string[] = [];

beforeEach(() => {
  view = VIEW;
  posts = [];
  refusals = [];
  modal = null;
  signMessage.mockClear();
  signedInAs = OWNER;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/cli-key') return Response.json({ apiKey: 'agent-key' });
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        const refusal = refusals.shift();
        if (refusal) return Response.json({ error: refusal }, { status: 409 });
        return Response.json({ ...view, status: body.verdict });
      }
      return { ok: true, json: async () => view } as Response;
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
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
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

  it('signs the stored rejection statement to reject', async () => {
    await render();
    await click(container.querySelector('#login'));
    await click(button('Reject'));
    expect(signMessage.mock.calls[0][0]).toBe(VIEW.reject.message);
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

  it('hands the served grant to the wallet by reference and posts the granted permission unmodified', async () => {
    view = BUDGET_VIEW;
    await render();
    expect(container.querySelector('h1')!.textContent).toBe('Budget request from evil.example');
    expect(container.textContent).toContain('5 USDC per day');
    expect(container.textContent).toContain(`Spender: ${SESSION}`);

    await click(container.querySelector('#login'));
    await click(button('Approve'));
    expect(modal!.permissionRequest).toEqual({ method: 'wallet_grantPermissions', params: [GRANT] });
    expect(modal!.permissionRequest.params[0]).toBe(GRANT);
    expect(modal!.account).toBe(signer);
    expect(modal!.chain).toBe(chain);
    expect(signMessage).not.toHaveBeenCalled();

    await act(async () => modal!.onSuccess(GRANTED));
    await settle();
    expect(posts).toEqual([{ verdict: 'approved', previewHash: VIEW.previewHash, permission: GRANTED }]);
    expect(container.textContent).toContain('Approved.');
  });

  it('retries a grant the chain does not show yet before giving up', async () => {
    view = BUDGET_VIEW;
    refusals = ['grant_not_found', 'grant_not_found'];
    await render();
    await click(container.querySelector('#login'));
    await click(button('Approve'));
    vi.useFakeTimers();
    try {
      await act(async () => {
        modal!.onSuccess(GRANTED);
        await vi.advanceTimersByTimeAsync(4000);
        await vi.runAllTimersAsync();
      });
    } finally {
      vi.useRealTimers();
    }
    expect(posts).toHaveLength(3);
    expect(posts[2]).toEqual(posts[0]);
    expect(container.textContent).toContain('Approved.');
  });

  it('says a grant the server refuses does not match the request', async () => {
    view = BUDGET_VIEW;
    refusals = ['grant_mismatch'];
    await render();
    await click(container.querySelector('#login'));
    await click(button('Approve'));
    await act(async () => modal!.onSuccess(GRANTED));
    expect(posts).toHaveLength(1);
    expect(container.textContent).toContain('does not match this request');
  });

  it('signs the stored rejection statement to reject a budget', async () => {
    view = BUDGET_VIEW;
    await render();
    await click(container.querySelector('#login'));
    await click(button('Reject'));
    expect(modal).toBeNull();
    expect(signMessage.mock.calls[0][0]).toBe(VIEW.reject.message);
    expect(posts).toEqual([{ verdict: 'rejected', signature: '0xsig', previewHash: VIEW.previewHash }]);
  });

  it('returns to the request when the wallet dialog is cancelled', async () => {
    view = BUDGET_VIEW;
    await render();
    await click(container.querySelector('#login'));
    await click(button('Approve'));
    await act(async () => modal!.onError(new Error('User rejected the request'), 4001));
    expect(container.querySelector('#permission-modal')).toBeNull();
    expect(button('Reject')).toBeDefined();
    expect(posts).toEqual([]);
  });
});
