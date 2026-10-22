# Hosted swap

`jaw_swap` and `jaw_swap_status` in `apps/mcp` swap or bridge the account's funds across chains. The server gets a quote with its own swap api key and checks it: an EVM destination from `/move-asset/quote`, which has no guard, and a Solana one from `/swap/quote`, which lets that key through without payment. The server asks only for the providers it signs for that pair (`providers`: every provider in `JAW_MCP_SWAP_PROVIDERS` for a same-asset pair, Aurora only for a cross-token one, and nothing at all for a cross-token pair when Aurora is switched off, which ends `quote_unsupported_provider` with no request) and shows the owner only a quote from an enabled provider that passes its checks. `JAW_MCP_SWAP_PROVIDERS` defaults to `aurora`. The connection needs `wallet:read` only and no budget. The account owner then approves the calls in the wallet, one batch on the origin chain, and pays its gas: one transfer to the Aurora deposit address, or an approve of exactly the amount and the deposit into the Across SpokePool or the Relay Depository (one native deposit when the origin token is native). The session key never signs the deposit.

## Sub-features

- `swap-key`: a connection with `wallet:read` only and no budget gets a quote, and nothing is paid.
- `swap-key-refused`: on a Solana destination, a key the backend does not list leaves the swap `quoting` with `backend_unavailable` and an error log line.
- `swap-move-asset`: an EVM destination quotes through `/move-asset/quote` and the Aurora quote runs the whole flow.
- `swap-solana`: a Solana destination quotes through `/swap/quote`.
- `swap-other-provider`: with the default `JAW_MCP_SWAP_PROVIDERS`, a quote Across or Relay answered ends `quote_rejected` with `quote_unsupported_provider` and no wallet prompt.
- `swap-across`, `swap-across-native`, `swap-relay`, `swap-relay-native`: an Across or Relay quote, ERC-20 or native, runs the whole flow, tracked by the provider's own key.
- `swap-providers`: the quote request names the providers the server signs for the pair.
- `swap-cross-token`: a cross-token pair is asked of Aurora only, so Across and Relay never answer it.
- `swap-kill-switch`: a provider left out of `JAW_MCP_SWAP_PROVIDERS` gets no new quote, and an unsent quote of it is declined when the owner opens the link.
- `swap-allowlist-drift`: a Relay quote naming a solver or router outside the pinned allowlist ends `quote_rejected` and logs a warning.
- `swap-provider-states`: each Across and Relay backend state, qualifier and broken answer moves the row as the tracking rules say.
- `swap-origin`: an origin chain outside JAW's list gives `unsupported_origin_chain` before any request to the backend.
- `swap-paused`: with payments paused, `jaw_swap` still quotes and `jaw_swap_status` keeps working.
- `swap-check-<mode>`: each way a quote can break the checks ends in `quote_rejected` with its code and no wallet link.
- `swap-happy`: quote, owner approval, deposit, then `jaw_swap_status` until `completed`.
- `swap-decline`: the owner rejects the deposit and the state is `owner_declined`.
- `swap-retry`: the same key twice answers from the row with one quote request.
- `swap-reopen`: the server restarts while `awaiting_owner` and the owner has not started; the same key gives a new link and no new quote.
- `swap-marker`: the wallet was asked to send and no calls id came back; the swap reads "may have sent", never reopens, and status resolves it from the backend. With a keys page that replays answers, a server that restarted rejoins the same tab and records the deposit's calls id from the owner's approval instead.
- `swap-restart`: the server restarts while `awaiting_owner`; status reads the backend afterwards.
- `swap-submit`: a failed submit leaves `deposit_sent`; the next status retries it.

## How to get to it (user POV)

