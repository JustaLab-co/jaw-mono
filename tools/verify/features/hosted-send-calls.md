# Hosted send calls

`jaw_send_calls` and `jaw_send_calls_status` in `apps/mcp` ask the account owner to approve up to 10 contract calls, run together from the account on one chain. The owner reviews and signs them in the wallet and pays the gas. Nothing comes out of the connection's USDC budget, and the session key never signs them. Both tools need `wallet:read` only.

## Sub-features

- `calls-read-only`: a connection with only `wallet:read` and no budget gets a wallet link.
- `calls-chain`: a chain the JAW wallet does not support gives `unsupported_chain` before any row or link.
- `calls-target`: a call to the account itself, the permission manager or the EntryPoint gives `call_target_refused` before any row or link.
- `calls-paused`: with payments paused, a new `jaw_send_calls` is refused as `payments_paused` with no link, and `jaw_send_calls_status` keeps working.
- `calls-happy`: link, owner approval, `sent` with a calls id, then `jaw_send_calls_status` until `landed` with a `txHash`.
- `calls-decline`: the owner rejects the calls in the wallet and the state is `owner_declined`.
- `calls-wrong-account`: the owner signs in with another account than the connection's; the state is `owner_declined` with code `wrong_account`.
- `calls-retry`: the same key and input twice while the link is live answer the same `id` and `url`.
- `calls-conflict`: the same key with different calls gives `idempotency_conflict`.
- `calls-one-open`: a second key while a request is `awaiting_owner` gives `calls_in_progress` naming the open request and its key.
- `calls-reopen`: the server restarts while `awaiting_owner` and the owner has not started; the same key gives a new link.
- `calls-marker`: the wallet was asked to send and no calls id came back; the request reads "may have sent" and never reopens.
- `calls-expired`: the owner does not approve before `approveBy`; the state is `expired`.

## How to get to it (user POV)

