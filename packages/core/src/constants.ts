export const JAW_WALLET_ICON: `data:image/${string}` = `data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzgiIGhlaWdodD0iMzgiIHZpZXdCb3g9IjAgMCAzOCAzOCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjM4IiBoZWlnaHQ9IjM4IiByeD0iNCIgZmlsbD0id2hpdGUiLz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTMsIDApIj4KPHJlY3Qgd2lkdGg9IjcuMzk3MDQiIGhlaWdodD0iNy4zOTcwNCIgdHJhbnNmb3JtPSJtYXRyaXgoLTAuODY2MDI1IDAuNSAwIC0xIDIxLjk5NDYgMjkuMzAxNCkiIGZpbGw9IiMwMjA2MTciLz4KPHJlY3Qgd2lkdGg9IjcuMzk3MDQiIGhlaWdodD0iNy4zOTcwNCIgdHJhbnNmb3JtPSJtYXRyaXgoLTAuODY2MDI1IDAuNSAwIC0xIDIxLjk5NDYgMjAuODYwMykiIGZpbGw9IiMwMjA2MTciLz4KPHJlY3Qgd2lkdGg9IjcuMzk3MDQiIGhlaWdodD0iNy4zOTcwNCIgdHJhbnNmb3JtPSJtYXRyaXgoLTAuODY2MDI1IDAuNSAwIC0xIDM0Ljc5MDMgMjkuMzAxNCkiIGZpbGw9IiMwMjA2MTciLz4KPHJlY3Qgd2lkdGg9IjcuMzk3MDQiIGhlaWdodD0iNy4zOTcwNCIgdHJhbnNmb3JtPSJtYXRyaXgoLTAuODY2MDI1IDAuNSAwIC0xIDM0Ljc5MDMgMjAuODYwMykiIGZpbGw9IiMwMjA2MTciLz4KPHJlY3Qgd2lkdGg9IjcuMzk3MDQiIGhlaWdodD0iNy4zOTcwNCIgdHJhbnNmb3JtPSJtYXRyaXgoLTAuODY2MDI1IDAuNSAwIC0xIDM0Ljc5MDMgMTIuMzk3KSIgZmlsbD0iIzAyMDYxNyIvPgo8cmVjdCB3aWR0aD0iNy4zOTcwNCIgaGVpZ2h0PSI3LjM5NzA0IiB0cmFuc2Zvcm09Im1hdHJpeCgtMC44NjYwMjUgLTAuNSAwIDEgMTUuNjA2IDI1LjYwMjkpIiBmaWxsPSIjMDIwNjE3Ii8+CjxyZWN0IHdpZHRoPSI3LjM5NzA0IiBoZWlnaHQ9IjcuMzk3MDQiIHRyYW5zZm9ybT0ibWF0cml4KC0wLjg2NjAyNSAtMC41IDAgMSAyOC40MDE0IDI1LjYwMjkpIiBmaWxsPSIjMDIwNjE3Ii8+CjxyZWN0IHdpZHRoPSI3LjM5NzA0IiBoZWlnaHQ9IjcuMzk3MDQiIHRyYW5zZm9ybT0ibWF0cml4KC0wLjg2NjAyNSAtMC41IDAgMSAyOC40MDE0IDE3LjE2MTgpIiBmaWxsPSIjMDIwNjE3Ii8+CjwvZz4KPC9zdmc+`;

export const JAW_WALLET_NAME = 'JAW';

export const JAW_WALLET_ID = 'jaw';
export const JAW_KEYS_URL = 'https://keys.jaw.id';
export const JAW_WALLET_RDNS = 'keys.jaw.id';

export const JAW_BASE_URL = 'https://api.justaname.id';
export const JAW_PROXY_URL = `${JAW_BASE_URL}/proxy/v1`;
export const JAW_RPC_URL = `${JAW_PROXY_URL}/rpc`;
export const JAW_PAYMASTER_URL = `${JAW_RPC_URL}/erc20-paymaster`;

/**
 * The URL for JAW's ERC-20 paymaster on a chain.
 *
 * One place because `Account` recognises this paymaster by comparing the part
 * before the query string against `JAW_PAYMASTER_URL` exactly, and only then
 * adds the token approval the paymaster needs to charge. A caller that builds
 * the URL by hand and gets the path wrong does not fail here: it gets a
 * transaction with no approval on it, which fails later as something else.
 */
export function jawPaymasterUrl(chainId: number, apiKey?: string): string {
    return `${JAW_PAYMASTER_URL}?chainId=${chainId}${apiKey ? `&api-key=${apiKey}` : ''}`;
}
export const JAW_PASSKEYS_URL = `${JAW_BASE_URL}/wallet/v2/passkeys`;

export const FACTORY_ADDRESS = '0x5803c076563C85799989d42Fc00292A8aE52fa9E';
export const CONTRACT_NAME = 'JustanAccount';
export const CONTRACT_VERSION = '1';

export const PERMISSIONS_MANAGER_ADDRESS = '0xf1b40E3D5701C04d86F7828f0EB367B9C90901D8';

export const EIP7702_CODE_PREFIX = '0xef0100';
export const ERC20_PAYMASTER_ADDRESS = '0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402';
