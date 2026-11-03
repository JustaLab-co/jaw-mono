# AGENTS.md

Guidance for AI coding agents and contributors working in this repository.

## Overview

JAW.id is an Nx monorepo for building smart account wallet infrastructure. It provides an EIP-1193 compliant provider for interacting with smart accounts, supporting both cross-platform (popup) and app-specific (embedded) authentication modes via passkeys.

## Common Commands

```bash
# Install dependencies
bun install

# Build all packages
bunx nx run-many -t build

# Build a specific package
bunx nx build @jaw.id/core
bunx nx build @jaw.id/wagmi
bunx nx build @jaw.id/ui

# Run tests for a package
bunx nx test @jaw.id/core

# Tests with coverage, as the Coverage workflow runs them on main
bunx nx run-many -t test --coverage

# Run a single test file
cd packages/core && bunx vitest run src/path/to/file.test.ts

# Lint all packages
bunx nx run-many -t lint

# Lint a specific package
bunx nx lint @jaw.id/core

# Typecheck
bunx nx run-many -t typecheck

# Check the public API of @jaw.id/core against the committed report
bunx nx api-check @jaw.id/core

# Update that report after an intentional API change (commit the diff)
bunx nx api-update @jaw.id/core

# Run the playground Next.js app
bunx nx dev @jaw-mono/playground

# Run the docs site (uses Vocs)
bunx nx dev docs

# View project dependency graph
bunx nx graph

# Release packages
bunx nx release
```

## Risky paths

`.github/risky-paths` lists, one glob per line, the code that builds the calls an owner signs. A change touching it needs a person to read it, so keep it in its own small PR. Its entries are mirrored in `.github/CODEOWNERS`.

## Bridge wire contract

The `/cli-bridge` page in `apps/keys-jaw-id` talks to CLIs and servers already installed, and those update on their own schedule. Keys never drops the handling of a frame or a field an installed client still sends, and a change to what it accepts is additive. A client sends something new only after keys handles it and that version is deployed.

`apps/keys-jaw-id/src/app/cli-bridge/fixtures/` holds each shape a client really sends, one file per shape, and `wire-contract.test.tsx` replays every file through the real page. A fixture is never edited to match the code, and removing one is a decision recorded in the PR that removes it. `fixtures/README.md` says how to add one.

The support floor is `@jaw.id/cli` 0.4.0 and later, and every `@jaw-mono/mcp` image still deployable. A published shape is retired only with a minimum supported CLI version announced in the CLI release notes. Shapes from clients that send `client` can be retired when the `bridge client` logs show none for 30 days.

## Testing invariants

These hold for every change, however small. A diff that needs to break one is a decision for a person to make in the PR description, not something to route around.

- **Golden vectors never move to match the code.** The `expected` bytes in `packages/core/vectors/` come from `cast abi-encode` against the Solidity structs, not from this codebase (see its README). When a vector test fails, the encoder changed: fix the encoder. Never regenerate a vector from the current output. A PR that does change one says why in its description.
- **The API report changes only on purpose.** `packages/core/etc/core.api.md` records everything `@jaw.id/core` exports, and `api-check` fails CI on any drift. Run `bunx nx api-update @jaw.id/core` only for an intended API change and commit the report diff with it.
- **Tests assert behavior, not the implementation.** In `packages/core/src/account` and `src/signer` tests, do not stub what produces bytes: ESLint rejects a `vi.mock` of `viem` or `ox` that replaces an encoder or hash function, any factory mock of `ox/*` or `viem/experimental/erc7739`, and a bare `vi.mock('viem')`. Mocking the client or the network around them is allowed. Write a test from what the issue or PR says should happen, not from what the code currently does, and never loosen an assertion or an expected value so a failing test passes.
- **A known-bug test flips with its fix.** If a test is marked `it.fails` to record a bug, it becomes `it` in the same change that fixes the bug. It is never deleted to make the suite pass.
- **What the user sees is what gets signed.** In `apps/keys-jaw-id`, a screen signs the same request object it renders. Do not add a step that rebuilds, normalizes or fills in the signed payload after it has been shown.
- **Paths in `.github/CODEOWNERS` get their own small PR.** They are the vectors, the API report, the EIP-1193 provider and the keys signing screens. Keep changes there separate from unrelated work so the review stays readable.
- **Packaging changes run the published test.** After touching `exports`, `files`, `bin` or a build config of a package in `packages/`, run `bunx nx run published-e2e:e2e`, which installs the three packages from a local registry the way an integrator would.

CI runs `bunx nx affected -t lint test typecheck build api-check e2e`, so a change to core also runs the tests of everything that depends on it. `test` depends on `^build` in `nx.json`, so `nx test` builds the packages it imports first instead of reading a stale local `dist`.

