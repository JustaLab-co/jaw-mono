# [JAW.id](https://jaw.id/)

Smart account wallet infrastructure with passkey authentication.

## Packages

| Package                           | Description                                                                |
| --------------------------------- | -------------------------------------------------------------------------- |
| [@jaw.id/core](./packages/core)   | Core SDK - EIP-1193 provider, smart account operations, passkey management |
| [@jaw.id/wagmi](./packages/wagmi) | Wagmi connector and React hooks                                            |
| [@jaw.id/ui](./packages/ui)       | React UI components for wallet dialogs                                     |
| [@jaw.id/cli](./packages/cli)     | CLI tool and MCP server for terminal and AI agent interaction              |

## Documentation

For installation guides, API reference, and examples, visit **[docs.jaw.id](https://docs.jaw.id)**.

## Development

This is an [Nx](https://nx.dev) monorepo using [Bun](https://bun.sh) as package manager.

```bash
# Install dependencies
bun install

# Build all packages
bunx nx run-many -t build

# Run tests
bunx nx run-many -t test

# Lint
bunx nx run-many -t lint

# Run playground app
bunx nx dev @jaw-mono/playground

# View dependency graph
bunx nx graph
```

## Community

Join our [Telegram](https://t.me/+RsFLPfky7-YxZjVk) for questions and discussions.

## License

[Apache-2.0](LICENSE)

<!-- This line verifies the pull request flow. -->
