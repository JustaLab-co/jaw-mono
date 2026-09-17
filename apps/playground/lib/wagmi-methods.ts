/**
 * Wagmi Methods Registry
 * Maps RPC methods to their wagmi hook implementations
 */

import { SUPPORTED_CHAINS } from '@jaw.id/core';

/**
 * Chains for a parameter that names ONE chain, where omitting it falls back to
 * the connected chain. Distinct from `CHAIN_FILTER_OPTIONS`, whose "All chains"
 * sentinel is right for a query filter (useGetAssets) and wrong here: the label
 * would promise every chain for a QR that pins exactly one. Mirrors
 * `CHAIN_OPTIONS` in rpc-methods.ts, which the same method already uses.
 */
export const CHAIN_DEFAULT_OPTIONS = [
  { label: 'Default (current chain)', value: 'default' },
  ...SUPPORTED_CHAINS.map((chain) => ({
    label: `${chain.name} (${chain.id})`,
    value: `0x${chain.id.toString(16)}`,
  })),
];

export const CHAIN_FILTER_OPTIONS = [
  { label: 'All chains', value: 'all' },
  ...SUPPORTED_CHAINS.map((chain) => ({
    label: `${chain.name} (${chain.id})`,
    value: `0x${chain.id.toString(16)}`,
  })),
];

const _DEFAULT_CHAIN_ID_NUM = parseInt(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || '84532', 10);
export const DEFAULT_CHAIN_FILTER_VALUE = SUPPORTED_CHAINS.some((c) => c.id === _DEFAULT_CHAIN_ID_NUM)
  ? `0x${_DEFAULT_CHAIN_ID_NUM.toString(16)}`
  : 'all';

export const ASSET_TYPE_FILTER_OPTIONS = [
  { label: 'All types', value: 'all' },
  { label: 'Native', value: 'native' },
  { label: 'ERC-20', value: 'erc20' },
];

export type MethodCategory =
  | 'account'
  | 'chain'
  | 'transaction'
  | 'signing'
  | 'wallet'
  | 'capability'
  | 'permission'
  | 'asset'
  | 'utility';

export const CATEGORIES: MethodCategory[] = [
  'account',
  'chain',
  'transaction',
  'signing',
  'wallet',
  'capability',
  'permission',
  'asset',
  'utility',
];

export const CATEGORY_LABELS: Record<MethodCategory, string> = {
  account: 'Account',
  chain: 'Chain',
  transaction: 'Transaction',
  signing: 'Signing',
  wallet: 'Wallet',
  capability: 'Capability',
  permission: 'Permission',
  asset: 'Asset',
  utility: 'Utility',
};

export const CATEGORY_COLORS: Record<MethodCategory, string> = {
  account: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  chain: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  transaction: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  signing: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  wallet: 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200',
  capability: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200',
  permission: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  asset: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
  utility: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200',
};

export type ParameterDefinition = {
  name: string;
  type: 'address' | 'hex' | 'number' | 'string' | 'json' | 'select' | 'toggle';
  label: string;
  description?: string;
  required: boolean;
  defaultValue?: string;
  options?: { label: string; value: string }[];
  autoFill?: 'address' | 'chainId';
  /** Only show this field when another param has a specific value */
  showWhen?: { param: string; value: string };
};

// Hook types for wagmi methods
export type WagmiHookType =
  | 'useAddFunds'
  | 'jawConnect'
  | 'jawDisconnect'
  | 'useSwitchChain'
  | 'useSendTransaction'
  | 'useSignMessage'
  | 'useSignTypedData'
  | 'useSign'
  | 'useSendCalls'
  | 'useCallsStatus'
  | 'useGrantPermissions'
  | 'useRevokePermissions'
  | 'usePermissions'
  | 'useGetAssets'
  | 'useCapabilities'
  | 'useGetCallsHistory'
  | 'utility';

