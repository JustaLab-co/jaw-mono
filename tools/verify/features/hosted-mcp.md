# Hosted server

`apps/mcp` serves the payment tools over MCP Streamable HTTP to remote clients, with OAuth and all state in Postgres.

## Sub-features

- `db-up`: Postgres for the run answers and accepts migrations.
- `mcp-up`: the server is up behind its OAuth gate.
- `mcp-pay`: `jaw_session_x402_pay` over HTTP pays the local seller and writes a `payments` row.
- `mcp-swap-quote`: the server pays the seller's swap quote at `JAW_MCP_SWAP_URL`.

## How to get to it (user POV)

- An MCP client pointed at `MCP_URL` from `run.env`, authenticated with a token.
- Operators: `DATABASE_URL` from `run.env`, or `psql` inside the postgres container.

## Driving it with hosted-up.sh

Preconditions: Docker running; baseline preconditions for the seller.

- db-up: `$S/hosted-up.sh "$RUN"`, then `. "$RUN/run.env"; docker compose -p "$COMPOSE_PROJECT" -f $S/compose.yaml exec -T postgres psql -U jaw -d jaw_mcp -c 'select 1' | tee "$RUN/evidence/db-up.txt"` prints one row. `$S/doctor.sh "$RUN"` prints `ok   postgres ready`.
- mcp-up: `hosted-up.sh` also builds and starts apps/mcp and writes `MCP_URL`. `curl -s "${MCP_URL%/mcp}/api/health"` returns `{"db":"ok","paused":false}`, and an unauthenticated POST of an MCP `initialize` to `$MCP_URL` returns `invalid_token`, which shows the OAuth gate is in front of the tools. Tool calls need an OAuth token and are not scripted here.
- seller reach: `$S/doctor.sh "$RUN"` prints `ok   seller reachable from the mcp container at http://localhost:$PORT`. From inside the container the unpaid quote answers 402 with a `PAYMENT-REQUIRED` header: `docker compose -p "$COMPOSE_PROJECT" -f $S/compose.yaml exec -T mcp node -e 'fetch(process.argv[1]).then((r) => console.log(r.status, r.headers.get("payment-required")))' "http://localhost:$PORT/proxy/v2/swap/quote" | tee "$RUN/evidence/mcp-quote-402.txt"` prints `402` and the base64 challenge, and `seller.log` gets a `challenge` row for `/proxy/v2/swap/quote`.
- mcp-pay: needs a person to approve the budget in the wallet, so it is driven by hand. Start the stack with `JAW_KEYS_URL=https://keys.jaw.id`, run `node $S/hosted-client.mjs "$MCP_PUBLIC_URL"`, approve a budget (`budget 1`), then `pay http://localhost:$PORT/exact`. The pass condition is a `paid` result, a `seller.log` payment row with `"signatureValid":true`, and a `payments` row in state `settled` for the same idempotency key.
- mcp-swap-quote: in the same client, `call jaw_swap '<json>'` pays the quote through `JAW_MCP_SWAP_URL`. The pass condition is a `seller.log` `payment` row with `"signatureValid":true` on `/proxy/v2/swap/quote`, then a `quote` row. An `insecure_url` result means the server points at a host other than localhost.

## Gotchas

- Postgres runs on tmpfs; data is gone after `down.sh`. Dump what you need into `evidence/` before cleanup.
- Each run is its own compose project, `jaw-verify-<run-id>`. `down.sh` removes only that project.
- Inside the container the seller is at `http://localhost:$PORT` only through the `seller-forward` service. Pointed at `host.docker.internal:$PORT` instead, every payment to the seller ends `insecure_url`, because the payer signs over plain http only for localhost.
