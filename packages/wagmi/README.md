# @jaw.id/wagmi

[Wagmi](https://wagmi.sh) connector and React hooks for [JAW.id](https://jaw.id) smart accounts.

## Documentation

For documentation and guides, visit [docs.jaw.id](https://docs.jaw.id).

## Installation

```bash
npm install @jaw.id/wagmi wagmi @tanstack/react-query
# or
bun add @jaw.id/wagmi wagmi @tanstack/react-query
```

## Quick Start

```typescript
import { createConfig, http } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';
import { jaw } from '@jaw.id/wagmi';

export const config = createConfig({
  chains: [mainnet, sepolia],
  connectors: [
    jaw({
      apiKey: 'your-api-key',
    }),
  ],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
});
```

```tsx
import { useConnect, useDisconnect } from '@jaw.id/wagmi';
import { useAccount } from 'wagmi';

function App() {
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { address, isConnected } = useAccount();

  if (isConnected) {
    return (
      <div>
        <p>Connected: {address}</p>
        <button onClick={() => disconnect()}>Disconnect</button>
      </div>
    );
  }

  return <button onClick={() => connect()}>Connect</button>;
}
```

## AI-Assisted Development

Add JAW.id skills to your AI coding agent:

```bash
npx skills add JustaLab-co/jaw-skills
```

## License

[Apache-2.0](./LICENSE)
