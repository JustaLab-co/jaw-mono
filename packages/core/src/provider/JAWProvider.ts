import { Communicator } from '../communicator/index.js';
import { standardErrorCodes, serializeError, standardErrors } from '../errors/index.js';

import { SignerType } from '../messages/index.js';

import {
    AppMetadata,
    ConstructorOptions,
    JawProviderPreference,
    ProviderEventEmitter,
    ProviderInterface,
    RequestArguments,
    Mode,
    PaymasterConfig,
} from './interface.js';
import type { JawTheme } from '../ui/theme.js';

import { hexStringFromNumber, checkErrorForInvalidRequestArgs } from '../utils/index.js';
import { isSafari } from '../utils/user-agent.js';

import { correlationIds } from '../store/index.js';

import { handleGetCallsStatusRequest } from '../rpc/wallet_getCallStatus.js';
import { handleGetAssetsRequest } from '../rpc/wallet_getAssets.js';
import {
    handleGetPermissionsRequest,
    handleGetCapabilitiesRequest,
    handleGetCallsHistoryRequest,
} from '../rpc/index.js';
import { Signer } from '../signer/index.js';

import { createSigner, loadSignerType, storeSignerType, clearSignerType } from '../signer/index.js';
import { PasskeyManager } from '../passkey-manager/index.js';
import { isSilentMethod } from '../method-policy.js';

export class JAWProvider extends ProviderEventEmitter implements ProviderInterface {
    private readonly metadata: AppMetadata;
    private readonly preference: JawProviderPreference;
    private readonly communicator: Communicator;
    private readonly apiKey: string;
    private readonly paymasters?: Record<number, PaymasterConfig>;
    private theme?: JawTheme;

    private signer: Signer | null = null;

    constructor({ metadata, preference, apiKey, paymasters, theme }: Readonly<ConstructorOptions>) {
        super();
        this.metadata = metadata;
        this.preference = preference;
        this.apiKey = apiKey;
        this.paymasters = paymasters;
        this.theme = theme;
        this.communicator = new Communicator({
            metadata,
            preference,
            theme,
        });

        // Determine the expected signer type from current preference
        const expectedSignerType: SignerType = preference.mode === Mode.AppSpecific ? 'appSpecific' : 'crossPlatform';

        // Iframe transport (the default): mount and handshake in the
        // background so the dialog opens instantly on the first request.
        // Failures are not fatal — the transport retries (or falls back) on
        // first use. Skipped only on the explicit 'popup' opt-out.
        if (
            expectedSignerType === 'crossPlatform' &&
            preference.transportMode !== 'popup' &&
            typeof window !== 'undefined'
        ) {
            void this.communicator.prewarm().catch(() => {
                /* handled on first acquire */
            });
        }

        const storedSignerType = loadSignerType();

        // Only restore signer if the stored type matches the current preference
        // If they don't match, clear the stored type to avoid using wrong signer
        if (storedSignerType) {
            if (storedSignerType === expectedSignerType) {
                this.signer = this.initSigner(storedSignerType);
            } else {
                // Mode has changed, clear the old signer type
                clearSignerType();
            }
        }
    }

    /**
     * Update the dApp theme after construction. Pushes it to the live keys
     * dialog (cross-platform) so it re-themes in place without rebuilding the
     * provider, and stores it for AppSpecific's next request. This is what lets
     * a host app keep one connector and just sync the theme on light/dark flips.
     */
    public setTheme(theme: JawTheme | undefined): void {
        this.theme = theme;
        this.communicator.updateTheme(theme);
    }

    public async request<T>(args: RequestArguments): Promise<T> {
        // correlation id across the entire request lifecycle
        const correlationId = crypto.randomUUID();
        correlationIds.set(args, correlationId);

        try {
            const result = await this._request(args);
            return result as T;
        } finally {
            correlationIds.delete(args);
        }
    }

