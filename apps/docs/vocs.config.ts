import { defineConfig } from 'vocs/config';

// NOTE: Vocs 2.x has no `head`/script-injection config option, so PostHog is
// injected into the built static HTML by a post-build step
//
// (scripts/inject-analytics.ts), per the official Vocs recommendation.
// Analytics is gated on VITE_ANALYTICS_ENABLED (set in Vercel Production env).

export default defineConfig({
  srcDir: 'docs',
  outDir: 'docs/dist',
  // Full static site generation (v1 deployed as static HTML; Vocs v2 defaults to 'dynamic'/SSR).
  renderStrategy: 'full-static',
  // Set to 'warn' to allow build to succeed with dead links (they'll be logged as warnings)
  checkDeadlinks: 'warn',
  title: 'JAW.id Documentation',
  description: 'Official documentation for JAW.id',
  logoUrl: {
    light: '/logo.svg',
    dark: '/logo-dark.svg',
  },
  iconUrl: '/favicon.ico',
  topNav: [
    { text: 'SDK', link: '/', match: '/' },
    { text: 'CLI', link: '/cli', match: '/cli' },
    { text: 'GitHub', link: 'https://github.com/JustaName-id/jaw-mono' },
  ],
  socials: [
    {
      icon: 'github',
      link: 'https://github.com/JustaName-id/jaw-mono',
    },
    {
      icon: 'x',
      link: 'https://x.com/_JAW_ID',
    },
    {
      icon: 'telegram',
      link: 'https://t.me/+RsFLPfky7-YxZjVk',
    },
  ],
  sidebar: {
    '/': [
      {
        text: 'Why JAW',
        link: '/why-jaw',
      },
      {
        text: 'Getting Started',
        link: '/',
      },
      {
        text: 'LLMs',
        link: '/llms',
      },
      {
        text: 'Core Concepts',
        collapsed: false,
        items: [
          { text: 'Smart Accounts vs EOAs', link: '/concepts/smart-accounts' },
          { text: 'ENS for Every Account', link: '/concepts/ens' },
          { text: 'Passkeys & WebAuthn', link: '/concepts/passkeys' },
          { text: 'The Permission Layer', link: '/concepts/permissions' },
        ],
      },
      {
        text: 'Supported Networks',
        link: '/supported-networks',
      },
      {
        text: 'Configuration',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/configuration' },
          { text: 'apiKey', link: '/configuration/apiKey' },
          { text: 'ens', link: '/configuration/ens' },
          { text: 'appName', link: '/configuration/appName' },
          { text: 'appLogoUrl', link: '/configuration/appLogoUrl' },
          { text: 'defaultChainId', link: '/configuration/defaultChainId' },
          {
            text: 'mode',
            collapsed: true,
            items: [
              { text: 'Overview', link: '/configuration/mode' },
              {
                text: 'CrossPlatform',
                link: '/configuration/mode/cross-platform',
              },
              { text: 'AppSpecific', link: '/configuration/mode/app-specific' },
            ],
          },
          { text: 'transportMode', link: '/configuration/transportMode' },
          { text: 'paymasters', link: '/configuration/paymasters' },
          { text: 'theme', link: '/configuration/theme' },
        ],
      },
      {
        text: 'Guides',
        collapsed: false,
        items: [
          { text: 'Quickstart', link: '/guides/quickstart' },
          {
            text: 'Upgrade EOA to Smart Account (EIP-7702)',
            link: '/guides/eip7702-upgrade',
          },
          {
            text: 'Embed Stablecoin Payments (Headless)',
            link: '/guides/embed-stablecoin-payments',
          },
          { text: 'Onchain Identity', link: '/guides/onchain-identity' },
          { text: 'Gas Sponsoring', link: '/guides/gas-sponsoring' },
          { text: 'Sign-In With Ethereum', link: '/guides/siwe' },
          { text: 'Subscription Payments', link: '/guides/subscription' },
          { text: 'Reown AppKit', link: '/guides/reown-appkit' },
        ],
      },
      {
        text: 'Wagmi',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/wagmi' },
          { text: 'Connector', link: '/wagmi/jaw' },
          {
            text: 'Hooks',
            collapsed: false,
            items: [
              {
                text: 'useGetCallsHistory()',
                link: '/wagmi/useGetCallsHistory',
              },
              { text: 'useAddFunds()', link: '/wagmi/useAddFunds' },
              { text: 'useCapabilities()', link: '/wagmi/useCapabilities' },
              { text: 'useConnect()', link: '/wagmi/useConnect' },
              { text: 'useDisconnect()', link: '/wagmi/useDisconnect' },
              { text: 'useGetAssets()', link: '/wagmi/useGetAssets' },
              {
                text: 'useGrantPermissions()',
                link: '/wagmi/useGrantPermissions',
              },
              { text: 'usePermissions()', link: '/wagmi/usePermissions' },
              {
                text: 'useRevokePermissions()',
                link: '/wagmi/useRevokePermissions',
              },
              { text: 'useSign()', link: '/wagmi/useSign' },
            ],
          },
        ],
      },
      {
        text: 'Provider - RPC Reference',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/api-reference' },
          {
            text: 'eth_requestAccounts',
            link: '/api-reference/eth_requestAccounts',
          },
          { text: 'eth_accounts', link: '/api-reference/eth_accounts' },
          { text: 'eth_chainId', link: '/api-reference/eth_chainId' },
          {
            text: 'eth_sendTransaction',
            link: '/api-reference/eth_sendTransaction',
          },
          {
            text: 'eth_signTypedData_v4',
            link: '/api-reference/eth_signTypedData_v4',
          },
          { text: 'personal_sign', link: '/api-reference/personal_sign' },
          { text: 'wallet_connect', link: '/api-reference/wallet_connect' },
          {
            text: 'wallet_disconnect',
            link: '/api-reference/wallet_disconnect',
          },
          {
            text: 'wallet_switchEthereumChain',
            link: '/api-reference/wallet_switchEthereumChain',
          },
          { text: 'wallet_sendCalls', link: '/api-reference/wallet_sendCalls' },
          { text: 'wallet_sign', link: '/api-reference/wallet_sign' },
          {
            text: 'wallet_getCapabilities',
            link: '/api-reference/wallet_getCapabilities',
          },
          {
            text: 'wallet_getPermissions',
            link: '/api-reference/wallet_getPermissions',
          },
          {
            text: 'wallet_grantPermissions',
            link: '/api-reference/wallet_grantPermissions',
          },
          {
            text: 'wallet_revokePermissions',
            link: '/api-reference/wallet_revokePermissions',
          },
          { text: 'wallet_addFunds', link: '/api-reference/wallet_addFunds' },
          { text: 'wallet_getAssets', link: '/api-reference/wallet_getAssets' },
          {
            text: 'wallet_getCallsStatus',
            link: '/api-reference/wallet_getCallsStatus',
          },
          {
            text: 'wallet_getCallsHistory',
            link: '/api-reference/wallet_getCallsHistory',
          },
        ],
      },
      {
        text: 'Account',
        collapsed: true,
        items: [
          { text: 'Overview', link: '/account' },
          {
            text: 'Factory',
            collapsed: true,
            items: [
              { text: 'get()', link: '/account/get' },
              { text: 'create()', link: '/account/create' },
              { text: 'import()', link: '/account/import' },
              { text: 'restore()', link: '/account/restore' },
              { text: 'fromLocalAccount()', link: '/account/fromLocalAccount' },
            ],
          },
          {
            text: 'Utility',
            collapsed: true,
            items: [
              {
                text: 'getAuthenticatedAddress()',
                link: '/account/getAuthenticatedAddress',
              },
              {
                text: 'getCurrentAccount()',
                link: '/account/getCurrentAccount',
              },
              {
                text: 'getStoredAccounts()',
                link: '/account/getStoredAccounts',
              },
              { text: 'logout()', link: '/account/logout' },
            ],
          },
          {
            text: 'Information',
            collapsed: true,
            items: [
              { text: 'getMetadata()', link: '/account/getMetadata' },
              { text: 'getSmartAccount()', link: '/account/getSmartAccount' },
              { text: 'getChain()', link: '/account/getChain' },
              { text: 'getAddress()', link: '/account/getAddress' },
            ],
          },
          {
            text: 'Signing',
            collapsed: true,
            items: [
              { text: 'signMessage()', link: '/account/signMessage' },
              { text: 'signTypedData()', link: '/account/signTypedData' },
            ],
          },
          {
            text: 'Transactions',
            collapsed: true,
            items: [
              { text: 'sendTransaction()', link: '/account/sendTransaction' },
              { text: 'sendCalls()', link: '/account/sendCalls' },
              { text: 'getCallStatus()', link: '/account/getCallStatus' },
              { text: 'estimateGas()', link: '/account/estimateGas' },
            ],
          },
          {
            text: 'Permissions',
            collapsed: true,
            items: [
              { text: 'grantPermissions()', link: '/account/grantPermissions' },
              { text: 'revokePermission()', link: '/account/revokePermission' },
              { text: 'getPermission()', link: '/account/getPermission' },
            ],
          },
        ],
      },
      {
        text: 'Advanced',
        collapsed: true,
        items: [
          { text: 'Overview', link: '/advanced' },
          { text: 'Custom UI Handler', link: '/advanced/custom-ui-handler' },
          { text: 'Custom Passkey Server', link: '/advanced/passkey-server' },
        ],
      },
    ],
    '/cli': [
      {
        text: 'Overview',
        link: '/cli',
      },
      {
        text: 'Configuration',
        link: '/cli/configuration',
      },
      {
        text: 'Auto Mode',
        items: [
          { text: 'Overview', link: '/cli/auto-mode' },
          { text: 'Setup', link: '/cli/auto-mode/setup' },
          { text: 'Usage', link: '/cli/auto-mode/usage' },
        ],
      },
      {
        text: 'Commands',
        link: '/cli/commands',
      },
      {
        text: 'Paying for APIs (x402)',
        link: '/cli/x402',
      },
      {
        text: 'MCP Server',
        link: '/cli/mcp',
      },
      {
        text: 'RPC Reference',
        link: '/cli/api-reference',
      },
    ],
  },
  editLink: {
    pattern: 'https://github.com/JustaName-id/jaw-mono/edit/main/apps/docs/docs/pages/:path',
    text: 'Edit on GitHub',
  },
});
