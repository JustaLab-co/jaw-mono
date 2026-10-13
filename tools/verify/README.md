# Verify the JAW payment path

Scripts that drive the real x402 payment path, so a change to `packages/agent`, `packages/cli` or `apps/mcp` can be proven beyond unit tests. They run from a fresh clone: no home paths, and keys come from the environment only.

Surfaces, in order of how often you need them:

1. The `jaw` CLI (`x402 pay`, `x402 status`, `x402 log`), packed from the working tree.
2. The MCP stdio server, `jaw mcp`, with tools such as `jaw_pay_and_fetch` and `jaw_x402_log`.
3. Real settlement on Base Sepolia through `https://api-staging.justaname.id/ens/v2/resolve`, an x402 endpoint whose facilitator broadcasts.
4. The hosted server, `apps/mcp` with Postgres, through Docker Compose.

The published `@jaw.id/cli@0.4.0` is the baseline. Output for agents is a contract: `-o json` bytes and MCP results must match it unless the change says otherwise.

Needs `bun`, `pnpm`, `node` 20+, and Docker for the hosted stack. `cast` (Foundry) is needed only for the live paths.

Every run gets a directory under `.verify-cache/<run-id>/` (gitignored; set `JAW_VERIFY_ROOT` to move it) with `work/` (deleted at cleanup), `pids/` (one file per process the run started) and `evidence/` (kept).

## Launch

```bash
bun install                          # once per checkout
S=tools/verify
RUN=$($S/up.sh | tail -1)            # about 30 s warm: clean worktree, install, build, pack
. "$RUN/run.env"                     # PORT, SELLER, BIN_head, BIN_base, REV, TREE
```

`up.sh` refuses to start when `git status --porcelain` is not empty and prints the dirty files: commit first, so every result belongs to a commit. It then checks out HEAD into a detached worktree at `work/src`, runs `bun install --frozen-lockfile` there and builds `@jaw.id/agent` and `@jaw.id/cli` with `--skip-nx-cache`, so a stale `dist` or an uncommitted edit in your checkout never reaches the build. Measured on a Mac with a warm bun cache, this takes about 30 s against 9 s for the old in-place build; a cold bun cache adds the download time. It fails if the CLI bundle still imports `@jaw.id/agent` at runtime, installs the packed tarball into `work/head`, installs 0.4.0 once into `.verify-cache/baseline-0.4.0`, writes a throwaway `~/.jaw` for each binary (`work/home-head`, `work/home-base`: fresh session key on Base Sepolia, no on-chain permission, default caps), and starts the seller on a free port, writing its PID to `pids/seller`. The last line printed is the run directory, after the seller's `listening` row.

Installs use pnpm with `--ignore-scripts` and `minimumReleaseAge: 10080` (7 days, transitive included), exempting only `@jaw.id/*`.

Local payments need a payer that holds USDC on Base Sepolia, because the funding step reads the real balance before signing. `node $S/payer.mjs "$PWD"` creates `.verify-cache/payer.json` (0600) once and prints its address and balance. It needs 1200000 base units, funded one time, and the balance never drops because the local seller does not settle. `up.sh` uses that key for both homes when it exists. Without it, every `--pay` drive ends in `top-up refused on-chain`, which is the harness, not the change. Refusal drives and `x402 status` work without it.

Hosted stack, when the change touches `apps/mcp` or storage:

```bash
$S/hosted-up.sh "$RUN"   # needs Docker, JAW_KEYS_URL optional; appends DATABASE_URL, MCP_URL, MCP_PUBLIC_URL, KEYS_URL
```

`JAW_KEYS_URL` is the origin of the keys app. `apps/mcp` refuses to start without it (`/api/health` answers 503 `config invalid`) because it builds the owner-facing link from it: the `/cli-bridge` URL the interaction page opens for the owner to approve the budget. The verify flows never open that link, so it is optional here and defaults to `http://localhost:3100`. Set it to a running keys app, with `JAW_RELAY_URL` pointing at a relay both reach, only when you need to connect by hand.

