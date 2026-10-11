# @jaw-mono/mcp

The hosted JAW MCP server. Any MCP client connects over Streamable HTTP at `/mcp`, authorizes through OAuth 2.1 with a passkey consent on keys.jaw.id, and gets read tools, passkey-approved signatures, and x402 payments from a daily USDC budget the account owner approved on chain.

## Scopes

| Scope                                 | Tools                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `wallet:read` (required, the default) | `jaw_status`, `jaw_quote`, `jaw_add_funds`, `jaw_resolve_name`, `jaw_history`, `jaw_disconnect` |
| `x402:pay`                            | `jaw_request_budget`, `jaw_pay_and_fetch` and the one-off payment it offers past the budget     |
| `wallet:send`                         | `jaw_prepare_transfer`, `jaw_prepare_calls`, `jaw_request_signature`                            |

No scope implies another. `jaw_request_status` needs the scope of the request's kind, and answers a request of another kind as if it did not exist. A tool refused for a missing scope answers with an error naming the scope; the agent reconnects and asks for it, which makes a new connection, so a budget approved on the old one does not carry over. A client that asks for `wallet:read wallet:send` only can no longer request a budget or pay.

The owner can untick `x402:pay` or `wallet:send` on the consent page, never `wallet:read`. The token response's `scope` then lists fewer scopes than the client asked for; read it rather than assuming the request was granted whole. A refresh that asks for an unticked scope is refused with `invalid_scope`.

## Run it

```bash
docker build -f apps/mcp/Dockerfile -t jaw-mcp .   # from the repository root
docker run -p 3000:3000 -e DATABASE_URL=... -e JAW_MCP_PUBLIC_URL=http://localhost:3000 \
  -e JAW_KEYS_URL=http://localhost:3001 -e JAW_MCP_SEALING_KEYS=... jaw-mcp
```

Migrations run at start and are safe to run from several instances at once.

Migrations must run as the app role, over a direct connection to Postgres, not through a transaction-mode pooler such as PgBouncer or the Supabase pooler on port 6543. Migration `0011` sets `statement_timeout` for the current role in the current database, so a different role leaves the app database unbounded. The runner also relies on session state, `set statement_timeout = 0` and `pg_advisory_lock`, which a transaction-mode pooler can move to another backend between statements, so the lock and the timeout reset stop holding. `GET /api/health` answers `{ db, paused }`, and 503 when Postgres is unreachable.

## Configuration

| Variable                       | Required | Meaning                                                                                                                                                   |
| ------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                 | yes      | Postgres connection string                                                                                                                                |
| `JAW_MCP_PUBLIC_URL`           | yes      | The origin clients reach. It is the OAuth issuer, and the MCP resource is `<origin>/mcp`                                                                  |
| `JAW_KEYS_URL`                 | yes      | The keys.jaw.id origin that hosts `/authorize` and `/approve/<id>`                                                                                        |
| `JAW_MCP_SEALING_KEYS`         | yes      | Comma-separated base64url keys of 32 bytes, newest first. New tokens use the first; any of them opens an existing one                                     |
| `JAW_MCP_CHAIN_ID`             | no       | 84532 (default) or 8453                                                                                                                                   |
| `JAW_MCP_RPC_URL`              | no       | RPC for that chain; the chain's public RPC when unset                                                                                                     |
| `JAW_MCP_MAINNET_RPC_URL`      | no       | RPC for ENS lookups                                                                                                                                       |
| `JAW_MCP_TRUSTED_PROXY_HOPS`   | no       | Proxies in front that append to `x-forwarded-for`. Unset or 0 ignores that header and rate-limits on `x-real-ip`, which Vercel sets itself                |
| `JAW_MCP_INSECURE_FETCH_HOSTS` | no       | `host:port` list that `jaw_quote` and `jaw_pay_and_fetch` may reach over plain http or on a private address. Local testing only                           |
| `JAW_MCP_API_KEY`              | no       | JAW api key the ERC-20 paymaster charges a refill's gas through. Unset, no refill runs and a payer with no float cannot pay                               |
| `JAW_MCP_FLOAT_TARGET`         | no       | Base units a refill brings the payer up to, default 250000 (0.25 USDC), so most payments need no refill. The budget's daily cap still bounds every refill |
| `JAW_MCP_CRON_SECRET`          | no       | Bearer secret for `/api/cron/reconcile` and `/api/metrics`. Unset, both answer 401                                                                        |
| `JAW_MCP_RECONCILE_EVERY`      | no       | Seconds between reconciler runs inside the server, for a container where nothing calls the cron route                                                     |

