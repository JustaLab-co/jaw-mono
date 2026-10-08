// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { rejectionTypedData } from '@jaw.id/agent/reserved';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const signMessage = vi.fn(async (_message: string) => '0xsig');
const signTypedData = vi.fn(async (_typedData: unknown) => '0xsig');
const CALLS_ID = `0x${'c1'.repeat(32)}`;
const sendCalls = vi.fn(async (..._args: unknown[]) => ({ id: CALLS_ID, chainId: 84532 }));
const chain = { id: 84532, rpcUrl: 'https://rpc.example' };
const signer = { signMessage, signTypedData, sendCalls, getChain: () => chain };
const get = vi.fn(async (_config: unknown) => signer);
let signedInAs = '';
vi.mock('@jaw.id/core', () => ({
  Account: { get: (config: unknown) => get(config) },
  jawPaymasterUrl: (chainId: number, apiKey?: string) => `https://paymaster.example/${chainId}/${apiKey}`,
  standardErrorCodes: { provider: { userRejectedRequest: 4001 } },
}));
vi.mock('@jaw.id/ui', async () => ({ PortalContainerContext: (await import('react')).createContext(null) }));
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
  reject: {
    type: 'typed_data',
    typedData: rejectionTypedData(84532, 'q3L0x7mJ2c1VfN8aYw4p9A'),
  },
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

const PAY_TO = '0x2222222222222222222222222222222222222222';
const TRANSFER = {
  domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: OWNER,
    to: PAY_TO,
    value: '10000',
    validAfter: '0',
    validBefore: '1791374400',
    nonce: `0x${'11'.repeat(32)}`,
  },
};
const PAYMENT_VIEW = {
  ...VIEW,
  preview: {
    kind: 'payment',
    requester: VIEW.preview.requester,
    account: OWNER,
    chainId: 84532,
    payTo: PAY_TO,
    token: USDC,
    amount: '10000',
    network: 'eip155:84532',
    resource: 'https://seller.example/report',
    warnings: [],
    validUntil: '2026-10-07T14:40:00.000Z',
  },
  approve: { type: 'typed_data', typedData: TRANSFER },
};

let root: Root;
let container: HTMLDivElement;
let posts: unknown[];

let view: object = VIEW;
let refusals: string[] = [];
let decided: object = {};
let postAnswer: object | null = null;

