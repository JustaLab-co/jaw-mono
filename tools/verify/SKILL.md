---
name: verify
description: Drive the JAW keys app (keys.jaw.id) and the playground dApp locally to prove a wallet change works, with the fee-token flow of the signing dialog as the first mapped area. Use before claiming a change to packages/ui fee estimation, the keys TransactionModal or PermissionModal, or the playground send flow works, and when a person needs the Base Sepolia manual check.
---

# Verify the keys app and its signing dialog

Two apps, run together. The playground (`apps/playground`, port 3002) is the dApp: it calls the SDK, which opens the keys app (`apps/keys-jaw-id`, port 3001) in a popup over http. The signing dialog in that popup is `TransactionModal`, which renders `TransactionDialog` and the fee row from `packages/ui`.

Three layers of proof, cheapest first. Use the cheapest one that exercises what changed, and say which one you used.

1. **Automated, no network.** Unit tests on the real hook and the Lean model. `tools/verify/fee-token-checks.sh`.
2. **Browser, mocked API.** The Playwright suites in `e2e/` start both apps and mock `api.justaname.id`. They cover connect and sign, not fees: a send needs a live bundler and paymaster.
3. **Browser, Base Sepolia, a person at the keyboard.** The only layer that shows the real fee row with a real passkey, bundler and paymaster. Steps in `features/fee-token-preselection.md`.

An agent can run layers 1 and 2. Layer 3 needs a passkey and a funded testnet account, so an agent hands its steps to a person and records what they report.

## Launch

From the repo root, after `bun install`:

```bash
NX_DAEMON=false bunx nx dev @jaw-mono/keys-jaw-id --port=3001     # terminal 1
NX_DAEMON=false NEXT_PUBLIC_KEYS_URL=http://localhost:3001 bunx nx dev @jaw-mono/playground --port=3002   # terminal 2
```

`NX_DAEMON=false`, and starting the second once the first prints its URL: two `nx` commands racing to start the daemon can kill it, and the run ends with "Daemon process terminated". Ready when `tools/verify/doctor.sh` prints `DOCTOR OK`. `next dev` compiles a route on its first hit: the keys root took about three minutes on a cold cache.

For layer 3, `apps/playground/.env.local` needs `NEXT_PUBLIC_API_KEY` (a key from dashboard.jaw.id) and `NEXT_PUBLIC_KEYS_URL=http://localhost:3001`; `apps/keys-jaw-id/.env.local` needs `NEXT_PUBLIC_CHAIN_ID=84532`. Copy each app's `.env.example`. Never commit these files and never print the key.

For layer 2 nothing has to be running: `cd e2e && CI=1 bunx playwright test connect-flows.spec.ts --config playwright.config.ts --project=chromium` builds both apps and serves the production build. Without `CI=1` it reuses the dev servers, where its dialog timeouts are too tight (see `features/connect-and-sign.md`).

## Doctor

```bash
tools/verify/doctor.sh
```

Read-only. Prints the checkout's branch and commit, whether both URLs answer 200, and whether ports 3001 and 3002 are served from this worktree. `FOREIGN` means another checkout owns the port: stop and ask, do not drive or kill it. Override the URLs with `JAW_E2E_KEYS_URL` and `JAW_E2E_PLAYGROUND_URL`.

## Drive

- **Layer 1:** `tools/verify/fee-token-checks.sh`. It runs `useGasEstimation.test.ts` and `feePreselect.test.ts`, then builds `lean/Model/FeePreselect.lean` when `lake` is installed (`~/.elan/bin`).
- **Layer 2:** the `Dapp` class in `e2e/fixtures.ts` is the harness. It opens `/core`, picks a method with `select(category, method)`, and `execute()` clicks the last `Execute` button and returns the popup. Inside the popup use roles and text: `getByRole('button', { name: 'Confirm' })`, `getByText('Network fee')`, `getByText('Pay with')` (the token picker's popover heading), `getByText('Insufficient funds')`.
- **Layer 3:** a person follows `features/fee-token-preselection.md`.

The feature map is in `features/README.md`. A proof of a feature drives every entry point its file lists.

## Evidence

Everything goes under `tools/verify/evidence/<timestamp>-<feature>/`, which git ignores:

- layer 1: `vitest.txt`, `lean.txt`, `commit.txt`, written by the script;
- layer 2: copy `e2e/test-results/` and the list reporter output there;
- layer 3: one screenshot per case of the popup with the fee row and the "Pay with" token visible, the account address and the balances read from a Base Sepolia explorer, and the commit the apps were built from.

Proof standards:

- Drive the real path: the playground button, the popup, the dialog. Never call hook setters or test-only endpoints to reach a state.
- Capture the state that proves the outcome. For the fee row that is the selected token and whether Confirm is enabled, not just that a dialog opened.
- A side effect counts only when it is observed. If a case submits a transaction, record the userOp or transaction hash and the token balance change on the explorer.
- Layer 2 mocks only `api.justaname.id`, the boundary the suite already isolates. Do not add mocks to make a layer 3 case pass.

## Cleanup

Stop only what you started: press Ctrl+C in the terminals you opened, or `kill <pid>` for the processes you started, found with `lsof -ti tcp:3001 -sTCP:LISTEN`. Check first that `doctor.sh` reports the port as served from this checkout. Stopping `nx dev` can leave its `next-server` child listening, so check both ports with `lsof` afterwards and stop that listener by its PID too. Never `pkill node` or kill by name. Playwright stops the servers it started itself. Remove `e2e/test-results/` after copying it. The evidence directory stays.
