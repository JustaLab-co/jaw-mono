# Hosted revoke

`jaw_revoke_permission` in `apps/mcp` asks the account owner to revoke one permission on chain with `wallet_revokePermissions`. keys.jaw.id reads the permission from JAW's permission store by id, shows it, and the owner pays the gas. Any connection with `wallet:read` may ask, for any permission granted from the account. `jaw_connections` lists each connection's grants by `permissionId`.

## Sub-features

- `revoke-own`: this connection's x402 budget, once revoked, leaves the next payment with no budget.
- `revoke-other`: another connection's grant on the same account revokes the same way, and `jaw_connections` lists it `revoked`.
- `revoke-orphan`: a permission live on chain with no `grants` row (approved while the server failed to record it) is read from the permission store and revoked. `jaw_connections` lists such ids under each connection's `unrecorded`, and the `permission_requests` row records the outcome.
- `revoke-refusals`: an unknown id, another account's permission, a chain it was not granted on, one already revoked, one already ended and a recorded grant the permission store does not hold are each refused by name (`unknown_permission`, `wrong_chain`, `already_revoked`, `expired`, `not_in_store`) before any link opens.
- `revoke-declined`: the owner rejects in the wallet. The grant stays live and the request row reads `owner_declined`.
- `revoke-one-open`: asking again from the same connection for a permission whose revoke waits returns the same link. Another connection, or a second permission from the same connection, is refused as `revoke_in_progress` with no link.
- `revoke-unconfirmed`: the wallet answered but the chain did not show the revoke within about 15 seconds. The request reads `approved` with code `unconfirmed`, and asking again marks the grant revoked once the chain shows it.
- `link-cap`: grant and revoke links count toward the account's three open owner links with `jaw_send_calls` and `jaw_swap`. A fourth link of any kind is refused as `account_busy`.
- `revoke-old-name`: `jaw_revoke_connection` is an unknown tool.

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
- revoke-old-name: `call jaw_revoke_connection '{"id":"x"}'`. Pass: an unknown-tool error.
- After revoke-own, `disconnect`. Pass: it ends with no revoke error for the grant already revoked.
