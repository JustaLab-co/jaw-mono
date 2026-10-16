# @jaw-mono/mcp

The hosted JAW MCP server. Any MCP client connects over Streamable HTTP at `/mcp` and authorizes through OAuth 2.1. The account owner approves the connection once, in the JAW wallet, the same way `jaw session setup` does for the CLI: a daily USDC budget granted on chain to a session key the server holds. The budget is USDC only: within it the agent pays x402 services and sends USDC with no further prompts. Any other contract call goes to the owner, who approves it in the wallet each time and pays its gas.

## Connecting

`/oauth/authorize` lands on `/interaction/<uid>`, a page this server renders. When the owner clicks "Open JAW", it opens a session on JAW's relay and links the owner to keys.jaw.id `/cli-bridge`, the page the CLI uses, so every request is answered in the wallet's own dialogs. Messages over the relay are encrypted end to end under a key agreed through the link's fragment, and carry no key of this server: the page uses its own deployment's.

A CIMD client must include `refresh_token` in its `grant_types`, or the server refuses it with `invalid_client_metadata` before any consent screen. Without a refresh token the session key lives only in the short access token, and the float granted at connect would be stranded once it expires.

The owner first signs a plain-text sign-in that names the app, the domain of its metadata document, what it asks for, and a six-character code the page also shows. The wallet link can be forwarded, so the text asks the owner to approve only if the page that sent them there shows that code. A connection that spends then asks for the budget, and its permission must come from the account that signed in; the server checks it on chain. The page completes the authorization once the server has both.

The session key is created once the owner signs in, and stored sealed before the wallet is asked for the budget, since the grant's prefund goes to its address. A retry of the same interaction keeps that key. The sealed copy stays until the code exchange, which wraps it under the refresh token and clears it. If the code exchange never happens (the client drops the authorization code, or the provider fails to hand it back), the reconciler retires the connection once the exchange window passes (the code TTL of 60 seconds plus a two-minute margin): it revokes the on-chain budget, returns the prefund to the owner, clears the sealed key and ends the connection. A retire that cannot run (payments paused, no API key, chain error) keeps the key and logs at error level for the next run. The ticket and the code are derived from the interaction under the sealing key, so every replica shows the same ones.

A wallet session ends at a deadline: a minute before the interaction does, or ten minutes after a budget, revoke or `jaw_send_calls` request. An approval cannot land after the flow it belongs to is over. One process holds at most 150 sessions for authorizations and 50 for `jaw_request_budget`, `jaw_revoke_connection`, `jaw_send_calls` and `jaw_swap`, so authorizations cannot take the slots the tools need; past either, the page or the tool answers that the wallet is busy. A session opens only on the owner's click, from the browser holding the interaction cookie, and one address can hold 5 of them at a time and one client 50. Holding them needs a long-lived Node process, as the Docker image runs, not serverless functions.

One account can hold at most 20 active connections. The check runs after the owner signs in, before the budget is asked, so no session key or prefund is created for a connection that would exceed the cap. The page tells the owner to revoke one first (`jaw_connections` lists them, `jaw_revoke_connection` ends one).

## Scopes

| Scope                                 | Tools                                                                                                                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet:read` (required, the default) | `jaw_status`, `jaw_discover`, `jaw_quote`, `jaw_add_funds`, `jaw_history`, `jaw_connections`, `jaw_revoke_connection`, `jaw_disconnect`, `jaw_swap_status`, `jaw_send_calls`, `jaw_send_calls_status` |
| `x402:pay`                            | `jaw_request_budget`, `jaw_pay_and_fetch`, `jaw_swap`                                                                                                                                                 |
| `wallet:send`                         | `jaw_request_budget`, `jaw_transfer`                                                                                                                                                                  |

No scope implies another. A tool refused for a missing scope answers with an error naming the scope; the agent reconnects and asks for it, which makes a new connection, so a budget approved on the old one does not carry over.

A payment or transfer past what the budget has left is refused and points at `jaw_request_budget`, which returns a wallet link for the owner to approve a new one. The new budget replaces the connection's current one, and the session key then revokes the old one on chain, paying the fee from its float. A replaced budget it cannot revoke is retried after the next budget lands, and `jaw_disconnect` revokes it with the rest. Other contract calls stay outside the budget. `jaw_send_calls` asks the owner to approve up to 10 calls on one chain: it returns a wallet link, and the owner reviews and signs them in the wallet and pays the gas. `jaw_send_calls_status` follows the request until it is mined. Signatures are not offered: a session key never signs for the account.

`jaw_discover` searches the x402 Bazaar for services payable on the connection's chain, as the CLI's does; resolving a name is one of those services, not a free tool. `jaw_transfer` still takes an ENS name and resolves it on the server.

## Run it

```bash
docker build -f apps/mcp/Dockerfile -t jaw-mcp .   # from the repository root
docker run -p 3000:3000 -e DATABASE_URL=... -e JAW_MCP_PUBLIC_URL=http://localhost:3000 \
  -e JAW_KEYS_URL=https://keys.jaw.id -e JAW_MCP_SEALING_KEYS=... jaw-mcp
