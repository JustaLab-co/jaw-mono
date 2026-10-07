# @jaw-mono/mcp

The hosted JAW MCP server. Any MCP client connects over Streamable HTTP at `/mcp`, authorizes through OAuth 2.1 with a passkey consent on keys.jaw.id, and gets read tools and passkey-approved signatures for the connected account.

## Run it

```bash
docker build -f apps/mcp/Dockerfile -t jaw-mcp .   # from the repository root
docker run -p 3000:3000 -e DATABASE_URL=... -e JAW_MCP_PUBLIC_URL=http://localhost:3000 \
  -e JAW_KEYS_URL=http://localhost:3001 -e JAW_MCP_SEALING_KEYS=... jaw-mcp
```

Migrations run at start and are safe to run from several instances at once. `GET /api/health` answers `{ db, paused }`, and 503 when Postgres is unreachable.

## Configuration

| Variable                       | Required | Meaning                                                                                                                                    |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                 | yes      | Postgres connection string                                                                                                                 |
| `JAW_MCP_PUBLIC_URL`           | yes      | The origin clients reach. It is the OAuth issuer, and the MCP resource is `<origin>/mcp`                                                   |
| `JAW_KEYS_URL`                 | yes      | The keys.jaw.id origin that hosts `/authorize` and `/approve/<id>`                                                                         |
| `JAW_MCP_SEALING_KEYS`         | yes      | Comma-separated base64url keys of 32 bytes, newest first. New tokens use the first; any of them opens an existing one                      |
| `JAW_MCP_CHAIN_ID`             | no       | 84532 (default) or 8453                                                                                                                    |
| `JAW_MCP_RPC_URL`              | no       | RPC for that chain; the chain's public RPC when unset                                                                                      |
| `JAW_MCP_MAINNET_RPC_URL`      | no       | RPC for ENS lookups                                                                                                                        |
| `JAW_MCP_TRUSTED_PROXY_HOPS`   | no       | Proxies in front that append to `x-forwarded-for`. Unset or 0 ignores that header and rate-limits on `x-real-ip`, which Vercel sets itself |
| `JAW_MCP_INSECURE_FETCH_HOSTS` | no       | `host:port` list that `jaw_quote` may reach over plain http or on a private address. Local testing only                                    |

keys.jaw.id needs `JAW_MCP_URL`, the same origin as `JAW_MCP_PUBLIC_URL`.

To rotate sealing keys, put the new key first. A connection moves to the new key on its next token refresh, so keep the old key for the 30-day refresh token lifetime before dropping it; `select split_part(key_wrap, '.', 2), count(*) from oauth_payloads where model = 'RefreshToken' and consumed_at is null group by 1` shows which keys are still in use. A refresh that needs a dropped key fails without using up the token, so restoring the key repairs it. Generate a key with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.

## Operations

The kill switch stops `/mcp`, OAuth and the approval routes with a 503 and leaves health up:

```sql
insert into settings (key, value) values ('paused', 'true')
on conflict (key) do update set value = excluded.value, updated_at = now();
```

Authenticated `/mcp` calls get 120 requests per minute per connection, and unauthenticated routes 120 per client IP, counted in Postgres. Behind your own proxy, production must set `JAW_MCP_TRUSTED_PROXY_HOPS`: without it the client IP comes only from `x-real-ip` (which Vercel sets), and with neither the per-IP limit is skipped rather than shared, with a warning at start. See `.env.example`.
