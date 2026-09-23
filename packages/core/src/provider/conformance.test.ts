/**
 * EIP-1193 conformance.
 *
 * What a dapp depends on behaviorally is not what a method returns, it is the
 * shape of the contract around it: which methods answer without a session,
 * which refuse, and which error code comes back when they refuse. Wallet
 * libraries branch on those codes, so swapping a typed throw for a plain
 * `Error` is a breaking change that no type checker catches.
 *
 * Two things make this file different from JAWProvider.test.ts, which covers
 * behavior per method:
 *
 * 1. The table is checked against `method-policy.ts`, so a method added to the
 *    policy without a case here fails rather than going uncovered.
 * 2. The real error module runs. JAWProvider.test.ts stubs `serializeError` to
 *    identity, which is the exact function that can flatten a code on the way
 *    out, so the degradation it exists to prevent would be invisible there.
 *
 * Only the transport seams are mocked. A request travels the same path a dapp
 * would trigger.
 */
import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

import { JAWProvider } from './JAWProvider.js';
import { SILENT_METHODS, INTERACTIVE_METHODS } from '../method-policy.js';
import { standardErrorCodes, standardErrors, errorValues } from '../errors/index.js';
import { createSigner, loadSignerType, storeSignerType, clearSignerType, type Signer } from '../signer/index.js';
import { store } from '../store/index.js';
import { Communicator } from '../communicator/index.js';
import { PasskeyManager } from '../passkey-manager/index.js';
import type { RequestArguments } from './interface.js';
import { handleGetCallsStatusRequest } from '../rpc/wallet_getCallStatus.js';
import { handleGetAssetsRequest } from '../rpc/wallet_getAssets.js';
import {
    handleGetPermissionsRequest,
    handleGetCapabilitiesRequest,
    handleGetCallsHistoryRequest,
} from '../rpc/index.js';
import { Mode, type ConstructorOptions, type ModeType } from './interface.js';

vi.mock('../communicator/index.js');
vi.mock('../signer/index.js', () => ({
    createSigner: vi.fn(),
    loadSignerType: vi.fn(),
    storeSignerType: vi.fn(),
    clearSignerType: vi.fn(),
}));

// The read-only handlers reach the API. Their responses are not what this file
// is about, only the fact that these methods route to them without a session.
vi.mock('../rpc/wallet_getCallStatus.js', () => ({ handleGetCallsStatusRequest: vi.fn() }));
vi.mock('../rpc/wallet_getAssets.js', () => ({ handleGetAssetsRequest: vi.fn() }));
vi.mock('../rpc/index.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../rpc/index.js')>()),
    handleGetPermissionsRequest: vi.fn(),
    handleGetCapabilitiesRequest: vi.fn(),
    handleGetCallsHistoryRequest: vi.fn(),
}));

function options(mode: ModeType): ConstructorOptions {
    return {
        metadata: { appName: 'Conformance', appLogoUrl: 'https://test.example/logo.png', defaultChainId: 8453 },
        preference: { keysUrl: 'https://keys.test.example', mode },
        apiKey: 'test-api-key',
    };
}

// The provider branches on mode in the no-session paths: which signer type it
// persists and restores, and how the throwaway signer authenticates.
const MODES = [
    { mode: Mode.CrossPlatform, signerType: 'crossPlatform', ephemeralHandshake: { method: 'handshake' } },
    {
        mode: Mode.AppSpecific,
        signerType: 'appSpecific',
        ephemeralHandshake: { method: 'wallet_connect', params: [{ silent: true }] },
    },
] as const;

/** What a method does when the provider has no session yet. */
type NoSessionOutcome =
    | { kind: 'rejects'; code: number }
    | { kind: 'answers'; expect: (result: unknown) => void }
    | { kind: 'connects' }
    | { kind: 'ephemeral' }
    | { kind: 'delegates'; handler: () => Mock };

