# @jaw.id/core

Core SDK for [JAW.id](https://jaw.id): embed smart account wallets into any app with passkeys signing, gas sponsorship, and granular permissions.

## Documentation

For documentation and guides, visit [docs.jaw.id](https://docs.jaw.id)

## Installation

```bash
npm install @jaw.id/core
# or
bun add @jaw.id/core
```

## Quick Start

```typescript
import { JAW } from '@jaw.id/core';

const jaw = JAW.create({
  appName: 'My App',
  apiKey: 'your-api-key',
});

// Connect
const accounts = await jaw.provider.request({ method: 'eth_requestAccounts' });

// Send a batched transaction
const txHash = await jaw.provider.request({
  method: 'wallet_sendCalls',
  params: [{ calls: [{ to: '0x...', value: '0x0', data: '0x' }] }],
});
```

## AI-Assisted Development

Add JAW.id skills to your AI coding agent:

```bash
npx skills add JustaLab-co/jaw-skills
```

## License

[Apache-2.0](./LICENSE)
