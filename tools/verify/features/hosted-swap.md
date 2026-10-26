# Hosted swap

`jaw_swap` and `jaw_swap_status` in `apps/mcp` swap or bridge the account's funds across chains. The server gets a quote from `/move-asset/quote` with its own swap api key, asking Across and Relay. Both chains must be ones JAW serves, and the quote must run on the origin chain, spend the amount asked and, when it has an approve, approve the origin token to the deposit contract; the server checks nothing else in it. The connection needs `wallet:read` only and no budget. The account owner then approves those transactions, a token approval and the deposit, in one batch in the wallet and pays its gas. The session key never signs the deposit.

## Sub-features

- `swap-key`: a connection with `wallet:read` only and no budget gets a quote, and nothing is paid.
- `swap-origin`: an origin chain outside JAW's list gives `unsupported_origin_chain` before any request to the backend.
- `swap-destination`: a destination chain outside JAW's list, Solana included, gives `unsupported_destination_chain` before any request to the backend.
- `swap-paused`: with payments paused, `jaw_swap` still quotes and `jaw_swap_status` keeps working.
- `swap-check-<mode>`: a quote the server cannot turn into calls ends in `quote_rejected` with its code and no wallet link.
- `swap-happy`: quote, owner approval, deposit, then `jaw_swap_status` until `completed`.
- `swap-decline`: the owner rejects the deposit and the state is `owner_declined`.
- `swap-retry`: the same key twice answers from the row with one quote request.
- `swap-reopen`: the server restarts while `awaiting_owner` and the owner has not started; the same key gives a new link and no new quote.
- `swap-marker`: the wallet was asked to send and no calls id came back; the swap reads "may have sent", never reopens, and status resolves it from the backend. With a keys page that replays answers, a server that restarted rejoins the same tab and records the deposit's calls id from the owner's approval instead.
- `swap-restart`: the server restarts while `awaiting_owner`; status reads the backend afterwards.
- `swap-submit`: a failed submit leaves `deposit_sent`; the next status retries it.

## How to get to it (user POV)

- An MCP client on the hosted server with scope `wallet:read`. `jaw_swap` takes `originChainId`, `originToken` (zero address for the native coin), `destinationChainId`, `destinationToken`, `amount` in base units, and optionally `recipient` and `idempotencyKey`.
- The result of both tools holds `swapId`, `idempotencyKey`, `state`, `quoteId` (`across:<id>`, `relay:<request id>`, or `aurora:<deposit address>` on older rows), `approveBy`, the `provider`, the `calls` the owner approves (`kind`, `to`, `value`, in order), the `deposit` call and its `txHash` once known, the `backend` state, a `refusal` code and a `summary`; the quote body and backend text come back fenced in `response`. `url` is present only while `awaiting_owner` with no code on the row. `jaw_swap_status` takes the `quoteId`, needs `wallet:read` only, and reads the backend by the provider's key: the Relay request id in the `quoteId`, the Across `depositId` from the account's `FundsDeposited` log in the deposit receipt, or the deposit address of an older Aurora row. States: `quoting`, `quote_failed`, `quote_rejected`, `abandoned`, `awaiting_owner`, `owner_declined`, `expired`, `deposit_sent`, `submitted`, `completed`, `refunded`, `failed`.
- The person sees the summary: the account owner opens the `url`, the wallet asks for the account and then for one transfer of the amount to Relay's depository, and the owner pays its gas in USDC or the chain's native coin.
- By hand: `node tools/verify/hosted-client.mjs "$MCP_PUBLIC_URL"`, then `swap <originChain> <originToken> <destChain> <destToken> <amount> [recipient|-] [key]` and `swap-status <quoteId>`.

## Driving it

Preconditions: baseline preconditions of this map; Docker running; `JAW_KEYS_URL` set to a keys app the owner can reach, since the owner step opens its link. The default `JAW_MCP_CHAIN_ID` (84532) matches the seller's quote network, so no swap-specific chain setting is needed.