- An MCP client on the hosted server with scope `wallet:read`. `jaw_swap` takes `originChainId`, `originToken` (zero address for the native coin), `destinationChainId`, `destinationToken`, `amount` in base units, and optionally `recipient` and `idempotencyKey`.
- The result of both tools holds `swapId`, `idempotencyKey`, `state`, `quoteId` (`aurora:<deposit address>`, `across:<id>` or `relay:<requestId>`), `approveBy`, the `provider`, the `calls` the owner approves (`kind`, `to`, `value`, in order), the `deposit` call and its `txHash` once known, the `backend` state, a `refusal` code and a `summary`; the quote body and backend text come back fenced in `response`. `url` is present only while `awaiting_owner` with no code on the row. `jaw_swap_status` takes the `quoteId`, needs `wallet:read` only, and reads the backend by the provider's key: the Aurora deposit address, the Relay `requestId`, or the Across origin chain and the `depositId` read from the deposit receipt. Across and Relay are read only once the owner sent the deposit. States: `quoting`, `quote_failed`, `quote_rejected`, `abandoned`, `awaiting_owner`, `owner_declined`, `expired`, `deposit_sent`, `submitted`, `completed`, `refunded`, `failed`.
- The person sees the summary: the account owner opens the `url`, the wallet asks for the account and then for one transfer of the amount to the deposit address, and the owner pays its gas in USDC or the chain's native coin.
- By hand: `node tools/verify/hosted-client.mjs "$MCP_PUBLIC_URL"`, then `swap <originChain> <originToken> <destChain> <destToken> <amount> [recipient|-] [key]` and `swap-status <quoteId>`.
- Allowlist against the live sources: `bun tools/verify/swap-allowlist.mts` diffs `apps/mcp/src/swap/allowlist.ts` against Across `deployed-addresses.json`, the AcrossEventEmitter files and Relay `/chains`, and exits 1 on any difference. It needs the network and is not part of the test suite.

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
- swap-move-asset: swap-happy with an EVM destination. Pass: every `quote` row in `seller.log` is on `/proxy/v2/move-asset/quote`, none on `/proxy/v2/swap/quote`, and reopen, status and submit add none.
- swap-solana: `swap 84532 <USDC> 792703809 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v <amount> <base58 recipient>`. Pass: `awaiting_owner`, one `quote` row on `/proxy/v2/swap/quote` with `"by":"api-key"`, no `payment` row.
- swap-other-provider: `mode=across-prod&filter=off`, then `swap`; again with `mode=relay-prod&filter=off`. `filter=off` is a backend that ignores `providers`, so the stub answers the provider the server did not ask for. Pass: `quote_rejected` with `quote_unsupported_provider`, a summary naming the provider, no `url`, no `response` and none of the quote's calldata in the output, the `swaps` row with no `call`, and no wallet prompt.
- swap-key-refused: restart the mcp container with `JAW_MCP_SWAP_API_KEY=not-listed`, then `swap` to a Solana destination as in swap-solana. Pass: `quoting` with `backend_unavailable`, one `challenge` row in `seller.log`, no `payment` row, and the container log line `swap backend refused the swap api key`. Restart with the default key and send the same key: `awaiting_owner`. Recreate `seller-forward` with the mcp container (`docker compose ... up -d --force-recreate mcp seller-forward`): it shares the mcp container's network, so after recreating mcp alone the quote fails with `swap quote unreachable` and never reaches the stub.
- swap-origin: `swap` with an origin chain outside JAW's list. Pass: `unsupported_origin_chain`, no request in `seller.log`.
- swap-paused: set `payments_paused` with psql, then `swap`: `awaiting_owner`, as the quote is not paid.
- swap-check-<mode>: one drive per mode (`two-tx`, `no-tx`, `wrong-chain`, `quote-id`, `provider`, `deposit-field`, `tx-to`, `tx-value`, `tx-data`, `trailing-bytes`, `input-amount`, `output-amount`, `zero-min`, `deposit-self`, `reused`). Pass: `quote_rejected` with the mode's code, one `quote` row, no `url`. `quote-id` and `provider` name Relay, so with the default `JAW_MCP_SWAP_PROVIDERS` their code is `quote_unsupported_provider`; with Relay enabled the quote goes on to the checks, and `quote-id` ends `quote_id`.
- swap-happy: `swap`, open the `url` as the owner and approve, then `swap-status <quoteId>` repeatedly. The stub walks `PENDING_DEPOSIT`, `PROCESSING`, `SUCCESS`. Pass: `completed`, a `submit` row in `seller.log`, a `swaps` row in `completed`, and the Sepolia receipt of the transfer to the deposit address.
- swap-decline: reject in the wallet. Pass: `owner_declined`, no `txHash`.
- swap-retry: `swap` twice with the same key while the link is live. Pass: same `swapId`, `quoteId` and `url`, one `quote` row.
- swap-reopen: `swap`, do not open the link, restart the mcp container, then `swap` again with the same key. Pass: the same `swapId` and `quoteId`, a different `url`, state `awaiting_owner`, and one `quote` row in `seller.log`. Approve through the new link and follow with `swap-status` to `completed`.
- swap-marker: `swap`, open the `url` as the owner and let the wallet reach the transfer prompt without approving, then restart the mcp container. This is the same row an answer with no calls id leaves: the marker `send_started` is written before the wallet is asked to send. Pass: `swap` with the same key answers `awaiting_owner` with no `url` and a summary saying the wallet may have sent the deposit, no new link and no new quote. Then `state=PROCESSING&depositAddress=<deposit address>` on the stub and `swap-status <quoteId>`: the row becomes `submitted` with the marker cleared, resolved from the seller's status route by deposit address alone. Without that switch, `swap-status` stays `awaiting_owner` and says to call it again, and after 10 minutes past `approveBy` (wait with `$S/run-bounded.sh`) it says the backend has not seen a deposit and the owner's account must be checked before swapping these funds again.
- swap-restart: restart the mcp container while `awaiting_owner`, wait past `approveBy` with `$S/run-bounded.sh`, then `swap-status`: `expired`. Set `state=PROCESSING` on the stub and run `swap-status` again: the row adopts the deposit.
- swap-submit: `submitFails=1`, approve. The server posts the deposit itself, the stub answers 500, and the swap stays `deposit_sent` with a `submit` row in `seller.log`. The first `swap-status` retries the submit while the backend says `PENDING_DEPOSIT`; when it succeeds the state is `submitted`. Pass: `submit` rows for each attempt, the final state `submitted`, and `submitAttempts` of 2 in the `swaps` row. Use `submitFails=2` to see two `swap-status` reads before it clears.

