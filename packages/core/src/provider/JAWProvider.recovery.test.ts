/**
 * The recovery ceremony through the provider, driven by the real
 * AppSpecificSigner and the real store. Only the transport, the network and
 * the UI handler are faked, so a request takes the path a dapp would trigger:
 * which screens open, in which order, and what they are given.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { JAWProvider } from './JAWProvider.js';
import { Mode, type JawProviderPreference } from './interface.js';
import { store } from '../store/index.js';
import { clearSignerType } from '../signer/index.js';
import { restCall } from '../api/index.js';
import type { UIHandler, UIRequest } from '../ui/interface.js';

vi.mock('../communicator/index.js');
vi.mock('../api/index.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/index.js')>()),
    restCall: vi.fn(),
}));

const GUARDIAN = '0x1234567890123456789012345678901234567890';
const REQUEST_ID = `0x${'ab'.repeat(32)}`;
const API_KEY = 'test-api-key';
const CEREMONY = { requestId: REQUEST_ID, collected: 1, threshold: 2, chains: [] };

let uiHandler: UIHandler & { request: ReturnType<typeof vi.fn> };

function answer(request: UIRequest) {
    if (request.type === 'wallet_connect') {
        return { id: request.id, approved: true, data: { accounts: [{ address: GUARDIAN }] } };
    }
    return { id: request.id, approved: true, data: { answered: request.type } };
}

function newProvider(preference: JawProviderPreference = {}): JAWProvider {
    const full = { mode: Mode.AppSpecific, uiHandler, ...preference };
    // What JAW.create stores: the signers read the preference and key from here.
    store.config.set({ apiKey: API_KEY, preference: full });
    return new JAWProvider({
        metadata: { appName: 'Recovery', appLogoUrl: null, defaultChainId: 1 },
        preference: full,
        apiKey: API_KEY,
    });
}

/** The screens the UI handler was asked for, in order. */
function screens(): UIRequest[] {
    return uiHandler.request.mock.calls.map(([request]) => request as UIRequest);
}

beforeEach(() => {
    vi.clearAllMocks();
    store.account.clear();
    clearSignerType();
    uiHandler = { request: vi.fn(async (request: UIRequest) => answer(request)), cleanup: vi.fn() } as never;
    vi.mocked(restCall).mockResolvedValue(CEREMONY as never);
});

describe('the recovery ceremony in AppSpecific mode', () => {
    // The user recovering has no account on this device. The silent connect
    // would show them onboarding for an account they cannot sign in to.
    it('starts a recovery with no session, signing no one in first', async () => {
        const provider = newProvider();

        await expect(provider.request({ method: 'wallet_startRecovery', params: [{}] })).resolves.toEqual({
            answered: 'wallet_startRecovery',
        });

        expect(screens().map((screen) => screen.type)).toEqual(['wallet_startRecovery']);
        expect(screens()[0]).toMatchObject({
            data: { account: undefined, chainId: 1, approveUrl: 'https://keys.jaw.id/recover/approve' },
        });
        await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([]);
    });

    it("gives the start screen the account the app names and the app's guardian page", async () => {
        const provider = newProvider({ recoveryApproveUrl: 'https://wallet.example/recover' });

        await provider.request({ method: 'wallet_startRecovery', params: [{ account: GUARDIAN }] });

        expect(screens()).toEqual([
            expect.objectContaining({
                type: 'wallet_startRecovery',
                data: { account: GUARDIAN, chainId: 1, approveUrl: 'https://wallet.example/recover' },
            }),
        ]);
    });

    // Sign in, then approve: the guardian approves as an account.
    it('signs a guardian in before the approval screen', async () => {
        const provider = newProvider();

        await expect(
            provider.request({ method: 'wallet_approveRecovery', params: [{ requestId: REQUEST_ID }] })
        ).resolves.toEqual({ answered: 'wallet_approveRecovery' });

        expect(screens()).toEqual([
            expect.objectContaining({ type: 'wallet_connect', data: expect.objectContaining({ silent: true }) }),
            expect.objectContaining({
                type: 'wallet_approveRecovery',
                data: { address: GUARDIAN, chainId: 1, requestId: REQUEST_ID },
            }),
        ]);
    });

    it('approves as the connected guardian with no second sign-in', async () => {
        const provider = newProvider();
        await provider.request({ method: 'eth_requestAccounts' });
        uiHandler.request.mockClear();

        await provider.request({ method: 'wallet_approveRecovery', params: [{ requestId: REQUEST_ID }] });

        expect(screens().map((screen) => screen.type)).toEqual(['wallet_approveRecovery']);
    });

    describe('wallet_getRecoveryStatus', () => {
        function readsTheCeremony() {
            expect(vi.mocked(restCall).mock.calls).toEqual([
                ['GET_CEREMONY', 'GET', {}, { 'x-api-key': API_KEY }, { requestId: REQUEST_ID }],
            ]);
            expect(uiHandler.request).not.toHaveBeenCalled();
        }

        it('reads the ceremony by its request id with no session', async () => {
            const provider = newProvider();

            await expect(
                provider.request({ method: 'wallet_getRecoveryStatus', params: [{ requestId: REQUEST_ID }] })
            ).resolves.toEqual(CEREMONY);

            readsTheCeremony();
        });

        it('reads the ceremony by its request id with a session', async () => {
            const provider = newProvider();
            await provider.request({ method: 'eth_requestAccounts' });
            await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([GUARDIAN]);
            uiHandler.request.mockClear();

            await expect(
                provider.request({ method: 'wallet_getRecoveryStatus', params: [{ requestId: REQUEST_ID }] })
            ).resolves.toEqual(CEREMONY);

            readsTheCeremony();
        });

        it('refuses a malformed request id before anything is read', async () => {
            const provider = newProvider();

            await expect(
                provider.request({ method: 'wallet_getRecoveryStatus', params: [{ requestId: '0xab' }] })
            ).rejects.toMatchObject({ code: -32602 });

            expect(restCall).not.toHaveBeenCalled();
        });
    });
});