- An MCP client on the hosted server with any scope set; `wallet:read` is enough. `jaw_send_calls` takes `calls`, an array of 1 to 10 `{ to, data?, value? }` (`data` is hex calldata starting with the selector, omitted for a plain native transfer; `value` is wei as a decimal string, default 0), and optionally `chainId` (defaults to the connection's chain) and `idempotencyKey` (made up and returned when absent). `jaw_send_calls_status` takes the `id` (`oc_` and 22 characters) that `jaw_send_calls` returned.
- The result of both tools holds `id`, `idempotencyKey`, `state`, `approveBy`, `chainId`, `from`, each call as `to`, `value` and `selector`, `totalValue` in wei, `callsId` and `txHash` once known, a `refusal` code and a `summary`. `url` is present only while `awaiting_owner` with no code on the row. States: `awaiting_owner`, `owner_declined`, `expired`, `sent`, `landed`, `reverted`.
- The person sees the summary: the account owner opens the `url` within 10 minutes, the wallet asks for the account and then shows the calls as one atomic `wallet_sendCalls`, and the owner pays the gas in the wallet.
- By hand: `node tools/verify/hosted-client.mjs "$MCP_PUBLIC_URL" [scope]`, then `calls '<json array>' [chainId] [key]` and `calls-status <id>`.

## Driving it

Preconditions: baseline preconditions of this map; Docker running; `JAW_KEYS_URL` set to a keys app the owner can reach, since the owner step opens its link. The owner's account on the connection's chain (84532 by default) needs whatever the calls move, and the wallet must be able to pay the gas.

```bash
S=tools/verify
RUN=$($S/up.sh | tail -1)
$S/doctor.sh "$RUN"
. "$RUN/run.env"
JAW_KEYS_URL=https://keys.jaw.id $S/hosted-up.sh "$RUN"
node $S/hosted-client.mjs "$MCP_PUBLIC_URL" wallet:read
```

A call that moves something visible on Base Sepolia is a USDC transfer of 0.01 to an address you control: `cast calldata 'transfer(address,uint256)' <to> 10000` gives the `data`, and the `to` is Base Sepolia USDC, `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Use it as `calls '[{"to":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","data":"<data>"}]'` below. Dump the `owner_calls` rows with psql in the postgres container after each drive.

- calls-read-only: connect with `wallet:read` only; the connect page asks for no budget. Then `calls`. Pass: `awaiting_owner` with a `url`, `refusal` absent, and no `grants` row for the connection.
- calls-chain: `calls '<json>' 1234567`. Pass: `unsupported_chain`, no `owner_calls` row.
- calls-target: `calls` with `to` set to the connected account, then to the permission manager, then to `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` (EntryPoint 0.8). Pass: `call_target_refused` each time, no `owner_calls` row.
- calls-paused: set `payments_paused` with psql, then `calls` with a new key: `payments_paused`, no row. `calls-status` on an earlier id still answers.
- calls-happy: `calls`, open the `url` as the owner and approve, then `calls-status <id>` until it changes. Pass: `sent` with a `callsId`, then `landed` with a `txHash`, and the Base Sepolia receipt of that transaction shows the USDC transfer from the account.
- calls-decline: reject in the wallet, then `calls-status <id>`. Pass: `owner_declined`, no `callsId`, the summary says nothing was sent.
- calls-wrong-account: open the `url` and sign in with another passkey account. Pass: `owner_declined` with `refusal.code` `wrong_account`, and the wallet was never asked to send.
- calls-retry: `calls '<json>' 84532 k1` twice while the link is live. Pass: the same `id` and `url`, one `owner_calls` row.
- calls-conflict: `calls` with key `k1` again and a different `data`. Pass: `idempotency_conflict`, still one row.
- calls-one-open: while `k1` is `awaiting_owner`, `calls '<json>' 84532 k2`. Pass: `calls_in_progress` naming the `k1` request and key, no new row.
- calls-reopen: `calls`, do not open the link, restart the mcp container, then `calls` again with the same key. Pass: the same `id`, a different `url`, state `awaiting_owner`, one row. Approve through the new link and follow with `calls-status` to `landed`.
- calls-marker: `calls`, open the `url` as the owner and let the wallet reach the calls prompt without approving, then restart the mcp container. The row now carries the code `send_started`, written before the wallet is asked to send. Pass: `calls` with the same key answers `awaiting_owner` with no `url` and a summary saying the wallet may have sent these calls, and `calls-status` says the same. After 10 minutes past `approveBy` (wait with `$S/run-bounded.sh`) the summary says nothing was seen and the account must be checked before sending again.
- calls-expired: `calls`, do not open the link, wait past `approveBy` with `$S/run-bounded.sh`, then `calls-status <id>`. Pass: `expired`, no `url`, and `calls` with the same key answers the same `expired` row without a new link.

A run shows these states across its drives: `awaiting_owner`, `sent`, `landed`, `owner_declined`, `expired`. A drive that does not reach one of them for lack of the owner step is not counted as passing it.

Not driven here: `reverted` (the wallet usually refuses a batch that fails its simulation, so a revert on chain is hard to force by hand), the 10 links and 30 status reads a minute per connection (`rate_limited`), a full owner pool (`wallet_busy`), a connection ended while its request waits (`connection_ended`), a wallet that answers the account request with an error code (the row keeps a `wallet_error:<n>` code, shows no `url`, and the same key opens a new link), and a receipt read that fails (the answer is the stored row with a note that the chain could not be read). Unit tests and the Postgres tests cover them.

## Risks

- The owner's review is the only check on the calldata. The calls the wallet shows must equal the stored calls byte for byte, in order, with the stored values; compare the `owner_calls` row with what the wallet displayed.
- A session key must never sign these calls, and nothing may come out of the budget. A connection with no budget must still get its link, and the payer's balance and the budget's `spentToday` must not move after a landed request.
- A link must not open again once the wallet was asked to send: a row with the `send_started` marker never reopens, and an unmarked one reopens only when no session for it is live in the process.
- A retry must never ask the owner twice. Compare the `owner_calls` rows with the number of `calls` commands.
- The refused targets are the only server-side check on where calls go. The account, the permission manager and the EntryPoint must be refused before a row is written, whatever the case of the address.

## What counts as evidence

- Quote `REV` and `TREE` from `evidence/run.env` and the `head:` line from `up.sh` with every result.
- Each drive saves the tool output and the `owner_calls` rows under `$RUN/evidence/<drive name>`.
- A refusal drive passes only when the row count it names holds. A refusal text alone is not evidence that no link opened.
- The happy path needs the owner's approval and a receipt for the transaction. A `sent` state alone is not a pass.

## Gotchas

- The hosted client connects with all three scopes unless a scope is passed after the URL; pass `wallet:read` to check that no budget is needed.
- One request is open per connection. Wait for it to end, decline it, or let it expire before trying a new key.
- `expired` is not final for a request the wallet already took: if the wallet returns a calls id after `approveBy`, the row moves to `sent`.
- The owner window is 10 minutes, the same as a budget request.
- Postgres runs on tmpfs; dump the `owner_calls` rows into `evidence/` before `down.sh`.
