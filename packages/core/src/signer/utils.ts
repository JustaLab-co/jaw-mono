import { SignerType } from '../messages/index.js';
import { standardErrors } from '../errors/index.js';
import { AppMetadata, ProviderEventCallback, PaymasterConfig } from '../provider/index.js';
import { Communicator } from '../communicator/index.js';
import { Signer } from './interface.js';
import { CrossPlatformSigner } from './cross-platform/CrossPlatformSigner.js';
import { AppSpecificSigner } from './app-specific/AppSpecificSigner.js';
import { UIHandler } from '../ui/interface.js';
import type { JawTheme } from '../ui/theme.js';

// Re-export storage functions for backward compatibility
export { loadSignerType, storeSignerType, clearSignerType } from './signerStorage.js';

export function createSigner(params: {
    signerType: SignerType;
    metadata: AppMetadata;
    communicator?: Communicator;
    uiHandler?: UIHandler;
    callback: ProviderEventCallback;
    apiKey?: string;
    paymasters?: Record<number, PaymasterConfig>;
    ens?: string;
    theme?: JawTheme;
}): Signer {
    const { signerType, metadata, communicator, uiHandler, callback, apiKey, paymasters, ens, theme } = params;

    switch (signerType) {
        case 'crossPlatform': {
            if (!communicator) {
                throw standardErrors.rpc.internal('Communicator is required for crossPlatform signer');
            }
            return new CrossPlatformSigner({
                metadata,
                callback,
                communicator,
            });
        }

        case 'appSpecific': {
            if (!uiHandler) {
                throw standardErrors.rpc.internal('UIHandler is required for appSpecific signer');
            }
            // Already refused at config time in create(); kept as the last word on
            // the type, which allows the key to be absent for the other mode.
            if (!apiKey) {
                throw standardErrors.rpc.internal('API key is required for appSpecific signer');
            }
            return new AppSpecificSigner({
                metadata,
                callback,
                uiHandler,
                apiKey,
                paymasters,
                ens,
                theme,
            });
        }
    }
}
