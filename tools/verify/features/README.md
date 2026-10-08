# JAW payment path verification map

The maintained source for verifying what a user of the jaw CLI, the MCP server and the hosted server sees. Read this index, then drive the matching feature file.

## Baseline preconditions

- `S=tools/verify`, run from the repository root (see ../README.md).
- `RUN=$($S/up.sh | tail -1)` succeeded and `$S/doctor.sh "$RUN"` prints no FAIL and no WARN.
- Local drives use the throwaway homes in `$RUN/work/home-head` and `home-base`, never the real `~/.jaw`.
- Live drives (`live-settlement`) use the real `~/.jaw` session on Base Sepolia and spend testnet USDC.

## Driving conventions

- Every local feature runs on both `head` and `base` with the same name, then `node $S/compare.mjs "$RUN" <name>`.
- A `DIFF` is a regression unless the change being verified says that output changes on purpose. Quote the diff.
- Pass `-o json` to CLI commands so the bytes agents parse are what gets compared.
- Use the seller routes listed in ../README.md; do not point local drives at real endpoints.

## Proof and skip reporting

- Quote `REV` and `TREE` from `evidence/run.env` with every result.
- A payment proof pairs the command result with its side effect: a `seller.log` row with `"signatureValid":true`, a ledger row, or a decoded on-chain Transfer.
- Report a feature you could not reach with the command tried and the precondition that failed. Do not count a different entry point as covering it.

## Features

| Feature | Entry points | File |
| --- | --- | --- |
| Pay for a resource | `jaw x402 pay` | [x402-pay.md](x402-pay.md) |
| Readiness and history | `jaw x402 status`, `jaw x402 log` | [x402-status-log.md](x402-status-log.md) |
| Pay from an agent | MCP `jaw_pay_and_fetch`, `jaw_x402_log`, `jaw_status` | [mcp-pay-and-fetch.md](mcp-pay-and-fetch.md) |
| Real settlement | staging endpoint with the real session; passkey payment from the account | [live-settlement.md](live-settlement.md) |
| Hosted server | `apps/mcp` over HTTP with Postgres | [hosted-mcp.md](hosted-mcp.md) |
