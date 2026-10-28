# Pay from an agent

`jaw mcp` serves the same payment path to an MCP client over stdio. Agents call `jaw_pay_and_fetch` and parse its structured result, so the result bytes are a contract.

## Sub-features

- `mcp-paid`: `jaw_pay_and_fetch` pays and returns the fenced resource body.
- `mcp-refused`: an over-cap price comes back as a refusal result, not a protocol error.
- `mcp-log`: `jaw_x402_log` returns the rows the pays wrote.
- `mcp-status`: `jaw_status` returns readiness.

## How to get to it (user POV)

- Any MCP client configured with `jaw mcp` as a stdio server (Claude Code, Cursor, Codex).
- Tools: `jaw_pay_and_fetch {url, maxAmount?, method?, body?}`, `jaw_x402_log {limit?}`, `jaw_status`.

## Driving it with mcp.mjs

Preconditions: baseline preconditions.

- mcp-paid, mcp-refused, mcp-log in one transcript: `node $S/mcp.mjs "$RUN" head pay-mcp '[{"name":"jaw_pay_and_fetch","arguments":{"url":"{SELLER}/exact"}},{"name":"jaw_pay_and_fetch","arguments":{"url":"{SELLER}/overcap"}},{"name":"jaw_x402_log","arguments":{"limit":2}}]'`, the same with `base`, then `node $S/compare.mjs "$RUN" pay-mcp` prints `same`. `seller.log` gains one `payment` row for `/exact` and none for `/overcap`.
- mcp-status: `node $S/mcp.mjs "$RUN" head status-mcp '[{"name":"jaw_status","arguments":{}}]'` and `base`, compare.

## Gotchas

- Third-party content in results is fenced as untrusted. A change that moves or drops the fence shows up as a diff; it is never cosmetic.
- Each `mcp.mjs` call starts a new server process with the same home, so ledger rows accumulate across calls just like the CLI.