const WITHOUT_SESSION: Record<string, NoSessionOutcome> = {
    // Silent reads answered from local state. A wallet library probes these on
    // mount, so they resolve instead of prompting.
    eth_accounts: { kind: 'answers', expect: (r) => expect(r).toEqual([]) },
    // null with no session. A signer that holds no accounts answers the same
    // situation with a 4100 refusal, which CrossPlatformSigner.test.ts pins
    // against a real signer.
    eth_coinbase: { kind: 'answers', expect: (r) => expect(r).toBeNull() },
    eth_chainId: { kind: 'answers', expect: (r) => expect(r).toBe('0x2105') },
    // A number, where JSON-RPC and every mainstream wallet return the decimal
    // as a string. Pinned as-is because the connected path returns a number too
    // (JAWSigner.ts), so the SDK is at least self-consistent, and changing both
    // is a behavior change rather than a test change. A consumer calling a
    // string method on this throws instead of getting a wrong answer.
    net_version: { kind: 'answers', expect: (r) => expect(r).toBe(8453) },

    // Silent reads served by the API, no session required.
    wallet_getAssets: { kind: 'delegates', handler: () => handleGetAssetsRequest as Mock },
    wallet_getCallsStatus: { kind: 'delegates', handler: () => handleGetCallsStatusRequest as Mock },
    wallet_getCallsHistory: { kind: 'delegates', handler: () => handleGetCallsHistoryRequest as Mock },
    wallet_getPermissions: { kind: 'delegates', handler: () => handleGetPermissionsRequest as Mock },
    wallet_getCapabilities: { kind: 'delegates', handler: () => handleGetCapabilitiesRequest as Mock },

    // Establish the session.
    eth_requestAccounts: { kind: 'connects' },
    wallet_connect: { kind: 'connects' },

    // Sign through a throwaway signer, so they work without connecting first.
    wallet_sendCalls: { kind: 'ephemeral' },
    wallet_sign: { kind: 'ephemeral' },
    wallet_grantPermissions: { kind: 'ephemeral' },
    wallet_revokePermissions: { kind: 'ephemeral' },
    // Signs nothing, but the receive screen has no address to show without an
    // account, so it resolves one through the same throwaway signer.
    wallet_addFunds: { kind: 'ephemeral' },

    // Refused outright, before the session is even consulted: eth_sign is blind
    // signing, and 4200 says "this wallet does not offer it" rather than
    // "connect first", which would imply it works once you do.
    eth_sign: { kind: 'rejects', code: standardErrorCodes.provider.unsupportedMethod },

    // Everything else needs the user to connect first.
    personal_sign: { kind: 'rejects', code: standardErrorCodes.provider.unauthorized },
    eth_signTypedData: { kind: 'rejects', code: standardErrorCodes.provider.unauthorized },
    eth_signTypedData_v4: { kind: 'rejects', code: standardErrorCodes.provider.unauthorized },
    eth_sendTransaction: { kind: 'rejects', code: standardErrorCodes.provider.unauthorized },
};

/** Every code this SDK can put in front of a dapp, read off the source so a
 *  family added to `standardErrorCodes` is covered without editing this file. */
const EVERY_CODE: ReadonlyArray<[string, number]> = Object.values(standardErrorCodes).flatMap((family) =>
    Object.entries(family)
);

/** The methods whose outcome is of one kind, typed so the cases need no casts. */
function casesOf<K extends NoSessionOutcome['kind']>(kind: K) {
    return Object.entries(WITHOUT_SESSION).flatMap(([method, outcome]) =>
        outcome.kind === kind ? [[method, outcome as Extract<NoSessionOutcome, { kind: K }>] as const] : []
    );
}

let signer: Signer;

const ACCOUNT = '0x1234567890123456789012345678901234567890';

function newProvider(mode: ModeType = Mode.CrossPlatform): JAWProvider {
    return new JAWProvider(options(mode));
}

/** A provider with a live session, so requests route through the signer. */
function connectedProvider(
    mode: ModeType = Mode.CrossPlatform,
    signerType: (typeof MODES)[number]['signerType'] = 'crossPlatform'
): JAWProvider {
    (loadSignerType as Mock).mockReturnValue(signerType);
    store.account.set({ accounts: [ACCOUNT] });
    return new JAWProvider(options(mode));
}

beforeEach(() => {
    vi.clearAllMocks();
    signer = { request: vi.fn(), handshake: vi.fn(), cleanup: vi.fn() } as unknown as Signer;
    (createSigner as Mock).mockReturnValue(signer);
    (loadSignerType as Mock).mockReturnValue(null);
    store.account.clear();
    new PasskeyManager().logout();
});

