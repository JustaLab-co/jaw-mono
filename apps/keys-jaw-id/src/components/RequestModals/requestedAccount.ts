import { SDKRequestType } from '../../lib/sdk-types';
import type { PendingRequest } from '../../utils/types';
import type { TransactionRequestData } from '../TransactionModal';

/**
 * The account a request names, which its screen signs for. Undefined when it names none.
 *
 * The sign screens take their `address` from here too, so the account the popup checks is the one
 * the screen signs for.
 */
export function requestedAccount(
  pendingRequest: PendingRequest,
  txData: TransactionRequestData | null
): string | undefined {
  // wallet_sign (ERC-7871): params[0] is { request, address }.
  const walletSignAddress = () => (pendingRequest.params[0] as { address?: string } | undefined)?.address;

  switch (pendingRequest.type) {
    case SDKRequestType.SEND_TRANSACTION:
      return txData?.from;
    // personal_sign: params[1] is the address.
    case SDKRequestType.SIGN_MESSAGE:
      return pendingRequest.method === 'wallet_sign'
        ? walletSignAddress()
        : (pendingRequest.params[1] as string | undefined);
    // eth_signTypedData_v4: params[0] is the address.
    case SDKRequestType.SIGN_TYPED_DATA:
      return pendingRequest.method === 'wallet_sign'
        ? walletSignAddress()
        : (pendingRequest.params[0] as string | undefined);
    // Read from the same params PermissionModal reads its `address` from.
    case SDKRequestType.GRANT_PERMISSIONS:
    case SDKRequestType.REVOKE_PERMISSIONS:
      return (pendingRequest.params[0] as { address?: string } | undefined)?.address;
    default:
      return undefined;
  }
}