To try the hosted server by hand against the real wallet, start it with `JAW_KEYS_URL=https://keys.jaw.id` (and `JAW_MCP_API_KEY` for refills), then run `node tools/verify/hosted-client.mjs "$MCP_PUBLIC_URL"`. It opens the connect page in the browser, and once the wallet approves it reads commands (`status`, `budget 1`, `pay <url>`, `transfer <to> <amount>`, `swap <originChain> <originToken> <destChain> <destToken> <amount>`, `swap-status <quoteId>`, `connections`, `revoke <id>`, `disconnect`, `help`) and refreshes its tokens on its own.

The mcp image builds from `work/src`, the clean worktree of HEAD, when `up.sh` made one; otherwise (a run started with `JAW_VERIFY_TGZ`) from the checkout, and `hosted-up.sh` refuses when that checkout is dirty. The mcp container gets `DATABASE_URL`, `JAW_MCP_PUBLIC_URL` (fixed host port, so the OAuth issuer matches what clients reach), `JAW_KEYS_URL` and the optional `JAW_MCP_API_KEY` from your environment, and a per-run `JAW_MCP_SEALING_KEYS` generated into `work/sealing.key` (0600, never copied to evidence). From inside the container the seller is `http://host.docker.internal:$PORT`.

## Doctor

```bash
$S/doctor.sh "$RUN"            # add --live before using the real session
```

It checks that the seller pid is alive and owns the port, both binaries run and the baseline is 0.4.0, and the working tree is the one that was built. It warns when `git diff HEAD` changed since `up.sh`; results then say nothing about the current tree. It reads the payer's balance with `jaw x402 status` and warns under 1.2 USDC, the amount local `--pay` drives need. When the hosted stack is up it also checks that Postgres answers, that the mcp image carries the run's commit in its `org.opencontainers.image.revision` label (it fails on another commit and warns when the label is missing), and that the mcp container answers `GET /api/health` with 200 (config valid, database reachable), saving the body to `evidence/mcp-health.json`. Every check runs; the exit code is 1 when any of them failed, and a warning never fails the run. With `--live` it also requires a real session in `~/.jaw` and saves `jaw x402 status` to `evidence/live-status.json`.

## Drive

CLI, one command per call, against either binary. `{SELLER}` expands to the seller URL:

```bash
$S/drive.sh "$RUN" head pay-exact x402 pay '{SELLER}/exact' --pay -o json
$S/drive.sh "$RUN" base pay-exact x402 pay '{SELLER}/exact' --pay -o json
node $S/compare.mjs "$RUN" pay-exact       # exit 1 on any difference
```

Seller routes (all Base Sepolia USDC unless noted, `payTo` 0x2222...2222): `/exact` 5000, `/tenth` 100000, `/one` 1000000, `/overcap` 2000000, `/wrong-asset` 5000 of a fake token, `/upto` 5000 under the `upto` scheme, `/slow` 5000 that answers the paid request after 8 s, and `/variable` (default 5000) whose price changes with a POST to `{SELLER}/_price?amount=N`. The seller recovers the EIP-3009 signer with viem and logs `signatureValid` and `termsMatch` for every payment to `evidence/seller.log`. `verifiedBy` records whether plain ECDSA or the on-chain check (ERC-1271, ERC-6492) validated it.

### Swap backend stub

The seller also answers the three routes of JAW's swap backend that the hosted server calls, in the backend's `{ statusCode, result: { data, error } }` envelope. Point `JAW_MCP_SWAP_URL` at `http://host.docker.internal:$PORT/proxy/v2`.