beforeEach(() => {
  view = VIEW;
  posts = [];
  refusals = [];
  decided = {};
  postAnswer = null;
  modal = null;
  signMessage.mockClear();
  signTypedData.mockClear();
  sendCalls.mockClear();
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
        return Response.json(postAnswer ?? { ...view, status: body.verdict, ...decided });
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

  const OLD = `0x${'ee'.repeat(32)}`;
  const APPROVED = { ...BUDGET_VIEW, status: 'approved' };

  it('revokes every budget the server lists at the decision, right after granting', async () => {
    view = BUDGET_VIEW;
    postAnswer = { ...APPROVED, revoke: [OLD] };
    await render();
    await click(container.querySelector('#login'));
    await click(button('Approve'));
    await act(async () => modal!.onSuccess(GRANTED));
    await settle();
    expect(posts).toHaveLength(1);
    expect(modal!.permissionRequest).toEqual({
      method: 'wallet_revokePermissions',
      params: [{ id: OLD, address: OWNER }],
    });
    expect(modal!.account).toBe(signer);
    expect(container.textContent).not.toContain('Approved.');
    view = { ...APPROVED, revoke: [] };
    await act(async () => modal!.onSuccess({ success: true }));
    await settle();
    expect(container.textContent).toContain('Approved.');
  });

  it('says a dismissed revoke left the previous budget live, and retries it', async () => {
    view = BUDGET_VIEW;
    postAnswer = { ...APPROVED, revoke: [OLD] };
    await render();
    await click(container.querySelector('#login'));
    await click(button('Approve'));
    await act(async () => modal!.onSuccess(GRANTED));
    await settle();
    await act(async () => modal!.onError(new Error('User rejected the request'), 4001));
    await settle();
    expect(container.textContent).toContain('still approved on chain');
    modal = null;
    await click(button('Retry revoke'));
    expect(modal!.permissionRequest).toEqual({
      method: 'wallet_revokePermissions',
      params: [{ id: OLD, address: OWNER }],
    });
  });

  it('offers the outstanding revoke again on an approved budget page', async () => {
    view = { ...APPROVED, revoke: [OLD] };
    await render();
    expect(container.textContent).toContain('still approved on chain');
    await click(container.querySelector('#login'));
    await click(button('Retry revoke'));
    expect(modal!.permissionRequest).toEqual({
      method: 'wallet_revokePermissions',
      params: [{ id: OLD, address: OWNER }],
    });
  });

  it('moves on to the next outstanding revoke once the chain shows the first one gone', async () => {
    const OLDER = `0x${'dd'.repeat(32)}`;
    view = BUDGET_VIEW;
    postAnswer = { ...APPROVED, revoke: [OLDER, OLD] };
    await render();
    await click(container.querySelector('#login'));
    await click(button('Approve'));
    await act(async () => modal!.onSuccess(GRANTED));
    await settle();
    view = { ...APPROVED, revoke: [OLD] };
    await act(async () => modal!.onSuccess({ success: true }));
    await settle();
    expect(container.textContent).not.toContain('does not show');
    expect(container.querySelector('#permission-modal')).not.toBeNull();
    expect(modal!.permissionRequest).toEqual({
      method: 'wallet_revokePermissions',
      params: [{ id: OLD, address: OWNER }],
    });
  });

  it('offers the outstanding revoke only to the account that granted the budget', async () => {
    signedInAs = '0x3333333333333333333333333333333333333333';
    view = { ...APPROVED, revoke: [OLD] };
    await render();
    await click(container.querySelector('#login'));
    expect(button('Retry revoke')).toBeUndefined();
    expect(container.textContent).toContain('This request is for');
  });

  it('renders the wallet dialog inside the JAW UI scope, so it is styled and centered', async () => {
    view = BUDGET_VIEW;
    await render();
    await click(container.querySelector('#login'));
    await click(button('Approve'));
    expect(container.querySelector('#permission-modal')!.closest('[data-jaw-ui]')).not.toBeNull();
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
    expect(signTypedData.mock.calls[0][0]).toEqual(VIEW.reject.typedData);
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

  it('shows the payment terms from the server preview and signs the served transfer by reference', async () => {
    view = PAYMENT_VIEW;
    decided = { payment: { state: 'signed', kind: 'paid', code: null } };
    await render();
    expect(container.querySelector('h1')!.textContent).toBe('Payment request from evil.example');
    expect(container.textContent).toContain('0.01 USDC');
    expect(container.textContent).toContain(`To: ${PAY_TO}`);
    expect(container.textContent).toContain('For: https://seller.example/report');
    expect(container.textContent).toContain('eip155:84532');

    await click(container.querySelector('#login'));
    await click(button('Approve'));
    expect(signMessage).not.toHaveBeenCalled();
    expect(signTypedData.mock.calls[0][0]).toBe(TRANSFER);
    expect(posts).toEqual([{ verdict: 'approved', signature: '0xsig', previewHash: VIEW.previewHash }]);
    expect(container.textContent).toContain('Paid.');
  });

  it('says nothing was sent when the price moved before the approval', async () => {
    view = PAYMENT_VIEW;
    decided = { payment: { state: 'failed', kind: 'refused', code: 'price_changed' } };
    await render();
    await click(container.querySelector('#login'));
    await click(button('Approve'));
    expect(container.textContent).toContain('the price changed');
    expect(container.textContent).toContain('Nothing was sent.');
  });

  describe('transfers and calls', () => {
    const SPENDER = '0x5555555555555555555555555555555555555555';
    const TRANSFER_DATA = `0xa9059cbb${'0'.repeat(24)}${PAY_TO.slice(2)}${(10000).toString(16).padStart(64, '0')}`;
    const CALLS = [{ to: USDC, value: '0x0', data: TRANSFER_DATA }];
    const PAYMASTER = { token: USDC, gas: '90000' };
    const GAS = { token: USDC, estimate: '21000', max: '90000' };
    const TRANSFER_VIEW = {
      ...VIEW,
      preview: {
        kind: 'transfer',
        requester: VIEW.preview.requester,
        to: PAY_TO,
        name: 'alice.eth',
        token: USDC,
        amount: '10000',
        gas: GAS,
      },
      approve: { type: 'calls', calls: CALLS, chainId: '0x14a34' },
      paymaster: PAYMASTER,
    };
    const CALLS_VIEW = {
      ...TRANSFER_VIEW,
      preview: {
        kind: 'calls',
        requester: VIEW.preview.requester,
        calls: [
          {
            to: USDC,
            value: '0x0',
            data: '0x095ea7b3',
            function: 'approve(address,uint256)',
            args: [
              { name: 'spender', type: 'address', value: SPENDER },
              {
                name: 'amount',
                type: 'uint256',
                value: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
              },
            ],
            warnings: [{ code: 'token_approval', spender: SPENDER, amount: '1157', unlimited: true }],
          },
          { to: PAY_TO, value: '0xde0b6b3a7640000', data: '0xdeadbeef', warnings: [{ code: 'unknown_function' }] },
          { to: PAY_TO, value: '0x0', data: '0xdead', warnings: [{ code: 'short_calldata' }] },
        ],
        gas: GAS,
      },
    };

    it('shows the name beside the address, the amount and the gas in USDC', async () => {
      view = TRANSFER_VIEW;
      await render();
      expect(container.querySelector('h1')?.textContent).toBe('Transfer request from evil.example');
      expect(container.textContent).toContain('Send 0.01 USDC');
      expect(container.textContent).toContain('alice.eth');
      expect(container.textContent).toContain(PAY_TO);
      expect(container.textContent).toContain('about 0.021 USDC, at most 0.09 USDC');
    });

    it('sends the served calls by reference through the ERC-20 paymaster and posts the calls id', async () => {
      view = TRANSFER_VIEW;
      await render();
      await click(container.querySelector('#login'));
      await click(button('Approve'));
      expect(sendCalls).toHaveBeenCalledTimes(1);
      const [calls, options, paymasterUrl, context] = sendCalls.mock.calls[0];
      expect(calls).toBe(CALLS);
      expect(options).toBeUndefined();
      expect(paymasterUrl).toBe('https://paymaster.example/84532/agent-key');
      expect(context).toBe(PAYMASTER);
      expect(signMessage).not.toHaveBeenCalled();
      expect(signTypedData).not.toHaveBeenCalled();
      expect(posts).toEqual([{ verdict: 'approved', callsId: CALLS_ID, previewHash: VIEW.previewHash }]);
      expect(container.textContent).toContain('Approved.');
    });

    it('waits for the calls to land, and never sends twice when the server still cannot see them', async () => {
      view = TRANSFER_VIEW;
      refusals = Array.from({ length: 15 }, () => 'calls_pending');
      await render();
      await click(container.querySelector('#login'));
      vi.useFakeTimers();
      try {
        await act(async () => {
          button('Approve')?.click();
          await vi.runAllTimersAsync();
        });
      } finally {
        vi.useRealTimers();
      }
      expect(posts).toHaveLength(15);
      expect(container.textContent).toContain('not on chain yet');
      await click(button('Check again'));
      expect(sendCalls).toHaveBeenCalledTimes(1);
      expect(posts).toHaveLength(16);
      expect(container.textContent).toContain('Approved.');
    });

    it('shows each call decoded or raw, with its warnings', async () => {
      view = CALLS_VIEW;
      await render();
      expect(container.querySelector('h1')?.textContent).toBe('Transaction request from evil.example');
      expect(container.textContent).toContain('approve(address,uint256)');
      expect(container.textContent).toContain(`Lets ${SPENDER} spend an unlimited amount`);
      expect(container.textContent).toContain('0xdeadbeef');
      expect(container.textContent).toContain('No known function matches this call');
      expect(container.textContent).toContain('shorter than a function selector');
      expect(container.textContent).toContain('Sends 1 ETH');
    });
  });

  describe('typed data and Sign in with Ethereum', () => {
    const TYPED = {
      domain: { name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: USDC },
      types: { Permit: [{ name: 'spender', type: 'address' }] },
      primaryType: 'Permit',
      message: { spender: PAY_TO },
    };
    const TYPED_VIEW = {
      ...VIEW,
      preview: {
        kind: 'typed-data',
        requester: VIEW.preview.requester,
        domain: '{"name":"USD Coin"}',
        primaryType: 'Permit',
        message: `{"spender":"${PAY_TO}"}`,
        warnings: ['token_permit', 'chain_mismatch'],
      },
      approve: { type: 'typed_data', typedData: TYPED },
    };
    const LOGIN = 'app.example wants you to sign in with your Ethereum account:\n...';
    const SIWE_VIEW = {
      ...VIEW,
      preview: {
        kind: 'siwe',
        requester: VIEW.preview.requester,
        account: OWNER,
        domain: 'app.example',
        uri: 'https://app.example/login',
        statement: 'Log in',
        nonce: 'n0nce1234',
        issuedAt: '2026-10-07T12:00:00.000Z',
        expirationTime: null,
        warnings: ['siwe_login'],
      },
      approve: { type: 'message', message: LOGIN },
    };

    it('shows the typed data as served with its warnings and signs it by reference', async () => {
      view = TYPED_VIEW;
      await render();
      expect(container.querySelector('h1')?.textContent).toBe('Typed data request from evil.example');
      expect(container.textContent).toContain('{"spender":"');
      expect(container.textContent).toContain('can let someone move your tokens');
      expect(container.textContent).toContain('another chain');
      await click(container.querySelector('#login'));
      await click(button('Approve'));
      expect(signTypedData.mock.calls[0][0]).toBe(TYPED);
      expect(posts).toEqual([{ verdict: 'approved', signature: '0xsig', previewHash: VIEW.previewHash }]);
    });

    it('warns which site a login is for and signs the served message', async () => {
      view = SIWE_VIEW;
      await render();
      expect(container.querySelector('h1')?.textContent).toBe('Sign-in request from evil.example');
      expect(container.textContent).toContain(`logs the agent into app.example as ${OWNER}`);
      expect(container.textContent).toContain('https://app.example/login');
      await click(container.querySelector('#login'));
      await click(button('Approve'));
      expect(signMessage.mock.calls[0][0]).toBe(LOGIN);
      expect(posts).toEqual([{ verdict: 'approved', signature: '0xsig', previewHash: VIEW.previewHash }]);
    });
  });
});