The Coverage workflow runs the affected suites of a PR, and every suite on main, with `--coverage`. Each project's vitest config sets `coverage.thresholds` about a point under its coverage, so a project that falls below them fails. On a PR it also compares each project against the latest passing run on main, comments the table, and fails when a metric drops more than 0.1 points, unless the PR has the `coverage-drop-ok` label. The label does not lift a threshold: a PR that goes under one lowers it in the config, where the reviewer sees it. Raise a threshold when coverage goes up. On main it also writes the line coverage of every project together to `coverage.svg` on the `badges` branch, which the README shows; that branch is replaced on every run.

## Architecture

The CLI, the agent package and the hosted MCP server live in the private repo JustaLab-co/jaw-agent and consume `@jaw.id/core` from npm.

### Publishable Packages (`packages/`)

- **@jaw.id/core** - Core SDK providing `JAWProvider` (EIP-1193 provider), `Account` class for smart account operations, passkey management, and RPC handling. Entry point is `JAW.create()` factory function.
- **@jaw.id/wagmi** - Wagmi connector wrapping core SDK. Exports `jaw()` connector factory, React hooks (`useConnect`, `useGrantPermissions`, etc.), and TanStack Query utilities.
- **@jaw.id/ui** - React UI components (Radix-based) for wallet dialogs: onboarding, transaction signing, permission management. Exports `ReactUIHandler` for app-specific mode integration.

### Applications (`apps/`)

- **playground** - Next.js demo app exercising the SDK via @jaw.id/wagmi (the `jaw()` connector wired through wagmi)
- **keys-jaw-id** - Next.js keys management application (keys.jaw.id). Its `/cli-bridge` page answers a request repeated under the same id with the answer it already gave, so a server that lost its relay socket can ask again without a second dialog, and says a link is no longer active when no server answers it. A bridge init may carry `client` (`name/version`), which is self-reported: it can be spoofed and is never trusted or used for access. The page posts it once per page load to `/api/bridge-client`, which logs it in the `bridge client` line; read the counts with a Vercel logs search for `"msg":"bridge client"` on the keys project, grouped by `client`
- **docs** - Documentation site built with Vocs

### Smart Contracts (`contracts/`)

Git submodules containing Foundry projects:

- **justanaccount** - smart account implementation
- **permissions** - Permission manager contract for delegated access control

### Core SDK Architecture

The `@jaw.id/core` package follows this structure:

1. **Provider Layer** (`src/provider/`) - `JAWProvider` implements EIP-1193, handling RPC requests and routing to appropriate handlers
2. **Account Layer** (`src/account/`) - `Account` class wraps smart account operations: signing, transactions, permission management
3. **Signer Layer** (`src/signer/`) - Two signer implementations:
   - `CrossPlatformSigner` - Uses popup window to keys.jaw.id for signing
   - `AppSpecificSigner` - Direct passkey signing within the app
4. **RPC Handlers** (`src/rpc/`) - Individual handlers for wallet methods (wallet_sendCalls, wallet_grantPermissions, etc.)
5. **State Management** (`src/store/`) - Zustand stores for config, chains, and client instances

### ERC-20 Gas Fee Model

`estimateErc20PaymasterCosts` (`packages/core/src/account/erc20Paymaster.ts`) returns two values per token:

- `tokenCost` — realistic fee shown to the user: the userOp's phases are replayed via `eth_simulateV1` (deploying undeployed accounts inside the simulation), combined with the EntryPoint's overhead and unused-gas penalty, priced at a buffered effective gas price (baseFee × 1.25 + priority, capped at maxFeePerGas), capped at the ceiling. Falls back to summed gas limits when simulation is unavailable.
- `tokenCostMax` — worst-case ceiling ("Up to"): all five gas limits plus the quoted postOp gas at maxFeePerGas. This is the amount the paymaster approval must cover and what `hasSufficientBalance` checks against.

UIs must build the ERC-20 paymaster context via `buildErc20PaymasterContext(estimate)` so the approve-with-ceiling rule stays in one place.

### Authentication Modes

- **CrossPlatform** (default) - Opens popup to keys.jaw.id for passkey authentication. Credentials portable across apps.
- **AppSpecific** - Passkeys stored per-app. Requires implementing `UIHandler` interface for custom UI.

### Key External Dependencies

- **viem** - Ethereum interactions and smart account utilities
- **ox** - Low-level crypto operations
- **@justaname.id/sdk** - ENS subname resolution
- **wagmi/TanStack Query** - React integration (wagmi package)