```

Migrations run at start and are safe to run from several instances at once.

Migrations must run as the app role, over a direct connection to Postgres, not through a transaction-mode pooler such as PgBouncer or the Supabase pooler on port 6543. Migration `0011` sets `statement_timeout` for the current role in the current database, so a different role leaves the app database unbounded. The runner also relies on session state, `set statement_timeout = 0` and `pg_advisory_lock`, which a transaction-mode pooler can move to another backend between statements, so the lock and the timeout reset stop holding. `GET /api/health` answers `{ db, paused }`, and 503 when Postgres is unreachable.

Each instance opens up to 26 Postgres sessions: a pool of 10 for requests, plus one session per refill or disconnect in progress, at most 16, which holds that connection's funding lock while it waits on the chain. Size `max_connections`, or the pooler in front of Postgres, for 26 per instance.

## Tests

`bunx nx test @jaw-mono/mcp` runs on PGlite, which runs one transaction at a time, so it cannot show a lock race. `test-pg` runs every `*.test.ts` file under `src` that references `TEST_PG_URL` (`beforeAll(TEST_PG_URL ? useTestPostgres : useTestDb)`), so a new file opts in by importing it on a real Postgres, one fresh database per file, plus the tests under `describe.skipIf(!TEST_PG_URL)`. CI runs it against a `postgres:17` service. Locally:

```bash
docker run -d --rm --name mcp-test-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:17
MCP_TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:55432/postgres bunx nx run @jaw-mono/mcp:test-pg
```

A killed run can leave `mcp_test_*` databases behind. List them with `psql "$MCP_TEST_DATABASE_URL" -c '\l mcp_test_*'` and drop each with `drop database <name> with (force)`. Removing the container removes them all.

## Configuration

| Variable                       | Required | Meaning                                                                                                                                                                                |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                 | yes      | Postgres connection string                                                                                                                                                             |
| `JAW_MCP_PUBLIC_URL`           | yes      | The origin clients reach. It is the OAuth issuer, and the MCP resource is `<origin>/mcp`                                                                                               |
| `JAW_KEYS_URL`                 | yes      | The keys.jaw.id origin whose `/cli-bridge` page the owner opens to approve                                                                                                             |
| `JAW_RELAY_URL`                | no       | The relay that page and this server talk through, `wss://relay.jaw.id` by default                                                                                                      |
| `JAW_MCP_DAILY_BUDGET`         | no       | USDC base units per day a paying connection asks for when it connects, default 1000000 (1 USDC). `jaw_request_budget` asks for another                                                 |
| `JAW_MCP_SEALING_KEYS`         | yes      | Comma-separated base64url keys of 32 bytes, newest first. New tokens use the first; any of them opens an existing one                                                                  |
| `JAW_MCP_CHAIN_ID`             | no       | 84532 (default) or 8453                                                                                                                                                                |
| `JAW_MCP_RPC_URL`              | no       | RPC for that chain; the chain's public RPC when unset                                                                                                                                  |
| `JAW_MCP_MAINNET_RPC_URL`      | no       | RPC for ENS lookups                                                                                                                                                                    |
| `JAW_MCP_TRUSTED_PROXY_HOPS`   | no       | Proxies in front that append to `x-forwarded-for`. Unset or 0 ignores that header and rate-limits on `x-real-ip`, which Vercel sets itself                                             |
| `JAW_MCP_INSECURE_FETCH_HOSTS` | no       | `host:port` list `jaw_quote` and `jaw_pay_and_fetch` may reach over http or a private address. Startup fails unless `JAW_MCP_PUBLIC_URL` is local                                      |
| `JAW_MCP_SWAP_URL`             | no       | Base URL of the swap backend, `https://api.justaname.id/proxy/v2` by default. No query or hash, and https to a public host unless its `host:port` is in `JAW_MCP_INSECURE_FETCH_HOSTS` |
| `JAW_MCP_SWAP_QUOTE_TTL_SEC`   | no       | Seconds the swap backend keeps a quote, its `AURORA_QUOTE_TTL_SEC`, default 300. The owner has until 60 s before that, ten minutes at most, to approve a `jaw_swap` deposit            |
| `JAW_MCP_API_KEY`              | no       | JAW api key the ERC-20 paymaster charges a refill's gas through. Unset, no refill runs and a payer with no float cannot pay                                                            |
| `JAW_MCP_FLOAT_TARGET`         | no       | Base units a refill brings the payer up to, default 250000 (0.25 USDC), so most payments need no refill. The budget's daily cap still bounds every refill                              |
| `JAW_MCP_CRON_SECRET`          | no       | Bearer secret for `/api/cron/reconcile` and `/api/metrics`. Unset, both answer 401                                                                                                     |
| `JAW_MCP_RECONCILE_EVERY`      | no       | Seconds between reconciler runs inside the server, default 60. Set 0 only when a cron calls `/api/cron/reconcile`                                                                      |