export type WagmiMethod = {
  id: string;
  name: string;
  method: string;
  hookType: WagmiHookType;
  category: MethodCategory;
  description: string;
  requiresConnection: boolean;
  parameters?: ParameterDefinition[];
  getCodeSnippet: (params: Record<string, string>) => string;
  buildParams: (
    params: Record<string, string>,
    context: { address?: string; chainId?: number }
  ) => Record<string, unknown>;
};

export const WAGMI_METHODS: WagmiMethod[] = [
  // ===== Wallet Methods =====
  {
    id: 'useAddFunds',
    name: 'useAddFunds',
    method: 'wallet_addFunds',
    hookType: 'useAddFunds',
    category: 'wallet',
    description: 'Show the receive screen: chains, QR, and the account address',
    // Auto-connects like the signing methods: the screen has no address to show
    // without an account.
    requiresConnection: false,
    parameters: [
      {
        name: 'chainId',
        type: 'select',
        label: 'Chain',
        description: 'Chain the QR pins via EIP-681. Defaults to the connected chain.',
        required: false,
        defaultValue: 'default',
        options: CHAIN_DEFAULT_OPTIONS,
      },
    ],
    getCodeSnippet: (params) => {
      const args: string[] = [];
      if (params.chainId && params.chainId !== 'default') args.push(`chainId: ${parseInt(params.chainId, 16)}`);
      return `const { mutateAsync: addFunds } = useAddFunds();

// Resolves null when the user closes the screen.
await addFunds({${args.length ? ` ${args.join(', ')} ` : ''}});`;
    },
    buildParams: (params) => {
      const built: Record<string, unknown> = {};
      if (params.chainId && params.chainId !== 'default') built.chainId = parseInt(params.chainId, 16);
      return built;
    },
  },
  {
    id: 'jaw_connect',
    name: 'useConnect',
    method: 'wallet_connect',
    hookType: 'jawConnect',
    category: 'wallet',
    description: 'Connect with JAW wallet using wallet_connect',
    requiresConnection: false,
    parameters: [
      {
        name: 'enableSiwe',
        type: 'toggle',
        label: 'Enable SIWE',
        description: 'Request Sign-In with Ethereum capability',
        required: false,
        defaultValue: 'false',
      },
      {
        name: 'siweStatement',
        type: 'string',
        label: 'SIWE Statement',
        description: 'Human-readable statement for SIWE',
        required: false,
        defaultValue: 'Sign in with your JAW account',
        showWhen: { param: 'enableSiwe', value: 'true' },
      },
      {
        name: 'siweDomain',
        type: 'string',
        label: 'SIWE Domain (optional)',
        description:
          'Domain asserted in the SIWE message. Blank = this app origin. Set a foreign host (e.g. bank.com) to test cross-domain phishing detection.',
        required: false,
        showWhen: { param: 'enableSiwe', value: 'true' },
      },
      {
        name: 'enableSubnameTextRecords',
        type: 'toggle',
        label: 'Enable Subname Text Records',
        description: 'Request subname with text records (requires ENS configured)',
        required: false,
        defaultValue: 'false',
      },
      {
        name: 'subnameTextRecords',
        type: 'json',
        label: 'Text Records (JSON)',
        description: 'Array of { key, value } records to set on the subname',
        required: false,
        defaultValue: JSON.stringify(
          [
            { key: 'com.twitter', value: '@myhandle' },
            { key: 'com.github', value: 'myusername' },
          ],
          null,
          2
        ),
        showWhen: { param: 'enableSubnameTextRecords', value: 'true' },
      },
    ],
    getCodeSnippet: (params) => {
      const enableSiwe = params.enableSiwe === 'true';
      const enableSubnameTextRecords = params.enableSubnameTextRecords === 'true';

      const capabilities: string[] = [];

      if (enableSiwe) {
        const domainLine = params.siweDomain ? `\n        domain: '${params.siweDomain}',` : '';
        capabilities.push(`      signInWithEthereum: {
        nonce,
        chainId: '0x1',
        statement: '${params.siweStatement || 'Sign in with your JAW account'}',${domainLine}
      }`);
      }

      if (enableSubnameTextRecords) {
        const records = params.subnameTextRecords || '[{ "key": "com.twitter", "value": "@myhandle" }]';
        capabilities.push(`      subnameTextRecords: ${records}`);
      }

      if (capabilities.length > 0) {
        const nonceDecl = enableSiwe ? 'const nonce = crypto.randomUUID();\n\n' : '';
        return `${nonceDecl}import { useConnect } from '@jaw.id/wagmi';
import { useConnect as useWagmiConnect } from 'wagmi';

const { connectors } = useWagmiConnect();
const { mutate: connect } = useConnect();

const jawConnector = connectors.find(c => c.id === 'jaw');
connect({
  connector: jawConnector,
  capabilities: {
${capabilities.join(',\n')}
  },
});${
          enableSiwe
            ? `

// Access SIWE result
// result.accounts[0]?.capabilities?.signInWithEthereum`
            : ''
        }${
          enableSubnameTextRecords
            ? `

// Access subname result
// result.accounts[0]?.capabilities?.subnameTextRecords`
            : ''
        }`;
      }

      return `import { useConnect } from '@jaw.id/wagmi';
import { useConnect as useWagmiConnect } from 'wagmi';

const { connectors } = useWagmiConnect();
const { mutate: connect } = useConnect();

const jawConnector = connectors.find(c => c.id === 'jaw');
connect({ connector: jawConnector });`;
    },
    buildParams: (params) => {
      const enableSiwe = params.enableSiwe === 'true';
      const enableSubnameTextRecords = params.enableSubnameTextRecords === 'true';

      if (!enableSiwe && !enableSubnameTextRecords) return {};

      const capabilities: Record<string, unknown> = {};

      if (enableSiwe) {
        const nonce = Math.random().toString(36).substring(2, 15);
        capabilities.signInWithEthereum = {
          nonce,
          chainId: '0x1',
          statement: params.siweStatement || 'Sign in with your JAW account',
          ...(params.siweDomain ? { domain: params.siweDomain } : {}),
        };
      }

      if (enableSubnameTextRecords) {
        try {
          capabilities.subnameTextRecords = JSON.parse(params.subnameTextRecords || '[]');
        } catch {
          capabilities.subnameTextRecords = [];
        }
      }

      return { capabilities };
    },
  },
  {
    id: 'jaw_disconnect',
    name: 'useDisconnect',
    method: 'wallet_disconnect',
    hookType: 'jawDisconnect',
    category: 'wallet',
    description: 'Disconnect from JAW wallet',
    requiresConnection: true,
    parameters: [],
    getCodeSnippet: () => `import { useDisconnect } from '@jaw.id/wagmi';
import { useAccount } from 'wagmi';

const { connector } = useAccount();
const { mutate: disconnect } = useDisconnect();

disconnect({ connector });`,
    buildParams: () => ({}),
  },

  // ===== Chain Methods =====
  {
    id: 'wallet_switchChain',
    name: 'useSwitchChain',
    method: 'wallet_switchEthereumChain',
    hookType: 'useSwitchChain',
    category: 'chain',
    description: 'Switch to a different chain',
    requiresConnection: true,
    parameters: [
      {
        name: 'chainId',
        type: 'select',
        label: 'Target Chain',
        required: true,
        defaultValue: String(_DEFAULT_CHAIN_ID_NUM),
        options: SUPPORTED_CHAINS.map((chain) => ({
          label: `${chain.name} (${chain.id})`,
          value: String(chain.id),
        })),
      },
    ],
    getCodeSnippet: (params) => `import { useSwitchChain } from 'wagmi';

const { switchChain } = useSwitchChain();

switchChain({ chainId: ${params.chainId || _DEFAULT_CHAIN_ID_NUM} });`,
    buildParams: (params) => ({
      chainId: parseInt(params.chainId || String(_DEFAULT_CHAIN_ID_NUM)),
    }),
  },

  // ===== Transaction Methods =====
  {
    id: 'eth_sendTransaction',
    name: 'useSendTransaction',
    method: 'eth_sendTransaction',
    hookType: 'useSendTransaction',
    category: 'transaction',
    description: 'Send a transaction to the network',
    requiresConnection: true,
    parameters: [
      {
        name: 'to',
        type: 'address',
        label: 'Recipient Address',
        required: true,
      },
      {
        name: 'value',
        type: 'string',
        label: 'Amount (optional)',
        description: "Amount in the chain's native currency (e.g., 0.01). Leave empty to send none.",
        required: false,
      },
      {
        name: 'data',
        type: 'hex',
        label: 'Data (optional)',
        description: 'Transaction data in hex format',
        required: false,
      },
    ],
    getCodeSnippet: (params) => {
      const fields = [`  to: '${params.to || '0x...'}',`];
      if (params.value) fields.push(`  value: parseEther('${params.value}'),`);
      if (params.data) fields.push(`  data: '${params.data}',`);

      return `import { useSendTransaction } from 'wagmi';${params.value ? `\nimport { parseEther } from 'viem';` : ''}

const { sendTransaction } = useSendTransaction();

sendTransaction({
${fields.join('\n')}
});`;
    },
    // `value` is only sent when one was entered. Defaulting it here attached
    // 0.001 native currency to every transaction, including data-only contract
    // calls that should carry none.
    buildParams: (params) => ({
      to: params.to,
      ...(params.value ? { value: params.value } : {}),
      data: params.data || undefined,
    }),
  },
  {
    id: 'wallet_sendCalls',
    name: 'useSendCalls',
    method: 'wallet_sendCalls',
    hookType: 'useSendCalls',
    category: 'transaction',
    description: 'Send batch of calls to the network (EIP-5792)',
    requiresConnection: true,
    parameters: [
      {
        name: 'calls',
        type: 'json',
        label: 'Calls (JSON Array)',
        required: true,
        defaultValue: JSON.stringify(
          [
            {
              to: '0x0000000000000000000000000000000000000000',
              value: '0x16345785d8a0000',
            },
          ],
          null,
          2
        ),
      },
    ],
    getCodeSnippet: (params) => `import { useSendCalls } from 'wagmi';

const { sendCalls } = useSendCalls();

sendCalls({
  calls: ${params.calls || '[]'},
});`,
    buildParams: (params) => {
      try {
        return { calls: JSON.parse(params.calls || '[]') };
      } catch {
        return { calls: [] };
      }
    },
  },
  {
    id: 'wallet_getCallsStatus',
    name: 'useCallsStatus',
    method: 'wallet_getCallsStatus',
    hookType: 'useCallsStatus',
    category: 'transaction',
    description: 'Get status of batch transaction (EIP-5792)',
    requiresConnection: false,
    parameters: [
      {
        name: 'id',
        type: 'hex',
        label: 'Batch ID',
        description: 'ID returned from wallet_sendCalls',
        required: true,
      },
    ],
    getCodeSnippet: (params) => `import { useCallsStatus } from 'wagmi';

const { data: callsStatus } = useCallsStatus({
  id: '${params.id || '0x...'}',
});

console.log('Status:', callsStatus?.status);
console.log('Receipts:', callsStatus?.receipts);`,
    buildParams: (params) => ({
      id: params.id,
    }),
  },
  {
    id: 'wallet_getCallsHistory',
    name: 'useGetCallsHistory',
    method: 'wallet_getCallsHistory',
    hookType: 'useGetCallsHistory',
    category: 'transaction',
    description: 'Get transaction history for an account',
    requiresConnection: false,
    parameters: [
      {
        name: 'address',
        type: 'address',
        label: 'ENS or Address',
        description: 'Account address (optional if connected)',
        required: false,
        autoFill: 'address',
      },
      {
        name: 'limit',
        type: 'number',
        label: 'Limit',
        description: 'Maximum number of bundles to return (default: 20)',
        required: false,
        defaultValue: '20',
      },
      {
        name: 'sort',
        type: 'select',
        label: 'Sort',
        description: 'Sort direction (default: desc - newest first)',
        required: false,
        defaultValue: 'desc',
        options: [
          { label: 'Newest first (desc)', value: 'desc' },
          { label: 'Oldest first (asc)', value: 'asc' },
        ],
      },
    ],
    getCodeSnippet: (params) => `import { useGetCallsHistory } from '@jaw.id/wagmi';

// Works without wallet connection when address is provided
const { data: history, isLoading, refetch } = useGetCallsHistory(${
      params.address
        ? `{
  address: '${params.address}',
  limit: ${params.limit || 20},
  sort: '${params.sort || 'desc'}',
}`
        : ''
    });

// History contains bundles with calls and receipts
console.log('History:', history);`,
    buildParams: (params) => ({
      address: params.address || undefined,
      limit: params.limit ? parseInt(params.limit) : undefined,
      sort: params.sort || undefined,
    }),
  },

  // ===== Signing Methods =====
  {
    id: 'personal_sign',
    name: 'useSignMessage',
    method: 'personal_sign',
    hookType: 'useSignMessage',
    category: 'signing',
    description: 'Sign a message with EIP-191 (personal_sign)',
    requiresConnection: true,
    parameters: [
      {
        name: 'message',
        type: 'string',
        label: 'Message',
        required: true,
        defaultValue: 'Hello, World!',
      },
    ],
    getCodeSnippet: (params) => `import { useSignMessage } from 'wagmi';

const { signMessage, data: signature } = useSignMessage();

signMessage({ message: '${params.message ?? 'Hello, World!'}' });

console.log('Signature:', signature);`,
    buildParams: (params) => ({
      message: params.message ?? 'Hello, World!',
    }),
  },
  {
    id: 'siwe_personal_sign',
    name: 'SIWE Sign-In (test)',
    method: 'personal_sign',
    hookType: 'useSignMessage',
    category: 'signing',
    description:
      'Sign a SIWE message. Edit the domain/URI to a host other than this app to test cross-domain phishing detection.',
    requiresConnection: true,
    parameters: [
      {
        name: 'message',
        type: 'json',
        label: 'SIWE Message',
        description: 'EIP-4361 message. The domain (first line) and URI assert who you are signing in to.',
        required: true,
        defaultValue: [
          'bank.com wants you to sign in with your Ethereum account:',
          '0x0000000000000000000000000000000000000000',
          '',
          'Sign in to bank.com',
          '',
          'URI: https://bank.com',
          'Version: 1',
          'Chain ID: 1',
          'Nonce: abc12345def67890',
          'Issued At: 2025-01-01T00:00:00.000Z',
        ].join('\n'),
      },
    ],
    getCodeSnippet: (params) => `import { useSignMessage } from 'wagmi';

const { signMessage, data: signature } = useSignMessage();

const siweMessage = ${JSON.stringify(params.message ?? '')};

signMessage({ message: siweMessage });`,
    buildParams: (params) => ({
      message: params.message ?? '',
    }),
  },
  {
    id: 'eth_signTypedData_v4',
    name: 'useSignTypedData',
    method: 'eth_signTypedData_v4',
    hookType: 'useSignTypedData',
    category: 'signing',
    description: 'Sign structured typed data (EIP-712)',
    requiresConnection: true,
    parameters: [
      {
        name: 'typedData',
        type: 'json',
        label: 'Typed Data (JSON)',
        required: true,
        defaultValue: JSON.stringify(
          {
            domain: {
              name: 'JAW Demo',
              version: '1',
            },
            types: {
              Person: [
                { name: 'name', type: 'string' },
                { name: 'wallet', type: 'address' },
              ],
              Mail: [
                { name: 'from', type: 'Person' },
                { name: 'to', type: 'Person' },
                { name: 'contents', type: 'string' },
              ],
            },
            primaryType: 'Mail',
            message: {
              from: { name: 'Alice', wallet: '0x0000000000000000000000000000000000000000' },
              to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
              contents: 'Hello, Bob!',
            },
          },
          null,
          2
        ),
      },
    ],
    getCodeSnippet: (params) => {
      const typedData = params.typedData || '{}';
      return `import { useSignTypedData } from 'wagmi';

const { signTypedData, data: signature } = useSignTypedData();

const typedData = ${typedData};

signTypedData({
  domain: typedData.domain,
  types: typedData.types,
  primaryType: typedData.primaryType,
  message: typedData.message,
});

console.log('Signature:', signature);`;
    },
    buildParams: (params) => {
      try {
        return JSON.parse(params.typedData || '{}');
      } catch {
        return {};
      }
    },
  },
  {
    id: 'wallet_sign',
    name: 'useSign',
    method: 'wallet_sign',
    hookType: 'useSign',
    category: 'signing',
    description: 'Unified signing (ERC-7871) with chain support',
    requiresConnection: true,
    parameters: [
      {
        name: 'signType',
        type: 'select',
        label: 'Signature Type',
        required: true,
        defaultValue: '0x45',
        options: [
          { label: 'Personal Sign (0x45)', value: '0x45' },
          { label: 'Typed Data (0x01)', value: '0x01' },
        ],
      },
      {
        name: 'message',
        type: 'string',
        label: 'Message (for Personal Sign)',
        description: 'Message to sign (only used when type is 0x45)',
        required: false,
        defaultValue: 'Hello, World!',
      },
      {
        name: 'typedData',
        type: 'json',
        label: 'Typed Data (for EIP-712)',
        description: 'Typed data object (only used when type is 0x01)',
        required: false,
        defaultValue: JSON.stringify(
          {
            domain: {
              name: 'JAW Demo',
              version: '1',
            },
            types: {
              Person: [
                { name: 'name', type: 'string' },
                { name: 'wallet', type: 'address' },
              ],
              Mail: [
                { name: 'from', type: 'Person' },
                { name: 'to', type: 'Person' },
                { name: 'contents', type: 'string' },
              ],
            },
            primaryType: 'Mail',
            message: {
              from: { name: 'Alice', wallet: '0x0000000000000000000000000000000000000000' },
              to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
              contents: 'Hello, Bob!',
            },
          },
          null,
          2
        ),
      },
    ],
    getCodeSnippet: (params) => {
      const isPersonalSign = params.signType === '0x45';

      if (isPersonalSign) {
        return `import { useSign } from '@jaw.id/wagmi';

const { mutate: sign, data: signature } = useSign();

sign({
  request: {
    type: '0x45',
    data: { message: '${params.message || 'Hello, World!'}' },
  },
});

console.log('Signature:', signature);`;
      } else {
        return `import { useSign } from '@jaw.id/wagmi';

const { mutate: sign, data: signature } = useSign();

const typedData = ${params.typedData || '{}'};

sign({
  request: {
    type: '0x01',
    data: typedData,
  },
});

console.log('Signature:', signature);`;
      }
    },
    buildParams: (params) => {
      const isPersonalSign = params.signType === '0x45';

      if (isPersonalSign) {
        return {
          request: {
            type: '0x45' as const,
            data: { message: params.message || 'Hello, World!' },
          },
        };
      } else {
        try {
          const typedData = JSON.parse(params.typedData || '{}');
          return {
            request: {
              type: '0x01' as const,
              data: typedData,
            },
          };
        } catch {
          return {
            request: {
              type: '0x01' as const,
              data: {},
            },
          };
        }
      }
    },
  },

  // ===== Capability Methods =====
  {
    id: 'wallet_getCapabilities',
    name: 'useCapabilities',
    method: 'wallet_getCapabilities',
    hookType: 'useCapabilities',
    category: 'capability',
    description: 'Get wallet capabilities per chain (EIP-5792)',
    requiresConnection: false,
    parameters: [
      {
        name: 'address',
        type: 'address',
        label: 'ENS or Address',
        description: 'Account address (optional)',
        required: false,
        autoFill: 'address',
      },
    ],
    getCodeSnippet: (params) => `import { useCapabilities } from '@jaw.id/wagmi';

// Works without wallet connection when address is provided
const { data: capabilities, isLoading, refetch } = useCapabilities(${
      params.address
        ? `{
  address: '${params.address}',
}`
        : ''
    });

// Capabilities are keyed by chain ID (hex)
// e.g., { '0x14a34': { atomicBatch: { supported: true }, ... } }
console.log('Capabilities:', capabilities);`,
    buildParams: (params) => ({
      address: params.address || undefined,
    }),
  },

  // ===== Permission Methods =====
  {
    id: 'wallet_grantPermissions',
    name: 'useGrantPermissions',
    method: 'wallet_grantPermissions',
    hookType: 'useGrantPermissions',
    category: 'permission',
    description: 'Grant call and spend permissions to a spender (ERC-7715)',
    requiresConnection: true,
    parameters: [
      {
        name: 'spender',
        type: 'address',
        label: 'Spender',
        description: 'Address receiving permissions',
        required: true,
      },
      {
        name: 'expiryDays',
        type: 'number',
        label: 'Expiry (days)',
        description: 'Number of days until permission expires',
        required: true,
        defaultValue: '7',
      },
      {
        name: 'permissions',
        type: 'json',
        label: 'Permissions (JSON)',
        required: true,
        defaultValue: JSON.stringify(
          {
            calls: [
              {
                target: '0x3232323232323232323232323232323232323232',
                selector: '0xe0e0e0e0',
              },
            ],
            spends: [
              {
                token: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
                allowance: '0x16345785d8a0000',
                unit: 'day',
                multiplier: 1,
              },
            ],
          },
          null,
          2
        ),
      },
    ],
    getCodeSnippet: (params) => `import { useGrantPermissions } from '@jaw.id/wagmi';

const { mutate: grantPermissions } = useGrantPermissions();

const expiryDays = ${params.expiryDays || 7};
const expiry = Math.floor(Date.now() / 1000) + (expiryDays * 24 * 60 * 60);

grantPermissions({
  spender: '${params.spender || '0x...'}',
  expiry,
  permissions: ${params.permissions || '{}'},
});`,
    buildParams: (params) => {
      const expiryDays = parseInt(params.expiryDays || '7');
      const expiry = Math.floor(Date.now() / 1000) + expiryDays * 24 * 60 * 60;
      try {
        return {
          spender: params.spender,
          expiry,
          permissions: JSON.parse(params.permissions || '{}'),
        };
      } catch {
        return { spender: params.spender, expiry, permissions: {} };
      }
    },
  },
  {
    id: 'wallet_revokePermissions',
    name: 'useRevokePermissions',
    method: 'wallet_revokePermissions',
    hookType: 'useRevokePermissions',
    category: 'permission',
    description: 'Revoke previously granted permissions',
    requiresConnection: true,
    parameters: [
      {
        name: 'id',
        type: 'hex',
        label: 'Permission ID',
        description: 'ID of the permission to revoke',
        required: true,
      },
    ],
    getCodeSnippet: (params) => `import { useRevokePermissions } from '@jaw.id/wagmi';

const { mutate: revokePermissions } = useRevokePermissions();

revokePermissions({
  id: '${params.id || '0x...'}',
});`,
    buildParams: (params) => ({
      id: params.id,
    }),
  },
  {
    id: 'wallet_getPermissions',
    name: 'usePermissions',
    method: 'wallet_getPermissions',
    hookType: 'usePermissions',
    category: 'permission',
    description: 'Get all permissions for an account',
    requiresConnection: false,
    parameters: [
      {
        name: 'address',
        type: 'address',
        label: 'ENS or Address',
        description: 'Account address (optional if connected)',
        required: false,
        autoFill: 'address',
      },
    ],
    getCodeSnippet: (params) => `import { usePermissions } from '@jaw.id/wagmi';

// Works without wallet connection when address is provided
const { data: permissions, isLoading, refetch } = usePermissions(${
      params.address
        ? `{
  address: '${params.address}',
}`
        : ''
    });

console.log('Permissions:', permissions);`,
    buildParams: (params) => ({
      address: params.address || undefined,
    }),
  },

  // ===== Asset Methods =====
  {
    id: 'wallet_getAssets',
    name: 'useGetAssets',
    method: 'wallet_getAssets',
    hookType: 'useGetAssets',
    category: 'asset',
    description: 'Get token balances across chains (EIP-7811)',
    requiresConnection: false,
    parameters: [
      {
        name: 'address',
        type: 'address',
        label: 'ENS or Address',
        description: 'Account address (optional if connected)',
        required: false,
        autoFill: 'address',
      },
      {
        name: 'chainFilter',
        type: 'select',
        label: 'Chain Filter',
        description: 'Narrow results to a specific chain',
        required: false,
        defaultValue: DEFAULT_CHAIN_FILTER_VALUE,
        options: CHAIN_FILTER_OPTIONS,
      },
      {
        name: 'assetTypeFilter',
        type: 'select',
        label: 'Asset Type Filter',
        description: 'Restrict results by asset category',
        required: false,
        defaultValue: 'all',
        options: ASSET_TYPE_FILTER_OPTIONS,
      },
      {
        name: 'assetFilter',
        type: 'json',
        label: 'Asset Filter (JSON)',
        description: 'Filter by specific assets per chain, e.g. {"0x1":[{"address":"0x...","type":"erc20"}]}',
        required: false,
      },
    ],
    getCodeSnippet: (params) => {
      const entries: string[] = [];
      if (params.address) entries.push(`  address: '${params.address}',`);
      if (params.chainFilter && params.chainFilter !== 'all') {
        entries.push(`  chainFilter: ['${params.chainFilter}'],`);
      }
      if (params.assetTypeFilter && params.assetTypeFilter !== 'all') {
        entries.push(`  assetTypeFilter: ['${params.assetTypeFilter}'],`);
      }
      if (params.assetFilter && params.assetFilter.trim()) {
        entries.push(`  assetFilter: ${params.assetFilter.trim()},`);
      }
      const arg = entries.length ? `{\n${entries.join('\n')}\n}` : '';
      return `import { useGetAssets } from '@jaw.id/wagmi';

// Works without wallet connection when address is provided
const { data: assets, isLoading, refetch } = useGetAssets(${arg});

// Assets are grouped by chain ID (hex)
// e.g., { '0x14a34': [{ address: '0x...', symbol: 'ETH', ... }] }
console.log('Assets:', assets);`;
    },
    buildParams: (params) => {
      const args: Record<string, unknown> = {
        address: params.address || undefined,
      };
      if (params.chainFilter && params.chainFilter !== 'all') {
        args.chainFilter = [params.chainFilter];
      }
      if (params.assetTypeFilter && params.assetTypeFilter !== 'all') {
        args.assetTypeFilter = [params.assetTypeFilter];
      }
      if (params.assetFilter && params.assetFilter.trim()) {
        args.assetFilter = JSON.parse(params.assetFilter);
      }
      return args;
    },
  },

  // ===== Utility Tools =====
  {
    id: 'encode_function_data',
    name: 'encodeFunctionData',
    method: 'encode_function_data',
    hookType: 'utility' as const,
    category: 'utility',
    description: 'Generate ABI-encoded calldata from a Solidity function signature and arguments.',
    requiresConnection: false,
    getCodeSnippet: () => `import { encodeFunctionData, parseAbiItem } from 'viem';

const data = encodeFunctionData({
  abi: [parseAbiItem('function transfer(address to, uint256 amount)')],
  functionName: 'transfer',
  args: ['0xRecipient...', 1000000000000000000n],
});`,
    buildParams: () => ({}),
  },
];
