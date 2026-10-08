# Hosted server

`apps/mcp` serves the payment tools over MCP Streamable HTTP to remote clients, with OAuth and all state in Postgres.

## Sub-features

- `db-up`: Postgres for the run answers and accepts migrations.
- `mcp-up`: the server answers MCP `initialize` over HTTP.
- `mcp-pay`: `jaw_pay_and_fetch` over HTTP pays the local seller and writes a `payments` row.

## How to get to it (user POV)

- An MCP client pointed at `MCP_URL` from `run.env`, authenticated with a token.
- Operators: `DATABASE_URL` from `run.env`, or `psql` inside the postgres container.

## Driving it with hosted-up.sh

Preconditions: Docker running; baseline preconditions for the seller.

- db-up: `$S/hosted-up.sh "$RUN"`, then `. "$RUN/run.env"; docker compose -p "$COMPOSE_PROJECT" -f $S/compose.yaml exec -T postgres psql -U jaw -d jaw_mcp -c 'select 1' | tee "$RUN/evidence/db-up.txt"` prints one row. `$S/doctor.sh "$RUN"` prints `ok   postgres ready`.
- mcp-up: `hosted-up.sh` also builds and starts apps/mcp and writes `MCP_URL`. `curl -s -X POST "$MCP_URL" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}'` returns a result with `serverInfo`. Tool calls need an OAuth token and are not scripted here.
- mcp-pay: not scripted here. The pass condition is a `paid` result, a `seller.log` payment row with `"signatureValid":true`, and a `payments` row in state `settled` for the same idempotency key.

## Gotchas

- Postgres runs on tmpfs; data is gone after `down.sh`. Dump what you need into `evidence/` before cleanup.
- Each run is its own compose project, `jaw-verify-<run-id>`. `down.sh` removes only that project.
- Inside the container the seller is not at `localhost`; use `host.docker.internal:$PORT` when the server must reach it.