A connection's expiry slides forward by 30 days on every successful token refresh, so a client in active use never hits the cliff. A client that stops refreshing expires after 30 days of inactivity. `jaw_status` includes `connectionExpiresAt` and warns the agent when the connection is within 48 hours of expiry, so it can call `jaw_disconnect` to sweep the float and revoke budgets while it still holds a working token. When a reused refresh token triggers revocation and its key wrap is still present (before the periodic sweep), the server recovers the key and sweeps the float before ending the connection.

To rotate sealing keys, put the new key first. A connection moves to the new key on its next token refresh, so keep the old key for at least 30 days (the maximum idle lifetime) before dropping it; `select split_part(key_wrap, '.', 2), count(*) from oauth_payloads where model = 'RefreshToken' and consumed_at is null group by 1` shows which keys are still in use. A refresh that needs a dropped key fails without using up the token, so restoring the key repairs it. Generate a key with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.

## Operations

The kill switch stops `/mcp`, OAuth and the interaction routes with a 503 and leaves health up:

```sql
insert into settings (key, value) values ('paused', 'true')
on conflict (key) do update set value = excluded.value, updated_at = now();
```

Payments alone stop with `('payments_paused', 'true')` in the same table: `jaw_pay_and_fetch` and `jaw_swap` refuse with `payments_paused` before they sign anything (a `jaw_swap` retry of a stored swap still answers), `jaw_transfer` refuses before it sends, `jaw_send_calls` refuses before it opens a wallet link (a retry whose link is still live answers from the stored request), `jaw_send_calls_status` keeps working, `jaw_disconnect` refuses before it revokes or returns anything, and every other tool keeps working.

`/api/cron/reconcile` (GET or POST, `Authorization: Bearer <JAW_MCP_CRON_SECRET>`) clears the key wraps of refresh tokens used more than a minute ago, settles or fails every payment left `signed` or `unknown` for more than a minute by asking the chain, logs one error per payment still unanswered an hour past its deadline, concludes up to 50 `jaw_send_calls` requests left `sent` for more than a minute as `landed` or `reverted` by reading the bundler receipt (a request still at `send_started` has no calls id to read and is left alone; the bundler answers only for recent user operations, so one it has no receipt for ten minutes after the send is looked up on chain instead, as the `UserOperationEvent` of EntryPoint 0.8 for its calls id, in ranges of 200 blocks (the cap of the public Base RPC) and at most 50 ranges per request, for at most 5 requests per run and none once the head is 10,000 blocks past where the search starts, from the head recorded when it was sent or, for older rows, from a block estimated from the row's age; `jaw_send_calls_status` does the same), and deletes expired OAuth state, rate limit windows, audit events older than 90 days, and pending connections nothing refers to. A pending connection the owner approved but whose authorization never completed is retired past the interaction's end: its key revokes the budget and returns the prefund to the owner, as `jaw_disconnect` does, and then its sealed key is cleared. A run that cannot send keeps the key for the next one. `/api/metrics` serves payments by state, the reconciler backlog, refused `/mcp` calls per client, and `jaw_mcp_wraps_past_window`, the key wraps still stored for refresh tokens past their retry window, in Prometheus text. Each rotation sweeps those wraps and logs `wrap sweep failed` when it cannot; alert when the gauge stays above zero for longer than one cron interval.

Every tool call writes one row to `audit_events` with the connection, the tool, the outcome, and the request id from `x-request-id`. The outcome is `ok`, `error`, the code of a payment that ended without paying (such as `budget_exhausted` or `payments_paused`), or `unknown` for a payment that may have reached the seller while the chain settles it. Arguments and results are never stored. `jaw_connections` lists every connection of the account with its budget. `jaw_revoke_connection` asks the owner to confirm in the wallet, with a signature over the connection it ends, and then ends it: its tokens stop at once and its refresh tokens go with the key wraps they carry, so its budget and the float left in its payer can no longer be moved. The tool reads that float and says how much stays there. `jaw_disconnect`, called from the connection itself, also revokes its budgets on chain and returns the float to the owner first. When the payer's balance is too low to cover both the fee and a sweep, a revoke-only batch sends the revocations and lets the paymaster take its fee from whatever is there; the remainder stays in the payer.

Authenticated `/mcp` calls get 120 requests per minute per connection, and unauthenticated routes 120 per client IP, counted in Postgres. Behind your own proxy, production must set `JAW_MCP_TRUSTED_PROXY_HOPS`: without it the client IP comes only from `x-real-ip` (which Vercel sets), and with neither the per-IP limit is skipped rather than shared, with a warning at start. See `.env.example`.
