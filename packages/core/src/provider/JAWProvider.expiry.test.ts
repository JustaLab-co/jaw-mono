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
import { standardErrorCodes, standardErrors } from '../errors/index.js';
import { UIError, type UIHandler, type UIRequest } from '../ui/interface.js';

vi.mock('../communicator/index.js');

const ACCOUNT = '0x1234567890123456789012345678901234567890';
const PAST_TTL_MS = 2 * 86400 * 1000;

function approve(request: UIRequest) {
    if (request.type === 'wallet_connect') {
        return { id: request.id, approved: true, data: { accounts: [{ address: ACCOUNT }] } };
    }
    return { id: request.id, approved: true, data: '0x5167' };
}

let uiHandler: UIHandler & { request: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn> };

/** Keeps every later dialog open until the test answers it, in any order.
 *  Called with an error, the dialog refuses with it instead of approving. */
function holdDialogs(): Array<(error?: unknown) => void> {
    const open: Array<(error?: unknown) => void> = [];
    uiHandler.request.mockImplementation(
        (request: UIRequest) =>
            new Promise((resolve) =>
                open.push((error) => resolve(error ? { id: request.id, approved: false, error } : approve(request)))
            )
    );
    return open;
}

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

function countConnects(provider: JAWProvider): () => number {
    let count = 0;
    provider.on('connect', () => count++);
    return () => count;
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
    uiHandler = { request: vi.fn(async (request: UIRequest) => approve(request)), cleanup: vi.fn() } as never;
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
    // read issued meanwhile drops the signer. Approving must reinstate it and
    // tell the dapp, whose listeners went away with the earlier disconnect.
    it.each(['eth_requestAccounts', 'wallet_connect'])(
        'keeps the session a %s reconnect established while a parallel read ran',
        async (method) => {
            const provider = await expiredSession();
            const dialogs = holdDialogs();

            const reconnect = provider.request({ method, params: method === 'wallet_connect' ? [{}] : undefined });
            await vi.waitFor(() => expect(dialogs).toHaveLength(1));
            await provider.request({ method: 'eth_chainId' });
            const connects = countConnects(provider);
            dialogs[0]();

            await expect(reconnect).resolves.toBeDefined();
            expect(connects()).toBe(1);
            await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([ACCOUNT]);
            expect(loadSignerType()).toBe('appSpecific');
        }
    );

    // A disconnect is the user's call, and a dialog that outlived it must not
    // bring the session back.
    it.each([
        ['disconnect()', (provider: JAWProvider) => provider.disconnect()],
        ['wallet_disconnect', (provider: JAWProvider) => provider.request({ method: 'wallet_disconnect' })],
    ])('stays disconnected after %s during the reconnect dialog', async (_name, disconnect) => {
        const provider = await expiredSession();
        const dialogs = holdDialogs();

        const reconnect = provider.request({ method: 'eth_requestAccounts' });
        await vi.waitFor(() => expect(dialogs).toHaveLength(1));
        await provider.request({ method: 'eth_chainId' });
        await disconnect(provider);
        dialogs[0]();
        await reconnect;

        await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([]);
        expect(loadSignerType()).toBeNull();
    });

    it('reports an expired session once when the dapp disconnects', async () => {
        const provider = await expiredSession();
        await provider.request({ method: 'eth_accounts' });
        const events = recordEvents(provider);

        await provider.request({ method: 'wallet_disconnect' });

        expect(events).toEqual([['accountsChanged', []], ['disconnect']]);
    });

    it('cleans up the dropped signer on disconnect', async () => {
        const provider = await expiredSession();
        await provider.request({ method: 'eth_accounts' });
        await provider.request({ method: 'eth_chainId' });

        await provider.disconnect();

        expect(uiHandler.cleanup).toHaveBeenCalled();
    });

    // Only a connect re-establishes a session. A signature that completes after
    // the expiry was reported must not quietly reconnect the dapp.
    it('does not reinstate the session when a signing request outlives the expiry', async () => {
        const provider = await expiredSession();
        const dialogs = holdDialogs();

        const signing = provider.request({ method: 'personal_sign', params: ['0x68', ACCOUNT] });
        await vi.waitFor(() => expect(dialogs).toHaveLength(1));
        await provider.request({ method: 'eth_accounts' });
        await provider.request({ method: 'eth_chainId' });
        dialogs[0]();

        await expect(signing).resolves.toBe('0x5167');
        await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([]);
    });

    // A second connect that finished first owns the session. The older dialog
    // approving afterwards must not replace it or announce it again.
    it('does not overwrite a newer session with the dropped signer', async () => {
        const provider = await expiredSession();
        const dialogs = holdDialogs();

        const stale = provider.request({ method: 'eth_requestAccounts' });
        await vi.waitFor(() => expect(dialogs).toHaveLength(1));
        const fresh = provider.request({ method: 'eth_requestAccounts' });
        await vi.waitFor(() => expect(dialogs).toHaveLength(2));
        dialogs[1]();
        await fresh;
        const connects = countConnects(provider);
        dialogs[0]();
        await stale;

        expect(connects()).toBe(0);
    });

    // The signature was asked for on the signer the guard has since dropped
    // and reported. Its late 4100 speaks for that dead session, not for the
    // provider's current state, so it must not log out or report again.
    it('ignores a late 4100 from a request on the dropped signer', async () => {
        const provider = await expiredSession();
        const dialogs = holdDialogs();
        const events = recordEvents(provider);

        const signing = provider.request({ method: 'personal_sign', params: ['0x68', ACCOUNT] });
        await vi.waitFor(() => expect(dialogs).toHaveLength(1));
        await provider.request({ method: 'eth_accounts' });
        await provider.request({ method: 'eth_chainId' });
        dialogs[0](standardErrors.provider.unauthorized());

        await expect(signing).rejects.toMatchObject({ code: standardErrorCodes.provider.unauthorized });
        expect(events).toEqual([['accountsChanged', []], ['disconnect']]);
        expect(new PasskeyManager().fetchActiveCredentialId()).toBe('credential-id');
    });
});