keys.jaw.id needs `JAW_MCP_URL`, the same origin as `JAW_MCP_PUBLIC_URL`.

keys.jaw.id deploys on every merge to main and this server does not, so keys usually ships first. Deploy this server right after it when a change touches the consent page or `/interaction`. The page copes with an older server for the consent change: when `/details` sends no `required` flag it still keeps `wallet:read` ticked, but an older server ignores the unticked scopes and refuses a narrowed signature as `bad_signature` until it is deployed.

To rotate sealing keys, put the new key first. A connection moves to the new key on its next token refresh, so keep the old key for the 30-day refresh token lifetime before dropping it; `select split_part(key_wrap, '.', 2), count(*) from oauth_payloads where model = 'RefreshToken' and consumed_at is null group by 1` shows which keys are still in use. A refresh that needs a dropped key fails without using up the token, so restoring the key repairs it. Generate a key with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.

## Operations

The kill switch stops `/mcp`, OAuth and the approval routes with a 503 and leaves health up:

```sql
insert into settings (key, value) values ('paused', 'true')
on conflict (key) do update set value = excluded.value, updated_at = now();
```

Payments alone stop with `('payments_paused', 'true')` in the same table: `jaw_pay_and_fetch` refuses with `payments_paused` before it signs anything, the approval page refuses to record an approved one-off payment (the request stays pending), `jaw_request_status` resends nothing, `jaw_disconnect` refuses before it revokes or returns anything, and every other tool keeps working.

`/api/cron/reconcile` (GET or POST, `Authorization: Bearer <JAW_MCP_CRON_SECRET>`) clears the key wraps of refresh tokens used more than a minute ago, settles or fails every payment left `signed` or `unknown` for more than a minute by asking the chain, logs one error per payment still unanswered an hour past its deadline, and deletes expired OAuth state, rate limit windows, audit events older than 90 days, and pending connections and approval requests nothing refers to. `/api/metrics` serves payments by state, the reconciler backlog, refused `/mcp` calls per client, and `jaw_mcp_wraps_past_window`, the key wraps still stored for refresh tokens past their retry window, in Prometheus text. Each rotation sweeps those wraps and logs `wrap sweep failed` when it cannot; alert when the gauge stays above zero for longer than one cron interval.

Every tool call writes one row to `audit_events` with the connection, the tool, the outcome, and the request id from `x-request-id`. The outcome is `ok`, `error`, the code of a payment that ended without paying (such as `budget_exhausted` or `payments_paused`), or `unknown` for a payment that may have reached the seller while the chain settles it. Arguments and results are never stored. The account owner sees the last ten per connection on keys.jaw.id `/connections`, which signs in with the passkey (a typed data signature under the JAW domain, checked on every request, valid at most 15 minutes). Revoking there ends the tokens at once and deletes the refresh tokens with the key wraps they carry, so the float left in the payer can no longer be moved; `jaw_disconnect` returns it to the owner first.

Authenticated `/mcp` calls get 120 requests per minute per connection, and unauthenticated routes 120 per client IP, counted in Postgres. Behind your own proxy, production must set `JAW_MCP_TRUSTED_PROXY_HOPS`: without it the client IP comes only from `x-real-ip` (which Vercel sets), and with neither the per-IP limit is skipped rather than shared, with a warning at start. See `.env.example`.
