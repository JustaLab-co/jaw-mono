import { Address } from 'viem';
import { JAWSigner, type NormalizedSigningParams } from '../JAWSigner.js';
import { decodePersonalSignMessage } from '../SignerUtils.js';
import {
    UIHandler,
    UIError,
    ConnectUIRequest,
    SignatureUIRequest,
    TypedDataUIRequest,
    TransactionUIRequest,
    SendTransactionUIRequest,
    PermissionUIRequest,
    RevokePermissionUIRequest,
    WalletSignUIRequest,
    AddFundsUIRequest,
    PersonalSignRequestData,
    TypedDataRequestData,
    PaymasterConfig,
} from '../../ui/interface.js';
import { AppMetadata, ProviderEventCallback, RequestArguments } from '../../provider/interface.js';
import {
    WalletConnectResponse,
    WalletConnectRequest,
    WalletGrantPermissionsRequest,
    WalletRevokePermissionsRequest,
    getPermissionFromRelay,
    normalizeSendCallsParams,
    normalizeSendTransactionParams,
} from '../../rpc/index.js';
import { store, SDKChain } from '../../store/index.js';
import { ensureIntNumber } from '../../utils/index.js';
import { resolveDestination } from '../../addFunds/destination.js';
import { standardErrors } from '../../errors/index.js';
import type { JawTheme } from '../../ui/theme.js';

type ConstructorOptions = {
    metadata: AppMetadata;
    uiHandler: UIHandler;
    callback: ProviderEventCallback | null;
    apiKey: string;
    paymasters?: Record<number, PaymasterConfig>;
    ens?: string;
    theme?: JawTheme;
};

export class AppSpecificSigner extends JAWSigner {
    private readonly uiHandler: UIHandler;

    constructor(params: ConstructorOptions) {
        super({
            metadata: params.metadata,
            callback: params.callback,
        });
        this.uiHandler = params.uiHandler;

        // Initialize the UI handler with SDK configuration
        if (this.uiHandler.init) {
            this.uiHandler.init({
                apiKey: params.apiKey,
                defaultChainId: params.metadata.defaultChainId,
                paymasters: params.paymasters,
                appName: params.metadata.appName,
                appLogoUrl: params.metadata.appLogoUrl,
                ens: params.ens,
                theme: params.theme,
            });
        }
    }

    /**
     * Handshake establishes connection with user approval.
     * Sends raw params without validation (same as CrossPlatformSigner).
     * Capabilities validation only happens in handleWalletConnect/handleWalletConnectUnauthenticated.
     */
    async handshake(args: RequestArguments): Promise<void> {
        // Record the response so the follow-up signer.request(wallet_connect) returns it
        // from cache instead of re-running performWalletConnect (a second account dialog).
        const response = await this.performWalletConnect(args, { skipCapabilitiesValidation: true });
        this.pendingWalletConnectResponse = response;
    }

    protected async handleWalletConnect(request: RequestArguments): Promise<unknown> {
        // Return cached wallet connect response if available (same as CrossPlatformSigner)
        const cachedResponse = await this.getCachedWalletConnectResponse(request);
        if (cachedResponse) {
            this.emitConnect();
            return cachedResponse;
        }

        this.emitConnect();

        return this.performWalletConnect(request);
    }

    protected async handleWalletConnectUnauthenticated(request: RequestArguments): Promise<unknown> {
        // For unauthenticated, we don't emit connect (same as CrossPlatformSigner)
        return this.performWalletConnect(request);
    }

    /**
     * Core wallet_connect flow used by handshake, handleWalletConnect, and handleWalletConnectUnauthenticated.
     * This ensures consistent behavior across all connect paths.
     *
     * @param options.skipCapabilitiesValidation - If true, skips capabilities validation (used by handshake)
     */
    private async performWalletConnect(
        request: RequestArguments,
        options?: { skipCapabilitiesValidation?: boolean }
    ): Promise<WalletConnectResponse> {
        // Validate and inject capabilities using base class method (same as CrossPlatformSigner)
        const modifiedRequest = options?.skipCapabilitiesValidation
            ? request
            : this.validateAndInjectCapabilities(request);

        const correlationId = this.getCorrelationId(request);

        const chains = store.getState().chains;
        const chain = chains?.find((c: SDKChain) => c.id === this.chain.id) ?? this.chain;

        // Extract capabilities and silent flag from request params
        const walletConnectParams = modifiedRequest.params as WalletConnectRequest['params'] | undefined;
        const capabilities = walletConnectParams?.[0]?.capabilities;
        const silent = walletConnectParams?.[0]?.silent;

        const uiRequest: ConnectUIRequest = {
            id: crypto.randomUUID(),
            type: 'wallet_connect',
            timestamp: Date.now(),
            correlationId,
            data: {
                appName: this.metadata.appName,
                appLogoUrl: this.metadata.appLogoUrl,
                origin: typeof window !== 'undefined' ? window.location.origin : 'unknown',
                chainId: chain.id,
                capabilities,
                silent,
            },
        };

        const response = await this.uiHandler.request<WalletConnectResponse>(uiRequest);

        if (!response.approved) {
            throw response.error || UIError.userRejected();
        }

        if (!response.data) {
            throw UIError.userRejected('Invalid wallet_connect response: missing data');
        }

        // Extract accounts from response
        const accounts = response.data.accounts?.map((acc) => acc.address) ?? [];
        this.accounts = accounts;

        // Store capabilities from response (same as CrossPlatformSigner does in decryptResponseMessage)
        // The capabilities are per-account in WalletConnectResponse
        const walletCapabilities = response.data.accounts?.[0]?.capabilities;

        store.account.set({
            accounts,
            chain: this.chain,
            ...(walletCapabilities && { capabilities: walletCapabilities }),
        });

        // Only emit first account in array (same as CrossPlatformSigner handleResponse for wallet_connect)
        this.callback?.('accountsChanged', [accounts[0]]);
        this.reportSiweSignatures(response.data);
        return response.data;
    }

