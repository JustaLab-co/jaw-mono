# Hosted grants

`jaw_grant_permissions` in `apps/mcp` asks the account owner to grant the connection's session key a permission, approved once in the wallet. The `x402Budget` preset asks for the daily USDC budget that payments, refills and swap quotes draw from. A custom grant names `calls`, the contract functions the session key may call, and `spends`, how much of each token it may move per period. The tool needs `x402:pay`.

## Sub-features

- `grant-preset`: `x402Budget` asks for the same USDC transfer call and daily USDC spend the connect page asks for, with `prefundSpender`, and the row reads `kind = x402-budget` and `period = day`.
- `grant-custom`: calls and spends give a row with `kind = custom`. With one spend the row holds its token, allowance and period; with several they are null and the struct in `permission` holds them all.
- `grant-link-sweep`: a waiting grant link no server renews any more is ended by the reconciler, as `link-sweep` in hosted-revoke.md describes.
- `grant-clamp`: an `expiresAt` later than the connection's end asks the wallet for the connection's end, and the result's `expiresAt` says so.
- `grant-past`: an `expiresAt` already past is refused as `expiry_in_past`, and one that ends inside the 30 minutes the owner has to approve as `expiry_too_soon`, before any link opens.
- `grant-target`: a call to the account itself, the permission manager, an EntryPoint or the any-contract wildcard `0x3232...3232` is refused as `call_target_refused` before any link opens.
- `grant-mismatch`: a wallet answer that differs from the request in any call or spend records no row.
- `grant-input`: the preset together with calls, spends or an expiry, spends without calls, a malformed function signature, a period the wallet does not take, an allowance of 2^160 or more and a yearly multiplier above 5461 are refused with no link.
- `grant-cap`: a connection holding 5 live grants of either kind is refused before a link opens.
- `grant-one-open`: a second request while one waits on the owner is refused with the waiting link. The waiting link counts toward the account's three open owner links (hosted-revoke.md, `link-cap`).
- `grant-old-name`: `jaw_request_budget` is an unknown tool.

## How to get to it (user POV)

- An MCP client on the hosted server with scope `x402:pay`. `jaw_grant_permissions` takes either `x402Budget: { perDay }` alone, with `perDay` USDC as a decimal, or `calls` (1 to 10 `{ target, functionSignature }`), optional `spends` (up to 10 `{ token, allowance, unit, multiplier? }`, `allowance` in base units, `unit` one of `minute`, `hour`, `day`, `week`, `month`, `year`, `forever`) and optional `expiresAt` (ISO 8601).
- The result holds `url`, the wallet link, `expiresAt`, when the grant would end, and a `summary` for the person.
- The owner opens the `url` within 30 minutes, and keys.jaw.id shows the permission: each call, each spend limit with its period, and the expiry.
- By hand: `node tools/verify/hosted-client.mjs "$MCP_PUBLIC_URL"`, then `budget <perDay>` for the preset or `grant '<json>'` for any input.

## Driving it

Preconditions: baseline preconditions of this map; Docker running; `JAW_KEYS_URL=https://keys.jaw.id` and `JAW_MCP_API_KEY` set when the stack starts, per hosted-mcp.md. Base Sepolia WETH is `0x4200000000000000000000000000000000000006`, USDC is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Dump `grants` with psql in the postgres container after each drive.

- grant-preset: `budget 1`, approve in the wallet. Pass: the newest `grants` row reads `kind = x402-budget`, `period = day`, `allowance = 1000000`, the USDC token, and `expires_at` equal to the connection's `expires_at` to the second.
- grant-custom: `grant '{"calls":[{"target":"0x4200000000000000000000000000000000000006","functionSignature":"transfer(address,uint256)"}],"spends":[{"token":"0x4200000000000000000000000000000000000006","allowance":"1000000000000000","unit":"week"}]}'`, approve. Pass: keys.jaw.id shows WETH, the weekly limit and the expiry, and the row reads `kind = custom`, `period = week`.
- grant-clamp: the grant above with `"expiresAt"` 90 days out. Pass: the result's `expiresAt` equals the connection's `expires_at`.
- grant-past: the grant above with `"expiresAt"` an hour ago, then ten minutes ahead. Pass: the answers start with `expiry_in_past:` and `expiry_too_soon:`, and no `url` is returned.
- grant-target: `grant` with a call whose `target` is the connected account, then `0x3232323232323232323232323232323232323232`. Pass: `call_target_refused:` each time, no `url`.
- grant-input: `grant '{"x402Budget":{"perDay":"1"},"calls":[...]}'`, then `grant '{"spends":[...]}'`. Pass: each is refused with no `url`.
- grant-cap: approve grants until the connection holds 5 live ones, then ask again. Pass: refused naming 5 live grants, no `url`.
- grant-one-open: ask, do not open the link, ask again. Pass: refused with the first `url`.
- grant-old-name: `call jaw_request_budget '{"perDay":"1"}'`. Pass: an unknown-tool error.
- Decline: open a link and reject in the wallet. Pass: no new `grants` row.

Not driven here: a wallet answer edited to differ in one spend (the relay is end to end encrypted, so it needs a test build; `grant-permissions.test.ts` covers it), and a chain read that fails or reads the permission revoked (`grants.test.ts`).
