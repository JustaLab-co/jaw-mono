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

# Tests for the agent package and the hosted server
bunx nx test @jaw.id/agent
bunx nx test @jaw-mono/mcp

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

## Verify

Needs `bun`, `pnpm` and `node` 20+, plus Docker for the hosted step. `cast` (Foundry) is only for the live paths. Unit tests do not cover the payment path. For a change under `packages/agent`, `packages/cli` or `apps/mcp`, build, pack and drive the real thing with the scripts in `tools/verify/`:

```bash
bun install
S=tools/verify
RUN=$($S/up.sh | tail -1)        # clean tree only: builds HEAD in a worktree, starts the seller
$S/doctor.sh "$RUN"              # must print no FAIL and no WARN
$S/drive.sh "$RUN" head status x402 status -o json
$S/hosted-up.sh "$RUN"           # Docker: Postgres and apps/mcp
$S/down.sh "$RUN"
```

`up.sh` refuses a dirty tree and stamps `head: <sha>` and `tree: clean` at the top of its evidence; put that `head:` line in the PR's "How to test". Kill only what a run started, by the PID files in `$RUN/pids/`, never by process name.

Wait on any long command with a file and a deadline, not a background notification. `tools/verify/run-bounded.sh <max-seconds> <log> <cmd...>` always ends and writes the exit code to `<log>.done`:

```bash
until [ -f <log>.done ] || [ $SECONDS -gt N ]; do sleep 5; done; tail <log>
```

`tools/verify/selftest.sh` checks the harness itself. `.husky/pre-push` runs `nx affected` against the PR base (`gh pr view`), falling back to `main`, so a stacked branch checks only its own commits.

`tools/verify/README.md` has the full recipes, the seller routes and what counts as evidence. Build before driving any artifact: the packed CLI runs the last build, not the source. Say which revision you built when you report a manual check, and force the edge (a price over the cap, an empty balance) when the change only acts there.

## Risky paths

`.github/risky-paths` lists, one glob per line, the code that moves money, holds keys, renders consent screens, seals tokens or migrates the database. A change touching it needs a person to read it, so keep it in its own small PR and run the matching `tools/verify` drive. Its entries are mirrored in `.github/CODEOWNERS`.

## Testing invariants

These hold for every change, however small. A diff that needs to break one is a decision for a person to make in the PR description, not something to route around.

- **Golden vectors never move to match the code.** The `expected` bytes in `packages/core/vectors/` come from `cast abi-encode` against the Solidity structs, not from this codebase (see its README). When a vector test fails, the encoder changed: fix the encoder. Never regenerate a vector from the current output. A PR that does change one says why in its description.
- **The API report changes only on purpose.** `packages/core/etc/core.api.md` records everything `@jaw.id/core` exports, and `api-check` fails CI on any drift. Run `bunx nx api-update @jaw.id/core` only for an intended API change and commit the report diff with it.
- **Tests assert behavior, not the implementation.** In `packages/core/src/account` and `src/signer` tests, do not stub what produces bytes: ESLint rejects a `vi.mock` of `viem` or `ox` that replaces an encoder or hash function, any factory mock of `ox/*` or `viem/experimental/erc7739`, and a bare `vi.mock('viem')`. Mocking the client or the network around them is allowed. Write a test from what the issue or PR says should happen, not from what the code currently does, and never loosen an assertion or an expected value so a failing test passes.
- **A known-bug test flips with its fix.** If a test is marked `it.fails` to record a bug, it becomes `it` in the same change that fixes the bug. It is never deleted to make the suite pass.
- **What the user sees is what gets signed.** In `apps/keys-jaw-id`, a screen signs the same request object it renders. Do not add a step that rebuilds, normalizes or fills in the signed payload after it has been shown.
- **Session key scope is never widened to make something work.** `SESSION_SUPPORTED_METHODS` in `packages/cli/src/lib/rpc-classifier.ts` is everything a session key may do with no human present, and signing is deliberately absent (the comment there says why). `checkPolicy` in `packages/agent/src/x402/policy.ts` is not relaxed to let a payment through.
- **Paths in `.github/CODEOWNERS` get their own small PR.** They are the vectors, the API report, the EIP-1193 provider, the keys signing screens and the CLI session code. Keep changes there separate from unrelated work so the review stays readable.
- **Packaging changes run the published test.** After touching `exports`, `files`, `bin` or a build config of a package in `packages/`, run `bunx nx run published-e2e:e2e`, which installs the four packages from a local registry the way an integrator would.

CI runs `bunx nx affected -t lint test typecheck build api-check e2e`, so a change to core also runs the tests of everything that depends on it. `test` depends on `^build` in `nx.json`, so `nx test` builds the packages it imports first instead of reading a stale local `dist`.

## Architecture

### Publishable Packages (`packages/`)

- **@jaw.id/core** - Core SDK providing `JAWProvider` (EIP-1193 provider), `Account` class for smart account operations, passkey management, and RPC handling. Entry point is `JAW.create()` factory function.
- **@jaw.id/wagmi** - Wagmi connector wrapping core SDK. Exports `jaw()` connector factory, React hooks (`useConnect`, `useGrantPermissions`, etc.), and TanStack Query utilities.
- **@jaw.id/ui** - React UI components (Radix-based) for wallet dialogs: onboarding, transaction signing, permission management. Exports `ReactUIHandler` for app-specific mode integration.
- **@jaw.id/cli** - CLI tool (`jaw` binary) and MCP server for terminal/AI agent interaction with smart accounts. Uses oclif framework. Connects to browser via WebSocket relay for passkey signing. All traffic E2E encrypted (ECDH P-256 + AES-256-GCM).
- **@jaw.id/agent** - Not published: the CLI bundles it. The x402 payment path, grants and session rules, with no filesystem or terminal access of its own; chain reads, the payment log and the session store come in through the interfaces in `src/ports.ts`.

### Applications (`apps/`)

- **playground** - Next.js demo app exercising the SDK via @jaw.id/wagmi (the `jaw()` connector wired through wagmi)
- **keys-jaw-id** - Next.js keys management application (keys.jaw.id)
- **mcp** - Hosted MCP server (Next.js, Postgres, Drizzle): OAuth with a passkey consent on keys.jaw.id, read tools, passkey-approved signatures and x402 payments within a granted budget
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