- `GET /proxy/v2/swap/quote`: an unpaid request gets the 402 even with an invalid query, as the backend validates after the challenge; a paid request with an invalid query gets its 400. A valid unpaid one gets a 402 for 5000 USDC base units on `eip155:84532`. A paid request answers a quote built like the backend's Aurora mapper: `quoteId` is `aurora:<depositAddress>` and the one `deposit` transaction is `transfer(depositAddress, amount)` on the origin token, or the amount sent to the deposit address for the zero address. The deposit address is the last 20 bytes of the keccak of the payment nonce, so every paid quote gets a new one and a test that signed the payment can compute it. A resent proof answers 402 unless it carries the same `Idempotency-Key`, which replays the first answer.
- `POST /proxy/v2/move-asset/deposit/submit` and `GET /proxy/v2/move-asset/deposit/status`: free, `provider=aurora` (any other answers 501). Status is `PENDING_DEPOSIT` until a submit, which answers `KNOWN_DEPOSIT_TX`; the reads after it give `PROCESSING`, then `SUCCESS` for good. A state that is not one of the seven comes back as `PROCESSING` with `rawState`, as the mapper does. Submit answers HTTP 201 with `statusCode: 200` in the body, as Nest does without `@HttpCode`. Status carries `txHash` only after a submit.

`POST {SELLER}/_swap` changes the stub until the next call, with any of:

