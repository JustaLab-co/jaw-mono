# Readiness and history

`jaw x402 status` tells the user whether the session can pay right now and why not. `jaw x402 log` lists past payments from the local ledger.

## Sub-features

- `status-ready`: session, payer, caps and period usage, with a ready verdict or a reason.
- `status-empty`: no session at all gives a clear message, not a crash.
- `log-all`: every ledger row, newest last.
- `log-filter`: `--limit` and `--status` narrow the rows.

## How to get to it (user POV)

- Terminal: `jaw x402 status [-o json]`, `jaw x402 log [--limit N] [--status <outcome>] [-o json]`.
- MCP: `jaw_status` and `jaw_x402_log` (mcp-pay-and-fetch.md).

## Driving it with drive.sh

Preconditions: baseline preconditions; run the x402-pay drives first so the ledger has rows.

- status-ready: `$S/drive.sh "$RUN" head status x402 status -o json` and `base`, then `node $S/compare.mjs "$RUN" status` prints `same`.
- log-all: `... log x402 log -o json` on both, compare. Rows match the seller payments in count and amount.
- log-filter: `... log-paid x402 log --status paid --limit 1 -o json` on both, compare. One row, `paid`.
- status-empty: `HOME=$(mktemp -d) "$BIN_head" x402 status` exits cleanly with a message that no session exists. The published e2e check `e2e/published/consumer/check.mjs` relies on this.

## Gotchas

- `status` reads chain state over RPC. A network failure shows up as a reason in the output, not as a diff in your change.
- Timestamps differ between binaries; compare.mjs blanks them. Any other difference is real.