    async disconnect() {
        try {
            await this.signer?.cleanup();
        } catch (cleanupError) {
            // Log cleanup error but continue with disconnection
            console.warn('Signer cleanup failed during disconnect:', cleanupError);
        }

        // Clear PasskeyManager auth state (explicit logout)
        const passkeyManager = new PasskeyManager(undefined, undefined, this.apiKey);
        passkeyManager.logout();

        // Tear down the cross-platform transport. The iframe carrier is
        // persistent (mounted once, reused across requests), so without this it
        // would survive a disconnect and keep the keys-app session warm until a
        // full page reload — the user would appear "still signed in". The popup
        // transport was transient per-request, so this was a no-op there.
        this.communicator.disconnect();

        this.signer = null;
        correlationIds.clear();
        this.emit('accountsChanged', []);
        this.emit('disconnect', standardErrors.provider.disconnected('User initiated disconnection'));
    }

    private async _request<T>(args: RequestArguments): Promise<T> {
        const signerType = this.preference.mode === Mode.AppSpecific ? 'appSpecific' : 'crossPlatform';

        try {
            checkErrorForInvalidRequestArgs(args);
            if (!this.signer) {
                switch (args.method) {
                    case 'eth_requestAccounts': {
                        const signer = this.initSigner(signerType);
                        await signer.handshake(args);

                        this.signer = signer;
                        storeSignerType(signerType);
                        // Return directly (like wallet_connect above) instead of
                        // falling through: the Safari re-handshake below is for a
                        // signer RESTORED from a previous visit. This call's own
                        // handshake just ran — but on Safari's popup route it
                        // persists the lastAccount hint mid-call, which flips
                        // willRouteToIframe to true and would walk the user
                        // through a second ceremony in the iframe right after
                        // the popup one. The popup→iframe session handoff (keys
                        // lib/session-handoff.ts) is what seeds the iframe
                        // session on this path.
                        const result = await signer.request(args);
                        return result as T;
                    }
                    case 'wallet_connect': {
                        const signer = this.initSigner(signerType);
                        // For both modes, pass full args to handshake so the complete
                        // wallet_connect flow happens in a single roundtrip.
                        // This avoids race conditions with popup closure in cross-platform mode.
                        await signer.handshake(args);
                        this.signer = signer;
                        storeSignerType(signerType);
                        // Handshake sets accounts/capabilities in store via handleResponse.
                        // The subsequent request will return the cached response.
                        const result = await signer.request(args);
                        return result as T;
                    }
                    case 'wallet_disconnect': {
                        await this.disconnect();
                        return null as T;
                    }
                    // addFunds joins this group because the receive screen has
                    // nothing to show without an account, so it resolves one the
                    // same way the signing methods do rather than rendering an
                    // empty state.
                    case 'wallet_sendCalls':
                    case 'wallet_sign':
                    case 'wallet_grantPermissions':
                    case 'wallet_revokePermissions':
                    case 'wallet_addFunds': {
                        const ephemeralSigner = this.initSigner(signerType);

                        if (signerType === 'appSpecific') {
                            // Silent handshake: authenticate/create account without showing connect dialog.
                            // The signing UI will be shown immediately after.
                            await ephemeralSigner.handshake({
                                method: 'wallet_connect',
                                params: [{ silent: true }],
                            });
                            const result = await ephemeralSigner.request(args);
                            try {
                                await ephemeralSigner.cleanup();
                            } catch (cleanupError) {
                                console.warn('Ephemeral signer cleanup failed:', cleanupError);
                            }
                            return result as T;
                        } else {
                            // CrossPlatform uses Diffie-Hellman key exchange
                            await ephemeralSigner.handshake({ method: 'handshake' }); // exchange session keys
                            const result = await ephemeralSigner.request(args); // send diffie-hellman encrypted request
                            try {
                                await ephemeralSigner.cleanup(); // clean up (rotate) the ephemeral session keys
                            } catch (cleanupError) {
                                // Log cleanup error but don't fail the request
                                console.warn('Ephemeral signer cleanup failed:', cleanupError);
                            }
                            return result as T;
                        }
                    }
                    case 'wallet_getAssets': {
                        const result = await handleGetAssetsRequest(
                            args,
                            this.apiKey,
                            this.preference.showTestnets ?? false
                        );
                        return result as T;
                    }
                    case 'wallet_getCallsStatus': {
                        const result = await handleGetCallsStatusRequest(args);
                        return result as T;
                    }
                    case 'wallet_getCallsHistory': {
                        const result = await handleGetCallsHistoryRequest(args, this.apiKey);
                        return result as T;
                    }
                    case 'wallet_getPermissions': {
                        // wallet_getPermissions requires an explicit address when not authenticated
                        const result = await handleGetPermissionsRequest(args, this.apiKey);

                        return result as T;
                    }
                    case 'wallet_getCapabilities': {
                        const result = await handleGetCapabilitiesRequest(
                            args,
                            this.apiKey,
                            this.preference.showTestnets ?? false
                        );

                        return result as T;
                    }
                    case 'eth_accounts': {
                        // No signer restored → no live session. eth_accounts is a
                        // silent method (per method-policy): per EIP-1193 it
                        // reports an empty list when not connected rather than
                        // throwing, so a wallet library's mount-time reconnect
                        // probe resolves cleanly to "not connected".
                        return [] as T;
                    }
                    case 'eth_coinbase': {
                        // Silent method (per method-policy). With no live session
                        // there is no coinbase address — report null rather than
                        // throwing so a mount-time probe resolves cleanly.
                        return null as T;
                    }
                    case 'net_version': {
                        const result = (this.metadata.defaultChainId ?? 1) as T;
                        return result;
                    }
                    case 'eth_chainId': {
                        const result = hexStringFromNumber(this.metadata.defaultChainId ?? 1) as T;
                        return result;
                    }
                    default: {
                        // Reaching here means no live session. Silent methods are
                        // all handled above, so a silent method falling through is
                        // an internal gap (a new read method added without a case)
                        // — surface that distinctly from the expected case: an
                        // interactive method that legitimately needs the user to
                        // connect first.
                        if (isSilentMethod(args.method)) {
                            throw standardErrors.rpc.methodNotSupported(
                                `Silent method ${args.method} is not handled without a session`
                            );
                        }
                        throw standardErrors.provider.unauthorized(
                            "Must call 'eth_requestAccounts' before other methods"
                        );
                    }
                }
            }

            // Handle wallet_disconnect when signer exists
            if (args.method === 'wallet_disconnect') {
                await this.disconnect();
                return null as T;
            }

            // Interactive connect with a signer already present: on Safari this
            // would return the cached accounts instantly, WITHOUT a live session
            // in the embedded iframe's (partitioned, Brave/Safari-ephemeral)
            // storage — so the first signing action later has to reconnect,
            // costing a second biometric. When the connect routes to the iframe,
            // re-run the handshake now so connecting establishes the iframe
            // session; signing then just signs. No effect off Safari or on the
            // popup route. Cross-platform only: AppSpecific never uses the
            // iframe/popup transport (it drives its own UIHandler), so the
            // communicator's routing does not apply there.
            if (
                signerType === 'crossPlatform' &&
                (args.method === 'eth_requestAccounts' || args.method === 'wallet_connect') &&
                isSafari() &&
                (await this.communicator.willRouteToIframe(args.method))
            ) {
                await this.signer.handshake(args);
            }

            // Handle requests when signer exists
            const result = await this.signer.request(args);

            return result as T;
        } catch (error) {
            const { code } = error as { code?: number };
            // 4100 means two different things here. From a live signer it means
            // the session died, and tearing it down locally is right. From the
            // no-session branch above it just means "connect first", and there
            // is nothing to tear down: disconnecting would emit accountsChanged
            // and disconnect on a provider that was never connected, log the
            // passkey session out, and drop the iframe. A dapp that probes with
            // personal_sign before connecting would pay for it.
            if (code === standardErrorCodes.provider.unauthorized && this.signer) {
                await this.disconnect();
            }
            return Promise.reject(serializeError(error));
        }
    }

    private initSigner(signerType: SignerType): Signer {
        return createSigner({
            signerType,
            metadata: this.metadata,
            communicator: signerType === 'crossPlatform' ? this.communicator : undefined,
            uiHandler: signerType === 'appSpecific' ? this.preference.uiHandler : undefined,
            callback: this.emit.bind(this),
            apiKey: this.apiKey,
            paymasters: signerType === 'appSpecific' ? this.paymasters : undefined,
            ens: signerType === 'appSpecific' ? this.preference.ens : undefined,
            theme: signerType === 'appSpecific' ? this.theme : undefined,
        });
    }
}