### Across and Relay

Run these on a stack started with `JAW_MCP_SWAP_PROVIDERS=aurora,across,relay` unless the drive says otherwise (`compose.yaml` passes it to the mcp container; restart it with `docker compose ... up -d --force-recreate mcp seller-forward`, both, as in swap-key-refused). Run `bun $S/swap-allowlist.mts > "$RUN/evidence/allowlist.txt"` first: the stub builds its quotes from `apps/mcp/src/swap/allowlist.ts`, so a drifted allowlist would pass here and fail in production. USDC below is Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e` and Sepolia `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`; `0x0` is the zero address. The stub's quotes are real calldata for the testnet contracts, so an approved deposit moves real testnet funds into the Across SpokePool or the Relay Depository; no relayer or solver is told about the stub's quote, so expect the funds to stay there or come back as a refund. Keep amounts small. Send the approval link alone and right away: the owner window is 240 s.

- swap-across: `mode=across`, then `swap 84532 <USDC> 11155111 <USDC> 1000000`. Before approving, `swap-status <quoteId>` twice. Then open the `url` as the owner, approve, and `swap-status` until it stops changing. Pass: `awaiting_owner` with `provider` `across` and `calls` `[approve to the USDC token, deposit to the SpokePool 0x82B564983aE7274c86695917BBf8C99ECb6F0F8F]`; the `quote` row has `"provider":"across"` and `"providers":"aurora,across,relay"`; no `status` or `submit` row before the approval; the wallet shows two calls in one batch; one Base Sepolia receipt holds the approve of exactly `1000000` and the SpokePool `FundsDeposited` log; the `swaps` row's `call` has two elements and its approve data is `approve(SpokePool, 1000000)`, not the quote's `2^256-1`; then a `submit` row with `"provider":"across"`, `originChainId` 84532 and the `depositId` of that log (`cast receipt <txHash> --rpc-url https://sepolia.base.org`), `status` rows by the same pair, and the row `completed`. `cast call <USDC> "allowance(address,address)(uint256)" <account> 0x82B5...0F8F` after the receipt answers 0.
- swap-across-native: `mode=across`, then `swap 84532 0x0 11155111 0x0 1000000000000000`. Pass: as swap-across, with `calls` one `deposit` to the SpokePoolPeriphery `0x10D8b8DaA26d307489803e10477De69C0492B610` whose `value` is the amount, a one-element `call`, and no allowance to check.
- swap-relay: `mode=relay`, then `swap 84532 <USDC> 11155111 <USDC> 1000000`. Pass: as swap-across, with `calls` `[approve to the USDC token, deposit to the Depository 0x5Feab8dB4534F9F7E2669Bb260c57a01aD1c12e3]`, the approve of exactly the amount to the Depository, the stored `quote.orderId` equal to the `id` the deposit calldata carries, and `submit` and `status` rows with `"provider":"relay"` and the `requestId` of the quote id (lowercased); submit also carries `originChainId` 84532.
- swap-relay-native: `mode=relay`, then `swap 84532 0x0 11155111 0x0 1000000000000000`. Pass: as swap-relay, with one `depositNative` to the Depository whose `value` is the amount.
- swap-providers: with the default stub, `swap 84532 <USDC> 11155111 <USDC> 1000000` and, from a fresh connection, `swap 84532 <USDC> 11155111 0x0 1000000`. Pass: the first `quote` row has `"providers":"aurora,across,relay"`, the second `"providers":"aurora"`; both answer Aurora (`mode` empty) and end `awaiting_owner`.
- swap-cross-token: `mode=across`, then `swap 84532 <USDC> 11155111 0x0 1000000`. Pass: one `quote` row with `"providers":"aurora"` and `"provider":"aurora"`, the swap `awaiting_owner` with `provider` `aurora` and one transfer call. Then `mode=across&filter=off` and the same swap from a fresh connection: `quote_rejected` with `route_unsupported`, no `url`, one `quote` row with `"provider":"across"`, and a summary saying the route cannot be verified from calldata and to try the same token on both chains.
- swap-kill-switch: on a stack with the default `JAW_MCP_SWAP_PROVIDERS` (`aurora`), `mode=across`, then `swap 84532 <USDC> 11155111 <USDC> 1000000`. Pass: the `quote` row has `"providers":"aurora"` and `"provider":"aurora"`, and the swap is an Aurora swap. Then `mode=across&filter=off` and swap again from a fresh connection: `quote_rejected` with `quote_unsupported_provider`, a summary saying the quote came from across and this server does not sign across quotes now, no `url`, no `call` in the row. Last, needs the owner: restart with `aurora,across,relay`, `mode=across`, `swap` (do not open the link), restart with `aurora`, then open the `url` as the owner. Pass: the row ends `owner_declined` with code `provider_disabled`, the wallet is asked nothing, not even for the account, no `send_started` marker is written, and `swap` with the same key says this server stopped signing Across quotes after this one was given.
- swap-allowlist-drift: `mode=relay-solver`, then `swap 84532 <USDC> 11155111 <USDC> 1000000`; again from a fresh connection with `mode=relay-router`. Pass: `quote_rejected` with `solver_unknown`, then `router_mismatch`, one `quote` row each, no `url`, and an mcp container log line `swap quote refused on allowlist drift` with `provider` `relay`, both chain ids and the code, and no address or calldata in it.
- swap-check-prod: all providers enabled, `mode=across-prod`, `swap 84532 <USDC> 11155111 <USDC> 10000000`; `mode=relay-prod`, `swap 84532 0x0 11155111 0x0 10000000000000000`. Pass: `quote_rejected` with `tx_chain`, then `order_missing` (mainnet calldata, and a Relay quote without order data).
- swap-provider-states: after swap-across or swap-relay is approved and `submitted`, pin each answer with `state` and `rawState` and read `swap-status` once per pin. Pass: `PROCESSING` with `rawState=no_tx` or `rawState=failure` keeps the row `submitted`; Across `PROCESSING` with `rawState=expired` keeps it `submitted` and the summary says Across refunds the deposit on the origin chain; `SUCCESS` with `rawState=actions_failed` ends `completed` with the qualifier fenced in `response`; `REFUNDED` ends `refunded` (run it on a second swap). `deposit=echo` and `deposit=foreign-hash` each answer `invalid_response` and leave the row unchanged. Set `deposit=unknown` before approving a third swap: after the approval the row stays `deposit_sent` and `submitAttempts` grows on each Relay `swap-status`, while Across makes one `status` call per read and no new `submit`. Set `state=SUCCESS&deposit=foreign-hash` before approving a Relay swap, then `swap-status`: no `status` row, the row stays `awaiting_owner`, and the approval still records its calls id.

