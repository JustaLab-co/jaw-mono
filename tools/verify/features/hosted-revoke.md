# Hosted revoke

`jaw_revoke_permission` in `apps/mcp` asks the account owner to revoke one permission on chain with `wallet_revokePermissions`. keys.jaw.id reads the permission from JAW's permission store by id, shows it, and the owner pays the gas. Any connection with `wallet:read` may ask, for any permission granted from the account. `jaw_connections` lists each connection's grants by `permissionId`.

## Sub-features

- `revoke-own`: this connection's x402 budget, once revoked, leaves the next payment with no budget.
- `revoke-other`: another connection's grant on the same account revokes the same way, and `jaw_connections` lists it `revoked`.
- `revoke-orphan`: a permission live on chain with no `grants` row (approved while the server failed to record it) is read from the permission store and revoked. `jaw_connections` lists such ids under each connection's `unrecorded`, and the `permission_requests` row records the outcome.
- `revoke-refusals`: an unknown id, another account's permission, a chain it was not granted on, one already revoked, one already ended and a recorded grant the permission store does not hold are each refused by name (`unknown_permission`, `wrong_chain`, `already_revoked`, `expired`, `not_in_store`) before any link opens.
- `revoke-declined`: the owner rejects in the wallet. The grant stays live and the request row reads `owner_declined`.
- `revoke-one-open`: asking again from the same connection for a permission whose revoke waits returns the same link. Another connection, or a second permission from the same connection, is refused as `revoke_in_progress` with no link.
- `revoke-unconfirmed`: the wallet answered but the chain did not show the revoke within about 15 seconds. The request reads `approved` with code `unconfirmed`, and asking again marks the grant revoked once the chain shows it. Without a new ask, the reconciler (`/api/cron/reconcile`, or the server's own loop every `JAW_MCP_RECONCILE_EVERY` seconds) reads the chain for it at most every five minutes during the day after it was asked and settles it the same way. Past that day the row ends `failed` with `revoke_not_seen`. The cron's report counts it under `links.revoked`.
- `revoke-rate`: more than 10 revoke calls a minute on one connection for permissions with no revoke link waiting are refused as `rate_limited` before the permission store or the chain is read. Asking again about a permission whose revoke link waits is not counted.
- `link-sweep`: a waiting grant, revoke or sign link that no server has renewed for over 90 seconds is ended by the reconciler (`expired`, with `link_lost` when the owner was already asked, `session_lost` when not, no code past its window; an asked revoke stays until its window ends, since other connections wait on it), counted under `links.expired` in the cron's report. A link whose server still renews it is left alone, even past its window, and so is a link that holds a relay session waiting to be rejoined after a restart, until its window ends.
- `link-cap`: grant and revoke links count toward the account's three open owner links with `jaw_send_calls` and `jaw_swap`. A fourth link of any kind is refused as `account_busy`.
- `revoke-old-name`: `jaw_revoke_connection` is an unknown tool.
- `revoke-in-wallet`: a budget the owner revoked in the wallet, which the server never heard of, is recorded revoked by the next payment or the next reconciler run. The payment is made from the connection's next live budget instead of failing `grant_revoked`.

## How to get to it (user POV)

- An MCP client on the hosted server. `jaw_connections` gives the `permissionId` of each grant; `jaw_revoke_permission` takes `permissionId` and an optional `chainId` (the connection's chain when absent).
- The result holds `url`, the wallet link, `spender`, `connection` (null for a permission the server never recorded), `approveBy` and a `summary`.
- By hand: `node tools/verify/hosted-client.mjs "$MCP_PUBLIC_URL"`, then `connections` and `revoke <permission id> [chainId]`.

## Driving it

Preconditions: baseline preconditions of this map; Docker running; `JAW_KEYS_URL=https://keys.jaw.id` and `JAW_MCP_API_KEY` set when the stack starts, per hosted-mcp.md. Dump `grants` and `permission_requests` with psql in the postgres container after each drive.

- revoke-own: `connections`, then `revoke <this connection's budget id>`, approve in the wallet. Pass: keys.jaw.id names the spender and USDC; the `grants` row has `revoked_at`; `pay $SELLER/exact` refuses with a named reason.
- revoke-other: connect a second client, then from the first `revoke <its budget id>`, approve. Pass: `connections` lists that grant `revoked`, and `readPermissionState` reads it revoked on Base Sepolia.
- revoke-refusals: `revoke 0x<64 random hex>`, then `revoke <a budget id> 8453`. Pass: `unknown_permission:` and `wrong_chain:`, no `url`.
- revoke-declined: `revoke <id>`, reject in the wallet. Pass: the grant is still listed `live`; the request row reads `owner_declined`.
- link-cap: open three links without approving them (`budget 1` on three connections, or revokes of three ids), then ask a fourth. Pass: `account_busy:`, no `url`.
- revoke-rate: `revoke 0x<64 random hex>` eleven times within a minute. Pass: the eleventh answers `rate_limited:`.
- revoke-unconfirmed sweep: after revoke-own, set the row back with psql (`update permission_requests set code = 'unconfirmed', updated_at = now() - interval '6 minutes' ...; update grants set revoked_at = null ...`, since a row is read again at most every five minutes), then wait for the server's reconcile loop (30 seconds in the stack). Pass: the row's code is null and `revoked_at` is set again from the chain read.
- link-sweep: open a link, stop the mcp container, start it again, wait 90 seconds plus one reconcile loop. Pass: its row reads `expired` with the matching code.
- revoke-old-name: `call jaw_revoke_connection '{"id":"x"}'`. Pass: an unknown-tool error.
- revoke-in-wallet: with two budgets (`budget 1` twice), revoke the newer one by `revoke <id>` and approve, then clear its `revoked_at` with psql so the server holds it live while the chain says revoked, as after a revoke made in the wallet. Pay only once 30 seconds have passed since the last payment, `status` or `quote`, because the server trusts a budget it read live for that long. `pay $SELLER/exact`. Pass: `paid`, the `payments` row's `permission_id` is the older budget, and the newer one's `revoked_at` is set again. Clear it once more and wait for the server's own reconciler run, every 60 seconds (the stack sets no cron secret; with one, `/api/cron/reconcile` runs the same sweep and reports `grantsRevoked`). Pass: `revoked_at` is set within two runs.
- After revoke-own, `disconnect`. Pass: it ends with no revoke error for the grant already revoked.