```bash
S=tools/verify
RUN=$($S/up.sh | tail -1)
$S/doctor.sh "$RUN"
. "$RUN/run.env"
JAW_KEYS_URL=https://keys.jaw.id $S/hosted-up.sh "$RUN"
node $S/hosted-client.mjs "$MCP_PUBLIC_URL"
```

Control the stub with `curl -s -X POST "$SELLER/_swap?<switch>"` (switches in ../README.md, "Swap backend stub") and reset it with a JSON body of `{"reset":true}`. Run each drive from a fresh connection unless it says otherwise.

- swap-key: connect with `wallet:read` only and no budget, then `swap`. Pass: `awaiting_owner` with a `url`, one `quote` row on `/proxy/v2/move-asset/quote` in `seller.log`, no `challenge` or `payment` row, and no `payments` row for the connection.
- swap-origin: `swap` with an origin chain outside JAW's list. Pass: `unsupported_origin_chain`, no request in `seller.log`.
- swap-destination: `swap 84532 <USDC> 792703809 <hex token> <amount>`. Pass: `unsupported_destination_chain`, no request in `seller.log`.
- swap-paused: set `payments_paused` with psql, then `swap`: `awaiting_owner`, as the quote is not paid.
- swap-check-<mode>: one drive per mode: `no-tx` and `two-tx` give `tx_calls`, `wrong-chain` gives `tx_chain`, `quote-id` and `provider` give `quote_id`, and `reused` gives `quote_reused`. Pass: `quote_rejected` with that code, one `quote` row, no `url`.
- swap-happy: `swap`, open the `url` as the owner and approve, then `swap-status <quoteId>` repeatedly. The stub walks `PENDING_DEPOSIT`, `PROCESSING`, `SUCCESS`. Pass: `completed`, a `submit` row in `seller.log`, a `swaps` row in `completed`, and the Sepolia receipt of the transfer to the depository.
- swap-decline: reject in the wallet. Pass: `owner_declined`, no `txHash`.
- swap-retry: `swap` twice with the same key while the link is live. Pass: same `swapId`, `quoteId` and `url`, one `quote` row.
- swap-reopen: `swap`, do not open the link, restart the mcp container, then `swap` again with the same key. Pass: the same `swapId` and `quoteId`, a different `url`, state `awaiting_owner`, and one `quote` row in `seller.log`. Approve through the new link and follow with `swap-status` to `completed`.
- swap-marker: `swap`, open the `url` as the owner and let the wallet reach the transfer prompt without approving, then restart the mcp container. This is the same row an answer with no calls id leaves: the marker `send_started` is written before the wallet is asked to send. Pass: `swap` with the same key answers `awaiting_owner` with no `url` and a summary saying the wallet may have sent the deposit, no new link and no new quote. Then `state=PROCESSING&requestId=<request id>` on the stub and `swap-status <quoteId>`: the row becomes `submitted` with the marker cleared, resolved from the seller's status route by request id alone. Without that switch, `swap-status` stays `awaiting_owner` and says to call it again, and after 10 minutes past `approveBy` (wait with `$S/run-bounded.sh`) it says the backend has not seen a deposit and the owner's account must be checked before swapping these funds again.
- swap-restart: restart the mcp container while `awaiting_owner`, wait past `approveBy` with `$S/run-bounded.sh`, then `swap-status`: `expired`, and no `status` row in `seller.log`, since a Relay row the wallet was never asked to send is not read.
- swap-submit: `submitFails=1`, approve. The server posts the deposit itself, the stub answers 502, and the swap stays `deposit_sent` with a `submit` row in `seller.log`. The first `swap-status` retries the submit while the backend says `PENDING_DEPOSIT`; when it succeeds the state is `submitted`. Pass: `submit` rows for each attempt, the final state `submitted`, and `submitAttempts` of 2 in the `swaps` row. Use `submitFails=2` to see two `swap-status` reads before it clears.

