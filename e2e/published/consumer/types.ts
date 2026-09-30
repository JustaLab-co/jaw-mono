import { create, SDK_VERSION, type CreateJAWSDKOptions } from '@jaw.id/core';
import { jaw, type JawParameters } from '@jaw.id/wagmi';
import { ReactUIHandler, SignatureDialog } from '@jaw.id/ui';

export const options: Pick<CreateJAWSDKOptions, 'apiKey'> = { apiKey: 'key' };
export const parameters: Pick<JawParameters, 'apiKey'> = { apiKey: 'key' };
export const exported = [create, SDK_VERSION, jaw, ReactUIHandler, SignatureDialog] as const;