describe('backend refusals', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function refuseFetch() {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 403, ok: false, text: async () => 'no' }));
    }

    // The refusal travels through the real signer, so this fails if anything
    // on the way wraps the error and loses the marker.
    it('keeps a live session when the backend refuses a read', async () => {
        const provider = newProvider();
        await provider.request({ method: 'eth_requestAccounts' });
        const events = recordEvents(provider);
        refuseFetch();

        await expect(provider.request({ method: 'wallet_getCapabilities', params: [ACCOUNT] })).rejects.toMatchObject({
            code: standardErrorCodes.provider.unauthorized,
        });

        expect(events).toEqual([]);
        await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([ACCOUNT]);
    });

    // A refused read does not check expiry, so the session it went through
    // looks live to the catch. Tearing it down there would log the passkey out;
    // the expiry has to be left for the next request to report.
    it('leaves an expired session to the expiry report when the backend refuses a read', async () => {
        const provider = await expiredSession();
        const events = recordEvents(provider);
        refuseFetch();

        await expect(provider.request({ method: 'wallet_getCapabilities', params: [] })).rejects.toMatchObject({
            code: standardErrorCodes.provider.unauthorized,
        });
        await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([]);
        await provider.request({ method: 'eth_chainId' });

        expect(events).toEqual([['accountsChanged', []], ['disconnect']]);
        expect(new PasskeyManager().fetchActiveCredentialId()).toBe('credential-id');
        expect(vi.mocked(Communicator).prototype.disconnect).not.toHaveBeenCalled();
    });
});

describe('a throwaway signer settling after a real connect', () => {
    // The throwaway signer's cleanup clears the stored account and signer type
    // for the whole page. A connect that finished while its dialog was open
    // owns those now, and must still be connected afterwards.
    it.each([
        ['approved', undefined],
        ['refused', UIError.userRejected()],
    ])('keeps the new session when the signature is %s', async (_outcome, refusal) => {
        const provider = newProvider();
        const events = recordEvents(provider);
        const dialogs = holdDialogs();

        const signing = provider.request({
            method: 'wallet_sign',
            params: [{ request: { type: '0x45', data: { message: 'hi' } } }],
        });
        await vi.waitFor(() => expect(dialogs).toHaveLength(1));
        dialogs[0]();
        await vi.waitFor(() => expect(dialogs).toHaveLength(2));

        const connect = provider.request({ method: 'eth_requestAccounts' });
        await vi.waitFor(() => expect(dialogs).toHaveLength(3));
        dialogs[2]();
        await connect;
        dialogs[1](refusal);
        await signing.catch(() => undefined);

        await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([ACCOUNT]);
        expect(loadSignerType()).toBe('appSpecific');
        expect(events.filter(([name]) => name === 'disconnect')).toEqual([]);
    });
});