A run shows these states across its drives: `awaiting_owner`, `deposit_sent`, `submitted`, `completed`. A drive that does not reach one of them for lack of the owner step is not counted as passing it.

Not driven here: following an Across deposit (the stub's deposit routes answer Relay and Aurora only), a swap api key the backend refuses (`/move-asset/quote` on the stub has no guard), the 240 s owner window expiring without a restart, concurrent claims, and a wallet that answers the account request with an error code (the row keeps a `wallet_error:<n>` code, shows no `url`, and the same key opens a new link). Unit tests and the Postgres tests cover them.

## Risks

- The deposit moves the owner's funds outside any budget. A session key must never sign it, and a link must not open again once the wallet was asked to send: a row with the `send_started` marker never reopens, and an unmarked one reopens only when no session for it is live in the process, with no new quote.
- Past those bindings, the server trusts the backend's quote. The calls sent to the wallet must equal the quote's transactions, byte for byte and in order.
- A restart or a retry must never ask a second quote for a swap that holds one, and a marked swap must never be abandoned as unsent. Check the marker survives and that status, not a new swap, settles it.
- Nothing pays for a quote. Check `seller.log` has no `payment` row and the `payments` table has no row for the connection.
- The swap api key goes in the `x-api-key` header only, never in the URL or a log line.
- The stub is EVM-only, answers quotes with a fresh random request id, and answers Across and Relay with quotes captured from prod. It proves the tool's flow, not the providers' behavior.

## What counts as evidence

- Quote `REV` and `TREE` from `evidence/run.env` and the `head:` line from `up.sh` with every result.
- Each drive saves the tool output, the matching `seller.log` rows and, where the pass condition names one, the `swaps` rows, under `$RUN/evidence/<drive name>`.
- A refusal drive passes only when `seller.log` shows the request count it names. A refusal text alone is not evidence that nothing was asked.
- The happy path needs the owner's approval and a receipt for the deposit transfer. A stub-only `completed` without the receipt is not a pass.

## Manual mainnet check

Separate from the testnet lanes and run by a person. Needs a Base mainnet connection with `wallet:read`, `JAW_MCP_SWAP_URL` unset (the production backend), `JAW_MCP_SWAP_API_KEY` set to a key the production proxy lists in `X402_ALLOWED_API_KEYS`, and USDC on both chains.

1. Swap 1 USDC from Base to Arbitrum USDC (`swap 8453 <USDC on Base> 42161 <USDC on Arbitrum> 1000000`), origin equal to the connection chain.
2. Swap 1 USDC from Arbitrum to Base (`swap 42161 <USDC on Arbitrum> 8453 <USDC on Base> 1000000`), origin different from the connection chain.
3. In each, open the `url` and check that the wallet dialog offers USDC as the fee token for the origin chain, on Base and on Arbitrum, and approve once paying gas in USDC. Repeat one swap paying in the native coin.
4. Run `swap-status <quoteId>` until the backend reaches `SUCCESS` and the row is `completed`.

Evidence: the quote with no payment row, the origin receipt, the destination credit, the backend `SUCCESS`, and a screenshot of each fee picker.

## Gotchas

- `compose.yaml` points `JAW_MCP_SWAP_URL` at `http://localhost:$PORT/proxy/v2`, which the `seller-forward` service carries to the seller. Do not override it with `host.docker.internal:$PORT`: the quote then ends `insecure_url`, because the server fetches over plain http only for localhost.
- One swap is open per connection. A second key while one is `quoting` or `awaiting_owner` gets `swap_in_progress`.
- `expired` with the `send_started` marker is not final; status keeps reading the backend because a deposit signed in time can land late. A Relay row that expired without the marker was never sent and is not read.
- Postgres runs on tmpfs; dump the `swaps` rows into `evidence/` before `down.sh`.
