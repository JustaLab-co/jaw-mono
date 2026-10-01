import { z } from 'zod';

/**
 * Single generic RPC method schema.
 * Accepts any EIP-1193 RPC method and forwards to JAWProvider.
 */
export const rpcMethodSchema = {
  method: z
    .string()
    .describe(
      'EIP-1193 RPC method name (e.g. wallet_connect, wallet_sendCalls, personal_sign). ' +
        'Read the jaw://api-reference resource for the full list and jaw://api-reference/{method} for parameter details.'
    ),
  params: z
    .any()
    .optional()
    .describe(
      'Method parameters — structure varies by method. ' +
        'Read the jaw://api-reference/{method} resource for the expected format.'
    ),
  chainId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Target chain ID (overrides default). E.g., 1 for Ethereum, 8453 for Base, 84532 for Base Sepolia'),
  session: z
    .boolean()
    .optional()
    .describe(
      'Sign with the local session key instead of opening the browser (requires `jaw session setup`; ' +
        'check jaw_session_status first). Supported methods only: eth_requestAccounts, eth_accounts, ' +
        'wallet_sendCalls, wallet_getCallsStatus. personal_sign and eth_signTypedData_v4 are browser ' +
        'only: a signature made by the session key never passes the spend caps or the ledger. ' +
        'Defaults to the JAW_SESSION env var.'
    ),
};

export const configSetSchema = {
  // keysUrl and relayUrl decide where signing requests go, so only a person
  // changes them, through `jaw config set`.
  key: z.enum(['apiKey', 'defaultChain', 'ens', 'sessionExpiry']).describe('Config key'),
  value: z.string().describe('Config value'),
};

const httpUrl = z
  .string()
  .url()
  .refine(
    (u) => {
      try {
        const p = new URL(u).protocol;
        return p === 'http:' || p === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'url must be http(s) — other schemes (file:, data:, javascript:, ftp:) are not fetched' }
  );

export const payAndFetchSchema = {
  url: httpUrl.describe('Resource URL to fetch (http/https only). If it answers HTTP 402 (x402), pay and retry.'),
  method: z.string().optional().describe('HTTP method (default GET).'),
  headers: z.record(z.string()).optional().describe('Extra request headers.'),
  body: z.string().optional().describe('Request body (for POST/PUT/etc.).'),
  maxAmount: z
    .string()
    .optional()
    .describe(
      'Hard ceiling for THIS call, in the asset base units (e.g. 6-decimals for USDC). ' +
        'If the 402 asks for more, the payment is refused, not made.'
    ),
  asset: z.string().optional().describe('Require a specific asset contract address.'),
  network: z.string().optional().describe('Require a specific CAIP-2 network, e.g. eip155:8453 (Base).'),
};

export const discoverSchema = {
  query: z
    .string()
    .max(400)
    .optional()
    .describe(
      'Keyword or natural-language search over the x402 Bazaar catalog of paid services ' +
        '(e.g. "ens resolver", "weather api", "token price"). Required unless `payTo` is set.'
    ),
  network: z
    .string()
    .optional()
    .describe('CAIP-2 network to prefer when picking the price to show, e.g. eip155:8453 (Base, default).'),
  maxUsdPrice: z.string().optional().describe('Only return services priced at or below this many USD per call.'),
  curatedOnly: z.boolean().optional().describe('Only return Coinbase-curated (health-probed) services.'),
  limit: z.number().int().min(1).max(20).optional().describe('Maximum results to return (1-20, default 10).'),
  payTo: z
    .string()
    .optional()
    .describe(
      'Instead of searching, list every service registered by this seller address (0x…). ' +
        'Takes precedence over `query` if both are given.'
    ),
};

export const x402LogSchema = {
  limit: z.number().optional().describe('Return only the most recent N ledger entries (default: all).'),
};

export const x402BalanceSchema = {
  network: z
    .string()
    .optional()
    .describe('CAIP-2 network to check the USDC balance on, e.g. eip155:8453 (Base) or eip155:84532 (Base Sepolia).'),
};
