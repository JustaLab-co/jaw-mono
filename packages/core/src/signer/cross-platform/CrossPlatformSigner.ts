import { UUID } from 'crypto';

import { JAWSigner, type NormalizedSigningParams } from '../JAWSigner.js';
import { decodePersonalSignRequest } from '../SignerUtils.js';

import { Communicator } from '../../communicator/index.js';
import { getPermissionFromRelay } from '../../rpc/index.js';
import { standardErrors } from '../../errors/index.js';
import {
    RPCRequestMessage,
    RPCResponseMessage,
    RPCResponse,
    isReconnectRequiredFailure,
} from '../../messages/index.js';
import { KeyManager } from '../../key-manager/index.js';
import { AppMetadata, ProviderEventCallback, RequestArguments } from '../../provider/index.js';
import { store, SDKChain } from '../../store/index.js';
import { decryptContent, encryptContent, exportKeyToHexString, importKeyFromHexString } from '../../utils/index.js';

type ConstructorOptions = {
    metadata: AppMetadata;
    communicator: Communicator;
    callback: ProviderEventCallback | null;
};

export class CrossPlatformSigner extends JAWSigner {
    private readonly communicator: Communicator;
    private readonly keyManager: KeyManager;

    constructor(params: ConstructorOptions) {
        super({
            metadata: params.metadata,
            callback: params.callback,
        });
        this.communicator = params.communicator;
        this.keyManager = new KeyManager();
    }

    override async handshake(args: RequestArguments): Promise<void> {
        const correlationId = this.getCorrelationId(args);

        // Ready the transport this handshake routes to, before other async work.
        // On the popup route this opens the window as the first thing after the
        // click (so Safari's popup blocker allows it); on the iframe route
        // (embedded Safari connect) it readies the live frame instead.
        await this.communicator.waitForPopupLoaded?.(args.method);

        const chains = store.getState().chains;
        const chain = chains?.find((c) => c.id === this.chain.id) ?? this.chain;

        const handshakeMessage = await this.createRequestMessage(
            {
                handshake: {
                    method: args.method,
                    params: args.params ?? [],
                },
                chain,
            },
            correlationId
        );
        const response: RPCResponseMessage = await this.communicator.postRequestAndWaitForResponse(handshakeMessage);

        // store peer's public key
        if ('failure' in response.content) {
            throw response.content.failure;
        }

        const peerPublicKey = await importKeyFromHexString('public', response.sender);
        await this.keyManager.setPeerPublicKey(peerPublicKey);

        const decrypted = await this.decryptResponseMessage(response);

        await this.handleResponse(args, decrypted);
    }

    protected override async handleWalletConnect(request: RequestArguments): Promise<unknown> {
        // Return cached wallet connect response if available
        const cachedResponse = await this.getCachedWalletConnectResponse(request);
        if (cachedResponse) {
            this.emitConnect();
            return cachedResponse;
        }

        // Ready the routed transport before async calls. No method here: the
        // outgoing message is an encrypted envelope, which routes method-less
        // (getRouteContext) — passing the plaintext method would ready a
        // different transport than the send uses (on Safari, wallet_connect
        // would open a popup the encrypted request never reaches).
        await this.communicator.waitForPopupLoaded?.();

        // Validate and inject capabilities using base class method. This
        // returns a new object, so carry the caller's correlation id across.
        const modifiedRequest = this.validateAndInjectCapabilities(request);

        this.emitConnect();
        return this.sendRequestToPopup(modifiedRequest, undefined, false, this.getCorrelationId(request));
    }

    protected override async handleWalletConnectUnauthenticated(request: RequestArguments): Promise<unknown> {
        // Ready the routed transport before async calls. No method here: the
        // outgoing message is an encrypted envelope, which routes method-less
        // (getRouteContext) — passing the plaintext method would ready a
        // different transport than the send uses (on Safari, wallet_connect
        // would open a popup the encrypted request never reaches).
        await this.communicator.waitForPopupLoaded?.();

        // Validate and inject capabilities using base class method. This
        // returns a new object, so carry the caller's correlation id across.
        const modifiedRequest = this.validateAndInjectCapabilities(request);
        return this.sendRequestToPopup(modifiedRequest, undefined, false, this.getCorrelationId(request));
    }

