// High-level Account API (recommended)
export {
    Account,
    type AccountConfig,
    type CreateAccountOptions,
    type TransactionCall,
    type SendCallsOptions,
    type AccountMetadata,
} from './Account.js';

// Call status types (EIP-5792)
export { type CallReceipt, type CallStatusResponse } from '../rpc/wallet_sendCalls.js';

// Chain configuration
export { SUPPORTED_CHAINS, MAINNET_CHAINS, TESTNET_CHAINS, getSupportedChains } from './smartAccount.js';

// Advanced: Low-level smart account creation (for custom implementations)
export { toJustanAccount, type ToJustanAccountParameters, type ToJustanAccountReturnType } from './toJustanAccount.js';

// Advanced: Temporary smart account for signing on behalf of another account
export { createSmartAccountForAddress } from './smartAccount.js';

// EIP-7702 delegation utilities
export { isDelegatedToImplementation } from './delegation.js';

// Options for the grant, and the spender prefund a grant screen shows before it
export {
    spenderPrefundCall,
    type GrantPermissionsOptions,
    type SpenderPrefund,
    type SpenderPrefundQuote,
} from './spenderPrefund.js';

// ERC-20 Paymaster utilities
export {
    fetchTokenQuotes,
    estimateErc20PaymasterCosts,
    encodeApprovalCall,
    buildErc20PaymasterContext,
    calculateTokenCostFromGas,
    calculateDisplayTokenCost,
    computeEffectiveGasPrice,
    type TokenQuote,
    type TokenEstimate,
    type TokenInfo,
    type UserOpGasFields,
} from './erc20Paymaster.js';