These drives need a person with the passkey for the owner step, except swap-providers, swap-cross-token, the quote half of swap-kill-switch, swap-allowlist-drift and swap-check-prod. Without one, the same flows run in the vitest driver of `evidence/m8` (rows inserted and followed against the stub over HTTP); a stub-only `completed` without the receipt is not a pass of swap-across or swap-relay.

### Live testnet leg

Manual, once the backend's provider filter, Relay order data and the Across and Relay trackers run on a test deployment or locally per the backend spec. Point `JAW_MCP_SWAP_URL` at that proxy (Across `https://testnet.across.to/api`, Relay `https://api.testnets.relay.link`), set `JAW_MCP_SWAP_PROVIDERS=aurora,across,relay`, and give the server a swap api key the proxy lists.

1. Swap 0.001 ETH from Base Sepolia to Sepolia (`swap 84532 0x0 11155111 0x0 1000000000000000`) once with Across and once with Relay; with both enabled the proxy answers whichever quotes first, so restart with `aurora,across` or `aurora,relay` to pick one.
2. Swap testnet USDC the same way where the provider quotes it (Relay's testnet API refuses USDC on these chains today, `UNSUPPORTED_CURRENCY`).
3. Approve each in the wallet and follow `swap-status` to `completed`.

Evidence: the quotes, the origin receipts, the Across `depositId` read from the receipt, the Relay `requestId`, the backend states seen on each read, and the destination fill.

`awaiting_owner`, `deposit_sent`, `submitted`, `completed`. A drive that does not reach one of them for lack of the owner step is not counted as passing it.

Not driven here: `quote_reused` (the stub gives every Across and Relay quote a new id), `output_floor` (the stub has no floor tamper), the 240 s owner window expiring without a restart, concurrent claims, and a wallet that answers the account request with an error code (the row keeps a `wallet_error:<n>` code, shows no `url`, and the same key opens a new link). Unit tests and the Postgres tests cover them.

## Risks

- The deposit moves the owner's funds outside any budget. A session key must never sign it, and a link must not open again once the wallet was asked to send: a row with the `send_started` marker never reopens, and an unmarked one reopens only when no session for it is live in the process, with no new quote.
- The quote body is untrusted input to a signing screen. The call shown to the owner must equal the `transfer` of the amount to the deposit address, byte for byte.
- A restart or a retry must never ask a second quote for a swap that holds one, and a marked swap must never be abandoned as unsent. Check the marker survives and that status, not a new swap, settles it.
- Nothing pays for a quote. Check `seller.log` has no `payment` row on `/proxy/v2/swap/quote` or `/proxy/v2/move-asset/quote` and the `payments` table has no row for the connection. `/move-asset/quote` has no guard, so a quote there does not prove the key is listed; swap-key-refused runs on a Solana destination for that.
- `/move-asset/quote` answers whichever allowed provider quotes first. With `providers` the server never gets a provider it does not sign; a backend that ignores `providers` can still answer one, which ends `quote_unsupported_provider` (disabled) or `route_unsupported` (cross-token).
- The swap api key goes in the `x-api-key` header only, never in the URL or a log line.
- The stub answers quotes with a fresh random deposit address, takes a Solana destination on `/swap/quote` only, and builds Across and Relay quotes from the server's own allowlist and the live quotes' prices. It proves the tool's flow, not the providers' behavior: whether Across and Relay still answer these shapes is the live testnet leg's job, and whether the allowlist matches the providers is `swap-allowlist.mts`'s.

## What counts as evidence

- Quote `REV` and `TREE` from `evidence/run.env` and the `head:` line from `up.sh` with every result.
- Each drive saves the tool output, the matching `seller.log` rows and, where the pass condition names one, the `swaps` rows, under `$RUN/evidence/<drive name>`.
- A refusal drive passes only when `seller.log` shows the request count it names. A refusal text alone is not evidence that nothing was asked.
- The happy path needs the owner's approval and a receipt for the deposit transfer. A stub-only `completed` without the receipt is not a pass.

## Manual mainnet check

Separate from the testnet lanes and run by a person. Needs a Base mainnet connection with `wallet:read`, `JAW_MCP_SWAP_URL` unset (the production backend), `JAW_MCP_SWAP_API_KEY` set to a key the production proxy lists in `X402_ALLOWED_API_KEYS`, and USDC on both chains.

Across and Relay are added to the production `JAW_MCP_SWAP_PROVIDERS` only after this check passes for them; run steps 1 to 4 with Aurora (default config), then one Across and one Relay swap of 1 USDC (step 5).

1. Swap 1 USDC from Base to Arbitrum USDC (`swap 8453 <USDC on Base> 42161 <USDC on Arbitrum> 1000000`), origin equal to the connection chain.
2. Swap 1 USDC from Arbitrum to Base (`swap 42161 <USDC on Arbitrum> 8453 <USDC on Base> 1000000`), origin different from the connection chain.
3. In each, open the `url` and check that the wallet dialog offers USDC as the fee token for the origin chain, on Base and on Arbitrum, and approve once paying gas in USDC. Repeat one swap paying in the native coin.
4. Run `swap-status <quoteId>` until the backend reaches `SUCCESS` and the row is `completed`.
5. On a server with `JAW_MCP_SWAP_PROVIDERS=aurora,across` swap 1 USDC from Base to Arbitrum, then with `aurora,relay` the same. Check before approving that the wallet shows an approve of exactly 1000000 to the Across SpokePool `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64` or the Relay Depository `0x4cd00e387622c35bddb9b4c962c136462338bc31` and the deposit, in one batch, and follow `swap-status` to `completed`.

Evidence: the quote with no payment row, the origin receipt, the destination credit, the backend `SUCCESS`, and a screenshot of each fee picker; for step 5 also the batch in the wallet, the allowance read back as 0 after the receipt, and the Across `depositId` or Relay `requestId` the status was read by.

## Gotchas

- `compose.yaml` points `JAW_MCP_SWAP_URL` at `http://localhost:$PORT/proxy/v2`, which the `seller-forward` service carries to the seller. Do not override it with `host.docker.internal:$PORT`: the quote then ends `insecure_url`, because the server fetches over plain http only for localhost.
- One swap is open per connection. A second key while one is `quoting` or `awaiting_owner` gets `swap_in_progress`.
- `expired` is not final; status keeps reading the backend because a deposit signed in time can land late.
- Postgres runs on tmpfs; dump the `swaps` rows into `evidence/` before `down.sh`.