    protected override async handleSigningRequest(
        request: RequestArguments,
        normalized?: NormalizedSigningParams
    ): Promise<unknown> {
        let resolvedChain: SDKChain | undefined;

        // The transforms below return a new request object, so read the
        // correlation id (keyed on object identity) from the original.
        const correlationId = this.getCorrelationId(request);

        // Decode hex-encoded messages for personal_sign before sending to popup
        // (wagmi and other libraries hex-encode messages before sending)
        let processedRequest = decodePersonalSignRequest(request);

        // Forward the validated envelope, not the dapp's raw one: a chainId sent
        // as a number is hex by now, so the chain resolved below is the one the
        // dapp asked for instead of whichever chain we happen to be on. Keys
        // then reads the same quantities validation approved.
        if (normalized) {
            processedRequest = { ...processedRequest, params: [normalized.params] };
        }

        // wallet_revokePermissions needs chainId from relay (not in request params)
        // because the permission may have been granted on a different chain.
        if (processedRequest.method === 'wallet_revokePermissions') {
            const params = processedRequest.params as [{ id: `0x${string}` }];
            const permissionId = params[0].id;
            try {
                const relayPermission = await getPermissionFromRelay(permissionId, store.config.get().apiKey);
                resolvedChain = this.resolveChain(relayPermission.chainId);
            } catch {
                throw standardErrors.rpc.invalidParams(
                    `Permission not found: ${permissionId}. It may have already been revoked.`
                );
            }
        } else {
            // For other methods, resolve chain from request params if present
            resolvedChain = this.resolveChainFromRequest(processedRequest);
        }

        return this.sendRequestToPopup(processedRequest, resolvedChain, false, correlationId);
    }

    /**
     * Extracts chainId from request params and resolves the chain.
     * Supports eth_sendTransaction, wallet_grantPermissions, wallet_sendCalls, and wallet_sign.
     * All methods accept chainId as hex string only (e.g., '0x1').
     */
    private resolveChainFromRequest(request: RequestArguments): SDKChain | undefined {
        const params = request.params as unknown[];
        if (!params || !Array.isArray(params) || params.length === 0) {
            return undefined;
        }

        const firstParam = params[0] as Record<string, unknown> | undefined;
        if (!firstParam || typeof firstParam !== 'object') {
            return undefined;
        }

        let chainIdParam: string | undefined;

        switch (request.method) {
            case 'eth_sendTransaction':
            case 'wallet_grantPermissions':
            case 'wallet_sendCalls':
            case 'wallet_sign': {
                // All methods accept chainId as hex string only
                const chainId = firstParam.chainId;
                if (typeof chainId === 'string') {
                    chainIdParam = chainId;
                }
                break;
            }
            default:
                return undefined;
        }

        if (chainIdParam) {
            return this.resolveChain(chainIdParam);
        }

        return undefined;
    }

    override async cleanup(): Promise<void> {
        await this.keyManager.clear();
        await super.cleanup();
    }

    private async sendRequestToPopup(
        request: RequestArguments,
        overrideChain?: SDKChain,
        isReconnectRetry = false,
        /**
         * Correlation id of the caller's original request. Passed explicitly
         * because request transforms (personal_sign decoding, typed-data
         * serialization, capability injection) replace the object the id is
         * keyed on.
         */
        correlationId?: string
    ): Promise<unknown> {
        // Ready the routed transport first. Method-less on purpose: the message
        // sent below is an encrypted envelope, which the router routes with no
        // method (getRouteContext) — threading the plaintext method here would
        // diverge from the send on Safari (credential methods route to popup,
        // the encrypted envelope to the iframe).
        await this.communicator.waitForPopupLoaded?.();

        try {
            const response = await this.sendEncryptedRequest(request, overrideChain, correlationId);
            const decrypted = await this.decryptResponseMessage(response);

            return this.handleResponse(request, decrypted);
        } catch (error) {
            // Safari iframe storage partitioning: the iframe has no session (the
            // one created in the popup at connect is in a different partition) and
            // asked us to re-establish one. Reconnect against the iframe and retry
            // exactly once. Only the keys iframe emits this sentinel, only when it
            // has no session — so existing/popup flows never enter this branch.
            if (!isReconnectRetry && isReconnectRequiredFailure(error)) {
                // Deduplicate: concurrent in-flight requests can all get the
                // sentinel at once. Share a single reconnect handshake so the
                // second caller doesn't fire its own (its forced-iframe flag
                // would already be consumed and route the handshake to a popup).
                await this.ensureReconnected();
                return this.sendRequestToPopup(request, overrideChain, true, correlationId);
            }
            throw error;
        }
    }

