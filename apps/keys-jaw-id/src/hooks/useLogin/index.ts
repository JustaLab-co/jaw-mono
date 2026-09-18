import { useMutation } from '@tanstack/react-query';
import { Account, type Chain } from '@jaw.id/core';
import { useAuth } from '../useAuth';

interface LoginParams {
  chainId: Chain;
  credentialId: string;
  isImported?: boolean;
  apiKey?: string;
}

export const useLogin = () => {
  const { refetch } = useAuth();

  return useMutation({
    mutationFn: async ({ chainId, credentialId, apiKey }: LoginParams) => {
      try {
        // Keyless has no key to require: first-time users come through
        // `useCreatePasskey`, and this is the path every later visit takes.
        // Refusing here is what made the second visit fail where the first
        // worked.
        const account = await Account.get(
          {
            chainId: chainId.id,
            apiKey,
            paymasterUrl: chainId.paymaster?.url,
          },
          credentialId
        );

        const metadata = account.getMetadata();
        const address = await account.getAddress();

        return {
          account,
          address,
          passkeyCredential: credentialId,
          username: metadata?.username || '',
          creationDate: metadata?.creationDate || new Date().toISOString(),
        };
      } catch (error) {
        console.error('Login failed:', error);
        throw error;
      }
    },
    onSuccess: () => {
      refetch();
    },
    onError: (error) => {
      throw error;
    },
  });
};
