# Grant a budget from an agent

`jaw_grant_permissions` in `jaw mcp` asks the account owner for an x402 budget when a payment first needs one, as the hosted server does. It creates the session key, opens the browser for the owner to approve a daily USDC allowance, and blocks until the owner answers. It never revokes or replaces a session, and the grant ceiling bounds it before anything is created.

## Sub-features

- `grant-ceiling`: a budget over `grantCeiling` is refused before a key is created or the browser opens.
- `grant-no-browser`: with no browser and a short bridge timeout, the call ends in an error result and leaves no keystore.
- `grant-active`: with a session already active, the call is refused with no browser and names `jaw_pay_and_fetch` and `jaw session setup`.
- `grant-approve`: the owner approves in the wallet, and the session then pays.

## How to get to it (user POV)

- Any MCP client configured with `jaw mcp` as a stdio server (Claude Code, Cursor, Codex).
- Tool: `jaw_grant_permissions {x402Budget?: {perDay}, chainId?}`, `perDay` USDC as a decimal, default `10/day`. The chain resolves as for `jaw_rpc`.
- The wallet URL comes back as a progress notification when the request carries a progress token, otherwise as a log message.

## Driving it with mcp.mjs

Preconditions: baseline preconditions. The tool is new, so these drives run on `head` only and there is nothing to compare against `base`. The run's homes already hold a session, so the automated drives use an empty home of their own:

```bash
G=$RUN/grant; mkdir -p "$G/work/home-head" "$G/evidence/head"; cp "$RUN/run.env" "$G/"
```

- grant-ceiling: `$S/drive.sh "$G" head ceiling config set grantCeiling 5/day`, then `node $S/mcp.mjs "$G" head grant-ceiling '[{"name":"jaw_grant_permissions","arguments":{"x402Budget":{"perDay":"10"},"chainId":84532}}]'`. Pass: the response has `isError: true` and its text names `5/day`, and `test ! -e "$G/work/home-head/.jaw/keystore.json"` succeeds.
- grant-no-browser: `JAW_NO_BROWSER=1 JAW_BRIDGE_TIMEOUT_MS=3000 node $S/mcp.mjs "$G" head grant-no-browser '[{"name":"jaw_grant_permissions","arguments":{"x402Budget":{"perDay":"1"},"chainId":84532}}]'`. Pass: the call returns within the 60 s `mcp.mjs` waits, the response has `isError: true`, and there is still no `keystore.json` in that home.
- grant-active: `node $S/mcp.mjs "$RUN" head grant-active '[{"name":"jaw_grant_permissions","arguments":{"chainId":84532}}]'` against the run's own home, which holds a live session. Pass: `isError: true`, the text names `jaw_pay_and_fetch` and `jaw session setup`, and `session-config.json` in `$RUN/work/home-head/.jaw` is unchanged.

## Driving it by hand

Only with a person at the machine to approve in the browser, a passkey account holding Base Sepolia USDC, and a home with no session.

- grant-approve: point an MCP client at the packed head binary with that home. Call `jaw_grant_permissions {"x402Budget":{"perDay":"1"},"chainId":84532}` and approve in keys.jaw.id. Pass: the result carries `sessionAddress`, `ownerAddress`, `permissionId`, `chainId: 84532`, `expiry` and a `summary`, and no `unfunded` warning. Then `jaw_session_status` reports `exists: true` and `permissionOnChain: "active"`. Then `jaw_pay_and_fetch {"url":"{SELLER}/exact"}` pays, and `seller.log` gains a `payment` row with `"signatureValid":true`. A second `jaw_grant_permissions` is refused as active.

## Gotchas

- The tool spends nothing itself, but grant-approve moves a small USDC seed to the session in the grant transaction.
- `JAW_BRIDGE_TIMEOUT_MS` sets both the wait for the browser to reach the relay and the wait for the approval.
- Nothing may reach stdout: it is the MCP transport. With `JAW_NO_BROWSER` the URL goes to the server's stderr, which `mcp.mjs` does not save.
