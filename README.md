# [JAW.id](https://jaw.id/)

[![Coverage](https://github.com/JustaLab-co/jaw-mono/raw/badges/coverage.svg)](https://github.com/JustaLab-co/jaw-mono/actions/workflows/coverage.yml)
[![@jaw.id/core](https://img.shields.io/npm/v/@jaw.id/core?label=%40jaw.id%2Fcore)](https://www.npmjs.com/package/@jaw.id/core)
[![@jaw.id/wagmi](https://img.shields.io/npm/v/@jaw.id/wagmi?label=%40jaw.id%2Fwagmi)](https://www.npmjs.com/package/@jaw.id/wagmi)
[![@jaw.id/ui](https://img.shields.io/npm/v/@jaw.id/ui?label=%40jaw.id%2Fui)](https://www.npmjs.com/package/@jaw.id/ui)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933)](./package.json)
[![License](https://img.shields.io/github/license/JustaLab-co/jaw-mono)](./LICENSE)

Smart account wallet infrastructure with passkey authentication.

## Packages

| Package                           | Description                                                                |
| --------------------------------- | -------------------------------------------------------------------------- |
| [@jaw.id/core](./packages/core)   | Core SDK - EIP-1193 provider, smart account operations, passkey management |
| [@jaw.id/wagmi](./packages/wagmi) | Wagmi connector and React hooks                                            |
| [@jaw.id/ui](./packages/ui)       | React UI components for wallet dialogs                                     |

The `jaw` CLI is installed from npm with `npm i -g @jaw.id/cli`. Its source is no longer in this repo.

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