    protected async handleSigningRequest(
        request: RequestArguments,
        normalized?: NormalizedSigningParams
    ): Promise<unknown> {
        const correlationId = this.getCorrelationId(request);

        switch (request.method) {
            case 'personal_sign': {
                const params = request.params as [string, Address];
                const [message, address] = params;

                // Decode hex-encoded message for display and signing
                // (wagmi and other libraries hex-encode messages before sending)
                const decodedMessage = decodePersonalSignMessage(message);

                const uiRequest: SignatureUIRequest = {
                    id: crypto.randomUUID(),
                    type: 'personal_sign',
                    timestamp: Date.now(),
                    correlationId,
                    data: {
                        message: decodedMessage,
                        address,
                        chainId: this.chain.id,
                    },
                };

                const response = await this.uiHandler.request<string>(uiRequest);

                if (!response.approved) {
                    throw response.error || UIError.userRejected();
                }

                return response.data;
            }

            case 'eth_signTypedData_v4': {
                const params = request.params as [Address, string];
                const [address, typedData] = params;

                const uiRequest: TypedDataUIRequest = {
                    id: crypto.randomUUID(),
                    type: 'eth_signTypedData_v4',
                    timestamp: Date.now(),
                    correlationId,
                    data: {
                        address,
                        typedData,
                        chainId: this.chain.id,
                    },
                };

                const response = await this.uiHandler.request<string>(uiRequest);

                if (!response.approved) {
                    throw response.error || UIError.userRejected();
                }

                return response.data;
            }

            case 'wallet_sign': {
                // ERC-7871 wallet_sign params structure with optional chainId
                type WalletSignParams = {
                    /** Account address to sign with. */
                    address?: Address;
                    /** Target chain ID in hex format. Defaults to the connected chain. */
                    chainId?: `0x${string}`;
                    request: PersonalSignRequestData | TypedDataRequestData;
                };
                const params = request.params as [WalletSignParams];
                const signParams = params[0];

                // Resolve chain: param chainId -> current chain -> defaultChainId
                const resolvedChain = this.resolveChain(signParams.chainId);

                const uiRequest: WalletSignUIRequest = {
                    id: crypto.randomUUID(),
                    type: 'wallet_sign',
                    timestamp: Date.now(),
                    correlationId,
                    data: {
                        address: signParams.address ?? this.accounts[0],
                        chainId: resolvedChain.id,
                        request: signParams.request,
                    },
                };

                const response = await this.uiHandler.request<string>(uiRequest);

                if (!response.approved) {
                    throw response.error || UIError.userRejected();
                }

                return response.data;
            }

            case 'wallet_sendCalls': {
                // Normalized in dispatchSigningRequest, so either EIP-5792
                // envelope version — v1.0 and viem's default v2.0.0 — reaches the
                // dialog in one shape (hex chainId, explicit atomicRequired).
                const callsData =
                    normalized?.method === 'wallet_sendCalls'
                        ? normalized.params
                        : normalizeSendCallsParams(request.params);

                // Resolve chain: param chainId -> current chain -> defaultChainId
                const resolvedChain = this.resolveChain(callsData.chainId);

                const uiRequest: TransactionUIRequest = {
                    id: crypto.randomUUID(),
                    type: 'wallet_sendCalls',
                    timestamp: Date.now(),
                    correlationId,
                    data: {
                        ...callsData,
                        from: callsData.from ?? this.accounts[0],
                        chainId: resolvedChain.id,
                    },
                };

                const response = await this.uiHandler.request<{
                    id: string;
                    chainId: number;
                }>(uiRequest);

                if (!response.approved) {
                    throw response.error || UIError.userRejected();
                }

                // Handle background receipt tracking
                if (response.data) {
                    this.trackSendCallsResult(response.data);
                }

                return response.data;
            }

            case 'eth_sendTransaction': {
                const txData =
                    normalized?.method === 'eth_sendTransaction'
                        ? normalized.params
                        : normalizeSendTransactionParams(request.params);

                // Resolve chain: param chainId -> current chain -> defaultChainId
                const resolvedChain = this.resolveChain(txData.chainId);

                const uiRequest: SendTransactionUIRequest = {
                    id: crypto.randomUUID(),
                    type: 'eth_sendTransaction',
                    timestamp: Date.now(),
                    correlationId,
                    data: {
                        from: txData.from ?? this.accounts[0],
                        to: txData.to,
                        value: txData.value,
                        data: txData.data,
                        gas: txData.gas,
                        gasPrice: txData.gasPrice,
                        maxFeePerGas: txData.maxFeePerGas,
                        maxPriorityFeePerGas: txData.maxPriorityFeePerGas,
                        nonce: txData.nonce,
                        chainId: resolvedChain.id,
                        capabilities: txData.capabilities,
                    },
                };

                // eth_sendTransaction returns transaction hash string directly
                const response = await this.uiHandler.request<string>(uiRequest);

                if (!response.approved) {
                    throw response.error || UIError.userRejected();
                }

                // Handle background receipt tracking using txHash as id
                if (response.data) {
                    this.trackSendCallsResult({
                        id: response.data,
                        chainId: resolvedChain.id,
                    });
                }

                return response.data;
            }

            case 'wallet_grantPermissions': {
                const grantParams = request.params as WalletGrantPermissionsRequest['params'];
                const permissionData = grantParams[0];

                // Resolve chain: param chainId -> current chain -> defaultChainId
                const resolvedChain = this.resolveChain(permissionData.chainId);

                const uiRequest: PermissionUIRequest = {
                    id: crypto.randomUUID(),
                    type: 'wallet_grantPermissions',
                    timestamp: Date.now(),
                    correlationId,
                    data: {
                        address: permissionData.address ?? this.accounts[0],
                        chainId: resolvedChain.id,
                        expiry: permissionData.expiry,
                        spender: permissionData.spender,
                        permissions: permissionData.permissions,
                        capabilities: permissionData.capabilities,
                    },
                };

                const response = await this.uiHandler.request(uiRequest);

                if (!response.approved) {
                    throw response.error || UIError.userRejected();
                }

                return response.data;
            }

            case 'wallet_revokePermissions': {
                const revokeParams = request.params as WalletRevokePermissionsRequest['params'];
                const revokeData = revokeParams[0];

                // Fetch permission from relay to get the correct chainId
                // (permission may have been granted on a different chain than current)
                const apiKey = store.config.get().apiKey;
                if (!apiKey) {
                    throw standardErrors.rpc.internal('No API key configured');
                }

                let relayPermission;
                try {
                    relayPermission = await getPermissionFromRelay(revokeData.id, apiKey);
                } catch {
                    throw standardErrors.rpc.invalidParams(
                        `Permission not found: ${revokeData.id}. It may have already been revoked.`
                    );
                }
                const permissionChainId = parseInt(relayPermission.chainId, 16);

                const uiRequest: RevokePermissionUIRequest = {
                    id: crypto.randomUUID(),
                    type: 'wallet_revokePermissions',
                    timestamp: Date.now(),
                    correlationId,
                    data: {
                        permissionId: revokeData.id,
                        address: revokeData.address ?? this.accounts[0],
                        chainId: permissionChainId,
                        capabilities: revokeData.capabilities,
                    },
                };

                const response = await this.uiHandler.request(uiRequest);

                if (!response.approved) {
                    throw response.error || UIError.userRejected();
                }

                return response.data;
            }

            case 'wallet_addFunds': {
                // Already validated and hex-normalized by `validateSigningRequest`,
                // like the other normalized methods, so there is no second parse
                // here and no second chance for the two to disagree.
                const requested = normalized?.method === 'wallet_addFunds' ? normalized.params.chainId : undefined;
                const chainId = requested ? ensureIntNumber(requested) : this.chain.id;

                const uiRequest: AddFundsUIRequest = {
                    id: crypto.randomUUID(),
                    type: 'wallet_addFunds',
                    timestamp: Date.now(),
                    correlationId,
                    data: {
                        // From the session, never from the params: a dapp that
                        // could name the destination could point the QR at an
                        // address the user does not own.
                        address: resolveDestination(this.accounts),
                        chainId,
                    },
                };

                const response = await this.uiHandler.request(uiRequest);

                // Checked like every sibling, because a non-approval here is not
                // always a rejection: `ReactUIHandler.handleReject` *resolves*
                // with `{ approved: false }`, and its error boundary routes a
                // render crash through it. Discarding the response reported
                // "screen shown and closed" for a screen that never rendered.
                //
                // A dismissal still reaches the dapp as null: the wrapper's Done
                // path approves with null, and a bare rejection carries 4001,
                // which `dispatchAddFundsRequest` maps back to null. A crash
                // carries no code, so it surfaces.
                if (!response.approved) {
                    throw response.error || UIError.userRejected();
                }

                // Deposits land off-app, so there is no outcome to report.
                return null;
            }

            default:
                // For any other signing methods, delegate to base class behavior
                // which will throw unsupportedMethod for unknown wallet_* methods
                return super.handleAuthenticatedRequest(request);
        }
    }

    override async cleanup(): Promise<void> {
        await this.uiHandler.cleanup?.();
        await super.cleanup();
    }
}
