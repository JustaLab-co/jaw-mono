# Hosted server

`apps/mcp` serves the payment tools over MCP Streamable HTTP to remote clients, with OAuth and all state in Postgres.

## Sub-features

- `db-up`: Postgres for the run answers and accepts migrations.
- `mcp-up`: the server is up behind its OAuth gate.
- `mcp-pay`: `jaw_session_x402_pay` over HTTP pays the local seller and writes a `payments` row.
- `mcp-swap-quote`: the server pays the seller's swap quote at `JAW_MCP_SWAP_URL`.
- `mcp-quote-budget`: `jaw_session_x402_quote` names the budget a payment would use and is ready only when the price fits what that budget has left today.
- `mcp-simulate-calls`: `jaw_simulate_calls` dry-runs a batch through the proxy and answers `success`, `reverted` or `error` without signing or sending.

## How to get to it (user POV)

- An MCP client pointed at `MCP_URL` from `run.env`, authenticated with a token.
- Operators: `DATABASE_URL` from `run.env`, or `psql` inside the postgres container.

## Driving it with hosted-up.sh

Preconditions: Docker running; baseline preconditions for the seller.

- db-up: `$S/hosted-up.sh "$RUN"`, then `. "$RUN/run.env"; docker compose -p "$COMPOSE_PROJECT" -f $S/compose.yaml exec -T postgres psql -U jaw -d jaw_mcp -c 'select 1' | tee "$RUN/evidence/db-up.txt"` prints one row. `$S/doctor.sh "$RUN"` prints `ok   postgres ready`.
- mcp-up: `hosted-up.sh` also builds and starts apps/mcp and writes `MCP_URL`. `curl -s "${MCP_URL%/mcp}/api/health"` returns `{"db":"ok","paused":false}`, and an unauthenticated POST of an MCP `initialize` to `$MCP_URL` returns `invalid_token`, which shows the OAuth gate is in front of the tools. Tool calls need an OAuth token and are not scripted here.
- seller reach: `$S/doctor.sh "$RUN"` prints `ok   seller reachable from the mcp container at http://localhost:$PORT`. From inside the container a quote request with no query is refused: `docker compose -p "$COMPOSE_PROJECT" -f $S/compose.yaml exec -T mcp node -e 'fetch(process.argv[1]).then((r) => console.log(r.status))' "http://localhost:$PORT/proxy/v2/move-asset/quote" | tee "$RUN/evidence/mcp-quote-400.txt"` prints `400`, and `seller.log` gets a `refused` row for `/proxy/v2/move-asset/quote`.
- mcp-pay: needs a person to approve the budget in the wallet, so it is driven by hand. Start the stack with `JAW_KEYS_URL=https://keys.jaw.id`, run `node $S/hosted-client.mjs "$MCP_PUBLIC_URL"`, approve a budget (`budget 1`), then `pay http://localhost:$PORT/exact`. The pass condition is a `paid` result, a `seller.log` payment row with `"signatureValid":true`, and a `payments` row in state `settled` for the same idempotency key.
- mcp-swap-quote: in the same client, `call jaw_swap '<json>'` gets the quote through `JAW_MCP_SWAP_URL`. The pass condition is a `seller.log` `quote` row on `/proxy/v2/move-asset/quote` and no `challenge` or `payment` row. An `insecure_url` result means the server points at a host other than localhost.
- mcp-quote-budget: in the same client, after `budget 0.5`, `quote http://localhost:$PORT/one` answers `readiness` `not_ready` with reason `over_allowance`, and its `budget` carries the permission id and `remainingToday` 490000 while the session float is empty (the day less the 0.01 a refill pays for its own transfer), the same figure `status` shows. `quote http://localhost:$PORT/exact` answers `ready`. With the account behind the budget emptied, a quote that needs a refill answers `balance_low`, and `quote http://localhost:$PORT/overcap` (2 USDC) answers `over_cap`, the per-payment cap pay applies; `pay http://localhost:$PORT/overcap` is then refused `over_cap` with no `next`, since a larger budget does not raise that cap. `seller.log` gets only `challenge` rows.
- mcp-simulate-calls: needs a person to connect, so it is driven by hand like mcp-pay. Start the stack with `JAW_KEYS_URL=https://keys.jaw.id` and the staging proxy's api key in `JAW_MCP_API_KEY`, run `node $S/hosted-client.mjs "$MCP_PUBLIC_URL"` and connect with `wallet:read`; no budget is needed. The account must be able to pay gas, natively or through `paymaster`. Success: `call jaw_simulate_calls '{"chainId":84532,"calls":[{"to":"<the connected account>"}]}'` answers `status` `success` and a summary that says nothing was signed or sent. Forced revert: `call jaw_simulate_calls '{"chainId":84532,"calls":[{"to":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","data":"<transfer(address,uint256) of more USDC than the account holds>"}]}'` answers `reverted` with `callIndex` 0, a fenced `reason` and the `revertData`. `call jaw_simulate_calls '{"chainId":1337,"calls":[{"to":"<the connected account>"}]}'` is refused with the chains JAW serves and sends no request. The pass condition is those three answers, no api key in any of them, and no `sends`, `owner_calls` or `payments` row written, since the tool only reads. `status` `error` is not a failure of the calls: run it again.

## Gotchas

- Postgres runs on tmpfs; data is gone after `down.sh`. Dump what you need into `evidence/` before cleanup.
- Each run is its own compose project, `jaw-verify-<run-id>`. `down.sh` removes only that project.
- Inside the container the seller is at `http://localhost:$PORT` only through the `seller-forward` service. Pointed at `host.docker.internal:$PORT` instead, every payment to the seller ends `insecure_url`, because the payer signs over plain http only for localhost.
