/**
 * Session expiry inside a page, driven through the real AppSpecificSigner and
 * the real store, so the signer's own expiry checks decide when the stored
 * account goes away. Only the transport is mocked, and AppSpecific does not
 * use it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { JAWProvider } from './JAWProvider.js';
import { Communicator } from '../communicator/index.js';
import { Mode } from './interface.js';
import { store } from '../store/index.js';
import { loadSignerType, clearSignerType } from '../signer/index.js';
import { PasskeyManager } from '../passkey-manager/index.js';
import { standardErrorCodes } from '../errors/index.js';
import { UIError, type UIHandler, type UIRequest } from '../ui/interface.js';

vi.mock('../communicator/index.js');

const ACCOUNT = '0x1234567890123456789012345678901234567890';
const PAST_TTL_MS = 2 * 86400 * 1000;

function approveConnect(request: UIRequest) {
    if (request.type !== 'wallet_connect') throw new Error(`unexpected ${request.type}`);
    return { id: request.id, approved: true, data: { accounts: [{ address: ACCOUNT }] } };
}

let uiHandler: UIHandler & { request: ReturnType<typeof vi.fn> };

function newProvider(): JAWProvider {
    return new JAWProvider({
        metadata: { appName: 'Expiry', appLogoUrl: 'https://test.example/logo.png', defaultChainId: 1 },
        preference: { mode: Mode.AppSpecific, uiHandler },
        apiKey: 'test-api-key',
    });
}

function recordEvents(provider: JAWProvider): unknown[][] {
    const events: unknown[][] = [];
    provider.on('accountsChanged', (accounts) => events.push(['accountsChanged', accounts]));
    provider.on('disconnect', () => events.push(['disconnect']));
    return events;
}

/** Connects, then moves the clock past the default auth TTL. */
async function expiredSession(): Promise<JAWProvider> {
    const provider = newProvider();
    await provider.request({ method: 'eth_requestAccounts' });
    vi.setSystemTime(Date.now() + PAST_TTL_MS);
    return provider;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    store.account.clear();
    clearSignerType();
    new PasskeyManager().storeAuthState(ACCOUNT, 'credential-id');
    uiHandler = { request: vi.fn(async (request: UIRequest) => approveConnect(request)) } as never;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('session expiry inside a page', () => {
    // A library that polls eth_accounts, or authTTL 0, sees the expiry before
    // any signing request does. The dapp still shows the account until the
    // provider tells it otherwise.
    it('reports the session gone on the request after eth_accounts noticed the expiry', async () => {
        const provider = await expiredSession();
        const events = recordEvents(provider);

        await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([]);
        await expect(provider.request({ method: 'personal_sign', params: ['0x68', ACCOUNT] })).rejects.toMatchObject({
            code: standardErrorCodes.provider.unauthorized,
        });

        expect(events).toEqual([['accountsChanged', []], ['disconnect']]);
        // Reported, not logged out: the passkey is kept for the reconnect.
        expect(new PasskeyManager().fetchActiveCredentialId()).toBe('credential-id');
        expect(vi.mocked(Communicator).prototype.disconnect).not.toHaveBeenCalled();
    });

    // wallet_connect on an expired session drops the cached account before it
    // asks the user again, so a declined re-sign leaves nothing connected.
    it('reports the session gone after a declined reconnect', async () => {
        const provider = await expiredSession();
        const events = recordEvents(provider);
        uiHandler.request.mockResolvedValueOnce({ id: 'x', approved: false, error: UIError.userRejected() });

        await expect(provider.request({ method: 'wallet_connect', params: [{}] })).rejects.toBeDefined();
        await expect(provider.request({ method: 'eth_chainId' })).resolves.toBe('0x1');

        expect(events).toEqual([['accountsChanged', []], ['disconnect']]);
        expect(new PasskeyManager().fetchActiveCredentialId()).toBe('credential-id');
    });

    // The reconnect dialog clears the stored account while it is open, so a
    // read issued meanwhile drops the signer. Approving must reinstate it.
    it('keeps the session a reconnect established while a parallel read ran', async () => {
        const provider = await expiredSession();
        let approve: () => void = () => undefined;
        uiHandler.request.mockImplementationOnce(
            (request: UIRequest) => new Promise((resolve) => (approve = () => resolve(approveConnect(request))))
        );

        const reconnect = provider.request({ method: 'eth_requestAccounts' });
        await vi.waitFor(() => expect(uiHandler.request).toHaveBeenCalledTimes(2));
        await provider.request({ method: 'eth_chainId' });
        approve();

        await expect(reconnect).resolves.toEqual([ACCOUNT]);
        await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([ACCOUNT]);
        expect(loadSignerType()).toBe('appSpecific');
    });
});