    /** In-flight reconnect, shared by concurrent callers (see ensureReconnected). */
    private reconnectInFlight: Promise<void> | null = null;

    /**
     * Run the iframe reconnect at most once for a burst of concurrent requests.
     * Subsequent callers await the same handshake instead of starting their own.
     */
    private ensureReconnected(): Promise<void> {
        if (!this.reconnectInFlight) {
            this.reconnectInFlight = this.reconnectInIframe().finally(() => {
                this.reconnectInFlight = null;
            });
        }
        return this.reconnectInFlight;
    }

    /**
     * Re-establish a session inside the live iframe (Safari partition recovery).
     *
     * Re-runs the connect handshake forced at the iframe — a credential *get*
     * (the passkey already exists), which Safari permits in cross-origin iframes,
     * unlike the *create* at first connect. This rebuilds the session and re-keys
     * the shared secret in the iframe's own storage; the caller then retries the
     * original request, which re-encrypts with the new secret.
     */
    private async reconnectInIframe(): Promise<void> {
        // Direct this one handshake at the live iframe, bypassing the Safari
        // credential->popup rule (safe: it is a get(), not a create()).
        this.communicator.forceIframeReconnect();

        const chains = store.getState().chains;
        const chain = chains?.find((c) => c.id === this.chain.id) ?? this.chain;

        // eth_requestAccounts (not wallet_connect): both are credential methods
        // handled identically by the keys handshake, but eth_requestAccounts needs
        // no capability params to faithfully re-auth the existing account.
        const reconnectArgs: RequestArguments = { method: 'eth_requestAccounts', params: [] };
        const handshakeMessage = await this.createRequestMessage(
            {
                handshake: { method: reconnectArgs.method, params: reconnectArgs.params ?? [] },
                chain,
            },
            this.getCorrelationId(reconnectArgs)
        );

        const response: RPCResponseMessage = await this.communicator.postRequestAndWaitForResponse(handshakeMessage);

        if ('failure' in response.content) {
            throw response.content.failure;
        }

        // Re-key: derive the new shared secret from the iframe session's public key.
        const peerPublicKey = await importKeyFromHexString('public', response.sender);
        await this.keyManager.setPeerPublicKey(peerPublicKey);
    }

    private async sendEncryptedRequest(
        request: RequestArguments,
        overrideChain?: SDKChain,
        /** Falls back to the request's own id when the caller didn't thread one. */
        callerCorrelationId?: string
    ): Promise<RPCResponseMessage> {
        const sharedSecret = await this.keyManager.getSharedSecret();
        if (!sharedSecret) {
            throw standardErrors.provider.unauthorized('No shared secret found when encrypting request');
        }

        // Use override chain if provided, otherwise use current chain
        let chain: SDKChain;
        if (overrideChain) {
            chain = overrideChain;
        } else {
            const chains = store.getState().chains;
            chain = chains?.find((c) => c.id === this.chain.id) ?? this.chain;
        }

        const encrypted = await encryptContent(
            {
                action: request,
                chain: chain,
            },
            sharedSecret
        );
        const correlationId = callerCorrelationId ?? this.getCorrelationId(request);
        const message = await this.createRequestMessage({ encrypted }, correlationId);

        return this.communicator.postRequestAndWaitForResponse(message);
    }

    private async createRequestMessage(
        content: RPCRequestMessage['content'],
        correlationId: string | undefined
    ): Promise<RPCRequestMessage> {
        const publicKey = await exportKeyToHexString('public', await this.keyManager.getOwnPublicKey());

        return {
            id: crypto.randomUUID() as UUID,
            correlationId,
            sender: publicKey,
            content,
            timestamp: new Date(),
        };
    }

    private async decryptResponseMessage(message: RPCResponseMessage): Promise<RPCResponse> {
        const content = message.content;

        // throw protocol level error
        if ('failure' in content) {
            throw content.failure;
        }

        const sharedSecret = await this.keyManager.getSharedSecret();
        if (!sharedSecret) {
            throw standardErrors.provider.unauthorized(
                'Invalid session: no shared secret found when decrypting response'
            );
        }

        const response: RPCResponse = await decryptContent(content.encrypted, sharedSecret);

        const walletCapabilities = response.data?.capabilities;
        if (walletCapabilities) {
            store.account.set({
                capabilities: walletCapabilities,
            });
        }
        return response;
    }
}
