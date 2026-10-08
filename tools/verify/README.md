# Verify the JAW payment path

Scripts that drive the real x402 payment path, so a change to `packages/agent`, `packages/cli` or `apps/mcp` can be proven beyond unit tests. They run from a fresh clone: no home paths, and keys come from the environment only.

Surfaces, in order of how often you need them:

1. The `jaw` CLI (`x402 pay`, `x402 status`, `x402 log`), packed from the working tree.
2. The MCP stdio server, `jaw mcp`, with tools such as `jaw_pay_and_fetch` and `jaw_x402_log`.
3. Real settlement on Base Sepolia through `https://api-staging.justaname.id/ens/v2/resolve`, an x402 endpoint whose facilitator broadcasts.
4. The hosted server, `apps/mcp` with Postgres, through Docker Compose.

The published `@jaw.id/cli@0.4.0` is the baseline. Output for agents is a contract: `-o json` bytes and MCP results must match it unless the change says otherwise.

Needs `bun`, `pnpm`, `node` 20+, and Docker for the hosted stack. `cast` (Foundry) is needed only for the live paths.

Every run gets a directory under `.verify-cache/<run-id>/` (gitignored; set `JAW_VERIFY_ROOT` to move it) with `work/` (deleted at cleanup) and `evidence/` (kept).

## Launch

```bash
bun install                          # once per checkout
S=tools/verify
RUN=$($S/up.sh | tail -1)            # 1 to 2 min: build, pack, installs
. "$RUN/run.env"                     # PORT, SELLER, BIN_head, BIN_base, REV, TREE
```

`up.sh` builds the checkout it lives in, so each worktree uses its own copy. It builds `@jaw.id/agent` and `@jaw.id/cli` with `--skip-nx-cache`, fails if the CLI bundle still imports `@jaw.id/agent` at runtime, installs the packed tarball into `work/head`, installs 0.4.0 once into `.verify-cache/baseline-0.4.0`, writes a throwaway `~/.jaw` for each binary (`work/home-head`, `work/home-base`: fresh session key on Base Sepolia, no on-chain permission, default caps), and starts the seller on a free port. The last line printed is the run directory, after the seller's `listening` row.

Installs use pnpm with `--ignore-scripts` and `minimumReleaseAge: 10080` (7 days, transitive included), exempting only `@jaw.id/*`.

Local payments need a payer that holds USDC on Base Sepolia, because the funding step reads the real balance before signing. `node $S/payer.mjs "$PWD"` creates `.verify-cache/payer.json` (0600) once and prints its address and balance. It needs 1200000 base units, funded one time, and the balance never drops because the local seller does not settle. `up.sh` uses that key for both homes when it exists. Without it, every `--pay` drive ends in `top-up refused on-chain`, which is the harness, not the change. Refusal drives and `x402 status` work without it.

Hosted stack, when the change touches `apps/mcp` or storage:

```bash
JAW_KEYS_URL=<keys.jaw.id origin> $S/hosted-up.sh "$RUN"   # needs Docker; appends DATABASE_URL, MCP_URL, MCP_PUBLIC_URL, KEYS_URL
```

The mcp container gets `DATABASE_URL`, `JAW_MCP_PUBLIC_URL` (fixed host port, so the OAuth issuer matches what clients reach), `JAW_KEYS_URL` and the optional `JAW_MCP_API_KEY` from your environment, and a per-run `JAW_MCP_SEALING_KEYS` generated into `work/sealing.key` (0600, never copied to evidence). From inside the container the seller is `http://host.docker.internal:$PORT`.

## Doctor

```bash
$S/doctor.sh "$RUN"            # add --live before using the real session
```

It checks that the seller pid is alive and owns the port, both binaries run and the baseline is 0.4.0, and the working tree is the one that was built. It warns when `git diff HEAD` changed since `up.sh`; results then say nothing about the current tree. It also checks that Postgres answers when the hosted stack is up. With `--live` it also requires a real session in `~/.jaw` and saves `jaw x402 status` to `evidence/live-status.json`.

## Drive

CLI, one command per call, against either binary. `{SELLER}` expands to the seller URL:

```bash
$S/drive.sh "$RUN" head pay-exact x402 pay '{SELLER}/exact' --pay -o json
$S/drive.sh "$RUN" base pay-exact x402 pay '{SELLER}/exact' --pay -o json
node $S/compare.mjs "$RUN" pay-exact       # exit 1 on any difference
```

Seller routes (all Base Sepolia USDC unless noted, `payTo` 0x2222...2222): `/exact` 5000, `/tenth` 100000, `/one` 1000000, `/overcap` 2000000, `/wrong-asset` 5000 of a fake token, `/upto` 5000 under the `upto` scheme, `/slow` 5000 that answers the paid request after 8 s, and `/variable` (default 5000) whose price changes with a POST to `{SELLER}/_price?amount=N`. The seller recovers the EIP-3009 signer with viem and logs `signatureValid` and `termsMatch` for every payment to `evidence/seller.log`. `verifiedBy` records whether plain ECDSA or the on-chain check (ERC-1271, ERC-6492) validated it.

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

Drive the packed binary or the stdio server, never internal functions, and capture both the command result and the side effect (seller row, ledger row, on-chain Transfer). Record commands with a recorder such as `script -q <log> <command>` instead of copying output by hand. A green full flow says nothing about a change that only acts at an edge: force the edge (a price over the cap, a payer short of funds) or do not count it as tested. `x402 pay` without `--pay` is a dry run, so confirm in `seller.log` that it sent no `PAYMENT-SIGNATURE`.

## Cleanup

```bash
$S/down.sh "$RUN"
```

Stops the seller by the pid `up.sh` recorded, removes the run's compose project and its volumes when `hosted-up.sh` ran, and deletes `work/`. It never kills by process name and never touches `~/.jaw`. `evidence/` stays, and the baseline install is reused across runs.

Runs are isolated by port, home and compose project, so several can run side by side. The live and passkey paths share the real `~/.jaw`; `live-pay.sh` holds `~/.jaw/.verify-live.lock` so only one runs at a time.

## Shared image per round

Build the `apps/mcp` image once and let every lane reuse it: `docker build -f apps/mcp/Dockerfile -t jaw-verify-mcp:<sha> .` from the checkout, then `JAW_VERIFY_MCP_IMAGE=jaw-verify-mcp:<sha> $S/hosted-up.sh "$RUN"` in each lane. Pair it with `JAW_VERIFY_TGZ` for the CLI. Doctor's build check covers the CLI only, so name the image tag in every report.