- `network=eip155:8453`: the network the quote's 402 advertises. Empty goes back to `eip155:84532`.
- `mode=<name>`: `422` or `502` refuses the quote before the charge, as the backend does for a pair it cannot route or a provider outage. `invalid` charges and answers 200 with `data: null`; `paid-502` charges and answers 502 with the receipt. The rest charge and break one rule of the quote check: `two-tx`, `no-tx`, `wrong-chain`, `quote-id`, `provider`, `deposit-field`, `tx-to`, `tx-value`, `tx-data`, `trailing-bytes`, `input-amount`, `output-amount`, `zero-min`, `deposit-self` and `reused` (the previous quote's deposit address). Empty goes back to a good quote.
- `submitFails=N`: the next N submits answer 500, the backend's answer when Aurora refuses one.
- `state=<STATE>`, with `depositAddress=<address>` for one deposit or without it for all: status and submit answer that state. Empty goes back to the scripted walk.
- `expire=<address>`: the quote expired, so submits for it answer 500 and status stays `PENDING_DEPOSIT`.
- A JSON body of `{ "reset": true }`: every switch above goes back to its default. The seller also starts from the defaults.

The stub is EVM-only: the backend also accepts Solana deposit addresses and signatures, and the stub refuses them with a 400.

Drives for the swap tools are in [features/hosted-swap.md](features/hosted-swap.md).

Every request lands in `seller.log`: `challenge`, `payment`, `spent`, `replay`, `quote`, `refused`, `submit`, `status` and `control` rows. `node --test tools/verify/seller.test.mjs` drives each route and switch; `selftest.sh` runs it.

MCP stdio, tool calls run in order and each waits for its response:

```bash
node $S/mcp.mjs "$RUN" head pay-mcp '[{"name":"jaw_pay_and_fetch","arguments":{"url":"{SELLER}/exact"}},{"name":"jaw_x402_log","arguments":{"limit":2}}]'
node $S/mcp.mjs "$RUN" base pay-mcp '<same calls>'
node $S/compare.mjs "$RUN" pay-mcp
```

Real settlement spends testnet USDC from the real session in `~/.jaw` with the head build, appends to the real ledger, and may top up the payer through the permission:

```bash
$S/doctor.sh "$RUN" --live && JAW_VERIFY_LIVE=1 $S/live-pay.sh "$RUN"
```

Passkey payment from the smart account, only with a person at the machine to approve in the browser:

```bash
JAW_VERIFY_HUMAN=1 node $S/passkey-pay.mjs "$RUN"
```

If keys.jaw.id shows a QR code, the passkey is not in that browser profile. A bridge timeout after 300 s means the approval arrived late, not that the signature failed.

`features/` maps each user-facing feature to the exact drive. A proof covers every entry point the map lists for the feature, not the most convenient one.

## Evidence

Everything lands in `$RUN/evidence/`:

- `head/<name>.out|.err|.code` and `base/<name>...` from `drive.sh`; `head/<name>.mcp.json` from `mcp.mjs`.
- `compare-<name>.txt`: `same` or the normalized diff. Nonces, deadlines, timestamps and addresses other than the seller's `payTo` are blanked before comparing.
- `seller.log`: what the seller received, with signature validity. A `paid` result with no matching `"signatureValid":true` row is not a proof.
- `live/`: `pay.out`, the new ledger rows, the transaction receipt and `settlement.txt`. A live payment counts only with a `status 0x1` receipt and a Transfer from the payer.
- `passkey/`: the request, the facilitator result and the receipt status.
- `run.env`: the revision and tree hash that were built. Quote them in any report.
- `build.log`, `seller.log`, `run.env` and `compose-up.log` start with `head: <full sha>` and `tree: clean`. Paste the `head:` line into the PR's "How to test"; the pr-evidence check compares it with the PR head.

Drive the packed binary or the stdio server, never internal functions, and capture both the command result and the side effect (seller row, ledger row, on-chain Transfer). Record commands with a recorder such as `script -q <log> <command>` instead of copying output by hand. A green full flow says nothing about a change that only acts at an edge: force the edge (a price over the cap, a payer short of funds) or do not count it as tested. `x402 pay` without `--pay` is a dry run, so confirm in `seller.log` that it sent no `PAYMENT-SIGNATURE`.

## Cleanup

```bash
$S/down.sh "$RUN"
```

Stops every process listed in `pids/`, removes the run's compose project and its volumes when `hosted-up.sh` ran, removes the `work/src` worktree, and deletes `work/`. It never kills by process name and never touches `~/.jaw`. `evidence/` stays, and the baseline install is reused across runs.

Runs are isolated by port, home and compose project, so several can run side by side. The compose project is `jaw-verify-` plus the first 8 hex characters of the SHA-1 of the absolute run path, so two worktrees that start a run in the same second still get different projects. `down.sh` stops only the PIDs in its own `pids/` and the project recorded in its own `run.env`, ignores any `COMPOSE_PROJECT` in your shell, and refuses to run when `run.env` is missing. To stop one process by hand, `kill $(cat "$RUN/pids/<name>")`. The live and passkey paths share the real `~/.jaw`; `live-pay.sh` holds `~/.jaw/.verify-live.lock` so only one runs at a time.

## Shared image per round

Build the `apps/mcp` image once and let every lane reuse it: `docker build -f apps/mcp/Dockerfile --label org.opencontainers.image.revision=$(git rev-parse HEAD) -t jaw-verify-mcp:<sha> .` from the checkout, then `JAW_VERIFY_MCP_IMAGE=jaw-verify-mcp:<sha> $S/hosted-up.sh "$RUN"` in each lane. Pair it with `JAW_VERIFY_TGZ` for the CLI. Doctor fails when the label names another commit than the run's, and warns when it is missing.

## Waiting on a long command

Never wait on a background notification. Run the command under `run-bounded.sh`, which always ends: it writes stdout and stderr to the log and the exit code to `<log>.done` (124 when the limit stopped it). Then wait on the file with your own deadline:

```bash
$S/run-bounded.sh 900 "$LOG" bunx nx test @jaw-mono/mcp &
until [ -f "$LOG.done" ] || [ $SECONDS -gt 960 ]; do sleep 5; done; tail "$LOG"
```

macOS ships no `timeout`, so the script does not use one: it starts the command in its own process group and a watchdog sends TERM to the group at the limit, then KILL two seconds later.

## Harness self-test

`$S/selftest.sh` checks the scripts themselves: the dirty-tree refusal, `run-bounded.sh` ending on its limit, `.husky/pre-push` choosing the PR base, the seller answering every route and switch (`seller.test.mjs`), and two runs with the same id getting separate compose projects (Postgres only; skipped without Docker). Run it after changing anything in this folder.