describe('EIP-1193 conformance', () => {
    describe('the table tracks method-policy', () => {
        it('covers every method the policy declares', () => {
            const declared = [...SILENT_METHODS, ...INTERACTIVE_METHODS].sort();
            expect(Object.keys(WITHOUT_SESSION).sort()).toEqual(declared);
        });
    });

    describe.each(MODES)('in $mode mode', ({ mode, signerType, ephemeralHandshake }) => {
        describe('without a session', () => {
            it.each(casesOf('rejects'))('%s rejects with its documented code', async (method, outcome) => {
                await expect(newProvider(mode).request({ method })).rejects.toMatchObject({ code: outcome.code });
            });

            it.each(casesOf('answers'))('%s answers from local state', async (method, outcome) => {
                const result = await newProvider(mode).request({ method });
                outcome.expect(result);
                expect(createSigner).not.toHaveBeenCalled();
            });

            it.each(casesOf('delegates'))('%s routes to its read handler', async (method, outcome) => {
                const handler = outcome.handler();
                handler.mockResolvedValue('ok');

                await expect(newProvider(mode).request({ method })).resolves.toBe('ok');
                expect(handler).toHaveBeenCalled();
                expect(createSigner).not.toHaveBeenCalled();
            });

            it.each(casesOf('connects'))('%s leaves the provider connected', async (method) => {
                (signer.request as Mock).mockResolvedValue('connected');
                // The real handshake stores the connected account in both modes.
                (signer.handshake as Mock).mockImplementation(async () => store.account.set({ accounts: [ACCOUNT] }));
                const provider = newProvider(mode);

                await expect(provider.request({ method })).resolves.toBe('connected');
                expect(signer.handshake).toHaveBeenCalled();

                // Persisted, not just live in memory. This is what lets the next
                // page load restore the signer instead of running a fresh ceremony,
                // so dropping it would cost the user a biometric on every reload
                // while everything else here stayed green.
                expect(storeSignerType).toHaveBeenCalledWith(signerType);

                // The session stuck: the next silent read goes through the signer
                // rather than being answered with the not-connected default.
                (signer.request as Mock).mockResolvedValue(['0xabc']);
                await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual(['0xabc']);
            });

            it.each(casesOf('ephemeral'))('%s signs through a throwaway signer', async (method) => {
                (signer.request as Mock).mockResolvedValue('signed');
                const provider = newProvider(mode);

                await expect(provider.request({ method })).resolves.toBe('signed');
                expect(signer.handshake).toHaveBeenCalledWith(ephemeralHandshake);
                expect(signer.cleanup).toHaveBeenCalled();

                // Throwaway means throwaway: signing this way must not leave the
                // ephemeral signer installed, or every later read would route
                // through a session the user never agreed to keep. Asserted on the
                // same provider instance, since a fresh one would answer `[]` no
                // matter what this one did.
                await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([]);
            });

            // Declining is the common way out of a signing dialog, and the
            // handshake left state behind: session keys in CrossPlatform, the
            // persisted account in AppSpecific. It must not outlive the request.
            it.each(casesOf('ephemeral'))('%s cleans up the throwaway signer when the user rejects', async (method) => {
                (signer.request as Mock).mockRejectedValue(standardErrors.provider.userRejectedRequest());
                const provider = newProvider(mode);

                await expect(provider.request({ method })).rejects.toMatchObject({
                    code: standardErrorCodes.provider.userRejectedRequest,
                });
                expect(signer.cleanup).toHaveBeenCalled();
                await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([]);
            });

            // Cleanup rotates the CrossPlatform session keys, so running it
            // before the request would leave the request nothing to encrypt with.
            it('cleans up only after the request has settled', async () => {
                let cleanupDone = false;
                (signer.cleanup as Mock).mockImplementation(async () => {
                    await Promise.resolve();
                    cleanupDone = true;
                });
                (signer.request as Mock).mockRejectedValue(standardErrors.provider.userRejectedRequest());

                await expect(newProvider(mode).request({ method: 'wallet_sendCalls' })).rejects.toBeDefined();

                const [handshakeAt] = (signer.handshake as Mock).mock.invocationCallOrder;
                const [requestAt] = (signer.request as Mock).mock.invocationCallOrder;
                const [cleanupAt] = (signer.cleanup as Mock).mock.invocationCallOrder;
                expect(handshakeAt).toBeLessThan(requestAt);
                expect(requestAt).toBeLessThan(cleanupAt);
                expect(cleanupDone).toBe(true);
            });

            it('cleans up the throwaway signer when the handshake is rejected', async () => {
                (signer.handshake as Mock).mockRejectedValue(standardErrors.provider.userRejectedRequest());
                const provider = newProvider(mode);

                await expect(provider.request({ method: 'wallet_sendCalls' })).rejects.toMatchObject({
                    code: standardErrorCodes.provider.userRejectedRequest,
                });
                expect(signer.request).not.toHaveBeenCalled();
                expect(signer.cleanup).toHaveBeenCalled();
                await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([]);
            });

            it('passes a wallet error through with its code, message and data', async () => {
                const walletError = {
                    code: standardErrorCodes.rpc.transactionRejected,
                    message: 'paymaster refused',
                    data: { reason: 'quota' },
                };
                (signer.request as Mock).mockRejectedValue(walletError);

                await expect(newProvider(mode).request({ method: 'wallet_sendCalls' })).rejects.toMatchObject(
                    walletError
                );
            });

            it('reports the rejection, not a failure of the cleanup after it', async () => {
                (signer.request as Mock).mockRejectedValue(standardErrors.provider.userRejectedRequest());
                (signer.cleanup as Mock).mockRejectedValue(new Error('storage unavailable'));
                const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

                await expect(newProvider(mode).request({ method: 'wallet_sendCalls' })).rejects.toMatchObject({
                    code: standardErrorCodes.provider.userRejectedRequest,
                });
                expect(warn).toHaveBeenCalled();
                warn.mockRestore();
            });
        });

        describe('connection lifecycle events', () => {
            function recordEvents(provider: JAWProvider): string[] {
                const events: string[] = [];
                provider.on('accountsChanged', () => events.push('accountsChanged'));
                provider.on('disconnect', () => events.push('disconnect'));
                return events;
            }

            // Driven off the table so all four methods that refuse with 4100 stay
            // honest, rather than personal_sign standing in for the rest.
            const refusesUnauthorized = casesOf('rejects').filter(
                ([, outcome]) => outcome.code === standardErrorCodes.provider.unauthorized
            );

            // vitest registers no tests at all for an empty it.each, so a table
            // change that empties the filter would delete the assertion below
            // without reddening anything.
            it('the table still lists four methods that refuse with 4100', () => {
                expect(refusesUnauthorized).toHaveLength(4);
            });

            it.each(refusesUnauthorized)(
                'stays quiet when %s is refused on a never-connected provider',
                async (method) => {
                    const provider = newProvider(mode);
                    const events = recordEvents(provider);

                    await expect(provider.request({ method })).rejects.toMatchObject({ code: 4100 });

                    // "Connect first" is not a disconnection. A dapp that probes before
                    // connecting must not see a lifecycle event for a session it never
                    // had.
                    expect(events).toEqual([]);
                }
            );

            it('disconnects when a live session comes back unauthorized', async () => {
                const provider = connectedProvider(mode, signerType);
                const events = recordEvents(provider);
                new PasskeyManager().storeAuthState(ACCOUNT, 'credential-id');
                (signer.request as Mock).mockRejectedValue({ code: 4100, message: 'session expired' });

                await expect(provider.request({ method: 'wallet_sign' })).rejects.toMatchObject({ code: 4100 });

                // Same code, opposite meaning: the session died, so tearing it down
                // locally and telling the dapp is right.
                expect(events).toEqual(['accountsChanged', 'disconnect']);
                expect(new PasskeyManager().fetchActiveCredentialId()).toBeNull();
            });

            describe('returning visitor whose session expired', () => {
                // Mirrors JAWSigner past its TTL: eth_accounts notices the expiry,
                // drops the stored account and answers []. A signer left holding
                // no accounts refuses everything else with 4100.
                function expiredVisitor(): JAWProvider {
                    const provider = connectedProvider(mode, signerType);
                    (signer.request as Mock).mockImplementation(async ({ method }: RequestArguments) => {
                        if (method === 'eth_accounts' && store.account.get().accounts?.length) {
                            store.account.clear();
                            return [];
                        }
                        throw standardErrors.provider.unauthorized();
                    });
                    return provider;
                }

                it('keeps answering eth_accounts with an empty list', async () => {
                    const provider = expiredVisitor();

                    await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([]);
                    await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([]);
                    expect(vi.mocked(Communicator).prototype.disconnect).not.toHaveBeenCalled();
                });

                // No accounts means not connected. The dapp is told the session
                // is gone, but the passkey stays logged in for the reconnect and
                // the transport stays up.
                it('refuses personal_sign and reports the session gone without logging out', async () => {
                    const provider = expiredVisitor();
                    const events = recordEvents(provider);
                    new PasskeyManager().storeAuthState(ACCOUNT, 'credential-id');
                    await provider.request({ method: 'eth_accounts' });

                    await expect(provider.request({ method: 'personal_sign' })).rejects.toMatchObject({
                        code: standardErrorCodes.provider.unauthorized,
                    });
                    expect(events).toEqual(['accountsChanged', 'disconnect']);
                    expect(new PasskeyManager().fetchActiveCredentialId()).toBe('credential-id');
                    expect(clearSignerType).toHaveBeenCalled();
                    expect(vi.mocked(Communicator).prototype.disconnect).not.toHaveBeenCalled();
                });

                // AppSpecificSigner stores whatever list the UI returned, so an
                // empty one is a real state and must read as not connected.
                it('treats a stored empty account list as not connected', async () => {
                    const provider = connectedProvider(mode, signerType);
                    store.account.set({ accounts: [] });
                    (signer.request as Mock).mockResolvedValue('from the restored signer');

                    await expect(provider.request({ method: 'personal_sign' })).rejects.toMatchObject({
                        code: standardErrorCodes.provider.unauthorized,
                    });
                    expect(signer.request).not.toHaveBeenCalled();
                });

                it('still signs through a throwaway signer', async () => {
                    const provider = expiredVisitor();
                    await provider.request({ method: 'eth_accounts' });
                    (signer.request as Mock).mockResolvedValue('signed');

                    await expect(provider.request({ method: 'wallet_sendCalls' })).resolves.toBe('signed');
                    expect(signer.handshake).toHaveBeenCalledWith(ephemeralHandshake);
                });
            });
        });
    });

    describe('error codes survive the trip to the dapp', () => {
        // The provider's exit runs serializeError. It keeps a code when
        // errors/constants.ts lists it, and separately lets the whole JSON-RPC
        // server range (-32099 to -32000) through by range check. Outside both,
        // the code is flattened to -32603.
        //
        // So dropping an errorValues entry degrades the CODE for the 4xxx and
        // 5xxx families, and only the MESSAGE for the server range. Both are
        // asserted, since a dapp that shows the message to a user cares about
        // the second just as much.
        it.each(EVERY_CODE)('%s (%i) reaches the dapp unchanged', async (_name, code) => {
            const provider = connectedProvider();
            // A plain object, not an Error instance, because that is what an
            // error looks like once it has crossed the popup or iframe boundary:
            // postMessage structured-clones it and the prototype is gone.
            (signer.request as Mock).mockRejectedValue({ code, message: 'from the wallet' });

            await expect(provider.request({ method: 'wallet_sign' })).rejects.toMatchObject({
                code,
                message: 'from the wallet',
            });

            // Routed through the restored session, not through the ephemeral
            // branch. Without this the whole block would keep passing if signer
            // restore broke, since the ephemeral path calls the same mock.
            expect(signer.handshake).not.toHaveBeenCalled();
        });

        it.each(EVERY_CODE)('%s (%i) resolves its message when the wallet sends none', async (_name, code) => {
            const provider = connectedProvider();
            (signer.request as Mock).mockRejectedValue({ code });

            await expect(provider.request({ method: 'wallet_sign' })).rejects.toMatchObject({
                code,
                message: errorValues[String(code) as keyof typeof errorValues].message,
            });
        });

        it('reports a user rejection as 4001, not as an internal error', async () => {
            const provider = connectedProvider();
            (signer.request as Mock).mockRejectedValue(standardErrors.provider.userRejectedRequest('User denied'));

            await expect(provider.request({ method: 'wallet_sendCalls' })).rejects.toMatchObject({
                code: standardErrorCodes.provider.userRejectedRequest,
            });
        });

        it('flattens an untyped Error to -32603 rather than guessing a code', async () => {
            const provider = connectedProvider();
            (signer.request as Mock).mockRejectedValue(new Error('boom'));

            await expect(provider.request({ method: 'wallet_sign' })).rejects.toMatchObject({
                code: standardErrorCodes.rpc.internal,
                message: 'boom',
            });
        });
    });

    describe('methods the policy does not list', () => {
        // wallet_disconnect is dispatched by the provider in both branches yet
        // appears in neither SILENT_METHODS nor INTERACTIVE_METHODS, so the
        // coverage check above cannot see it. It is also the method that runs
        // PasskeyManager.logout() and tears down the transport, which makes it
        // the one most worth pinning. Classifying it is a call for whoever owns
        // the policy; pinned here meanwhile.
        it('wallet_disconnect resolves to null even on a provider that never connected', async () => {
            await expect(newProvider().request({ method: 'wallet_disconnect' })).resolves.toBeNull();
        });
    });
});
