# Hosted swap

`jaw_swap` and `jaw_swap_status` in `apps/mcp` swap or bridge the account's funds across chains. The server pays a 0.005 USDC quote from the connection's budget and checks it. The account owner then approves the one deposit transaction in the wallet and pays its gas. The session key never signs the deposit.

## Sub-features

- `swap-chain`: a quote advertised on another network than the connection's is refused as `wrong_chain` before anything is signed.
- `swap-budget`: a budget below the quote price gives `budget_exhausted`; a larger budget and the same key pays on a new attempt.
- `swap-origin`: an origin chain outside JAW's list gives `unsupported_origin_chain` before any request to the backend.
- `swap-paused`: with payments paused, `jaw_swap` is refused and `jaw_swap_status` keeps working.
- `swap-check-<mode>`: each way a quote can break the checks ends in `quote_rejected` with its code and no wallet link.
- `swap-happy`: quote, owner approval, deposit, then `jaw_swap_status` until `completed`.
- `swap-decline`: the owner rejects the deposit and the state is `owner_declined`.
- `swap-retry`: the same key twice answers from the row with one quote request.
- `swap-restart`: the server restarts while `awaiting_owner`; status reads the backend afterwards.
- `swap-submit`: a failed submit leaves `deposit_sent`; the next status retries it.

## How to get to it (user POV)

- An MCP client on the hosted server with scope `x402:pay` and a budget. `jaw_swap` takes `originChainId`, `originToken` (zero address for the native coin), `destinationChainId`, `destinationToken`, `amount` in base units, and optionally `recipient` and `idempotencyKey`.
- The result holds `state`, `quoteId` (`aurora:<deposit address>`), and while `awaiting_owner` a `url` for the owner. `jaw_swap_status` takes the `quoteId` and reads the swap to its end.
- By hand: `node tools/verify/hosted-client.mjs "$MCP_PUBLIC_URL"`, then `swap <originChain> <originToken> <destChain> <destToken> <amount> [recipient|-] [key]` and `swap-status <quoteId>`.

## Driving it

Preconditions: baseline preconditions of this map; Docker running; `JAW_KEYS_URL` set to a keys app the owner can reach, since the owner step opens its link. The default `JAW_MCP_CHAIN_ID` (84532) matches the seller's quote network, so no swap-specific chain setting is needed.

```bash
S=tools/verify
RUN=$($S/up.sh | tail -1)
$S/doctor.sh "$RUN"
. "$RUN/run.env"
JAW_MCP_SWAP_URL="http://host.docker.internal:$PORT/proxy/v2" \
JAW_MCP_INSECURE_FETCH_HOSTS="host.docker.internal:$PORT" \
JAW_KEYS_URL=https://keys.jaw.id $S/hosted-up.sh "$RUN"
node $S/hosted-client.mjs "$MCP_PUBLIC_URL"
```

Control the stub with `curl -s -X POST "$SELLER/_swap?<switch>"` (switches in ../README.md, "Swap backend stub") and reset it with a JSON body of `{"reset":true}`. Run each drive from a fresh budget unless it says otherwise.

- swap-chain: `network=eip155:8453`, then `swap`. Pass: `wrong_chain` naming both networks, one `challenge` row and no `payment` row in `seller.log`, the swap `quote_failed`.
- swap-budget: `budget 0.001`, then `swap`: `budget_exhausted`, no payment row in `seller.log`. Then `budget 0.01` and `swap` with the same key: one payment row, and the payment key in the `payments` table ends in `:2`.
- swap-origin: `swap` with an origin chain outside JAW's list. Pass: `unsupported_origin_chain`, no request in `seller.log`.
- swap-paused: set `payments_paused` with psql, then `swap`: `payments_paused`.
- swap-check-<mode>: one drive per mode (`two-tx`, `no-tx`, `wrong-chain`, `quote-id`, `provider`, `deposit-field`, `tx-to`, `tx-value`, `tx-data`, `trailing-bytes`, `input-amount`, `output-amount`, `zero-min`, `deposit-self`, `reused`). Pass: `quote_rejected` with the mode's code, one payment row with `"signatureValid":true`, no `url`.
- swap-happy: `swap`, open the `url` as the owner and approve, then `swap-status <quoteId>` repeatedly. The stub walks `PENDING_DEPOSIT`, `PROCESSING`, `SUCCESS`. Pass: `completed`, a `submit` row in `seller.log`, a `swaps` row in `completed`, and the Sepolia receipt of the transfer to the deposit address.
- swap-decline: reject in the wallet. Pass: `owner_declined`, no `txHash`.
- swap-retry: `swap` twice with the same key. Pass: same `swapId`, `quoteId` and `url`, one `payment` row.
- swap-restart: restart the mcp container while `awaiting_owner`, wait past `approveBy` with `$S/run-bounded.sh`, then `swap-status`: `expired`. Set `state=PROCESSING` on the stub and run `swap-status` again: the row adopts the deposit.
- swap-submit: `submitFails=1`, approve, then `swap-status`: still `deposit_sent`. A second `swap-status`: `submitted`.

Not driven here: the 240 s owner window expiring without a restart, concurrent claims, and the quote payment resend path. Unit tests and the Postgres tests cover them.

## Risks

- The deposit moves the owner's funds outside any budget. A session key must never sign it, and the link must not be reopened for a stored quote.
- The quote body is untrusted input to a signing screen. The call shown to the owner must equal the `transfer` of the amount to the deposit address, byte for byte.
- A retry must never pay a second quote. Compare the `payments` rows and the `seller.log` payment rows with the number of `swap` calls.
- The quote is paid on the connection's chain only. A connection on another chain must be refused before signing.
- The stub is EVM-only and answers quotes with a fresh random deposit address. It proves the tool's flow, not Aurora's behavior.

## What counts as evidence

- Quote `REV` and `TREE` from `evidence/run.env` and the `head:` line from `up.sh` with every result.
- Each drive saves the tool output, the matching `seller.log` rows and, where the pass condition names one, the `swaps` and `payments` rows, under `$RUN/evidence/<drive name>`.
- A refusal drive passes only when `seller.log` shows the request count it names. A refusal text alone is not evidence that nothing was paid.
- The happy path needs the owner's approval and a receipt for the deposit transfer. A stub-only `completed` without the receipt is not a pass.

## Manual mainnet check

Separate from the testnet lanes and run by a person. Needs a Base mainnet connection with a budget of at least 0.01 USDC, `JAW_MCP_SWAP_URL` unset (the production backend), and USDC on both chains.

1. Swap 1 USDC from Base to Arbitrum USDC (`swap 8453 <USDC on Base> 42161 <USDC on Arbitrum> 1000000`), origin equal to the connection chain.
2. Swap 1 USDC from Arbitrum to Base (`swap 42161 <USDC on Arbitrum> 8453 <USDC on Base> 1000000`), origin different from the connection chain.
3. In each, open the `url` and check that the wallet dialog offers USDC as the fee token for the origin chain, on Base and on Arbitrum, and approve once paying gas in USDC. Repeat one swap paying in the native coin.
4. Run `swap-status <quoteId>` until the backend reaches `SUCCESS` and the row is `completed`.

Evidence: the settled quote payment, the origin receipt, the destination credit, the backend `SUCCESS`, and a screenshot of each fee picker.

## Gotchas

- Inside the container the seller is `host.docker.internal:$PORT`; `JAW_MCP_INSECURE_FETCH_HOSTS` must list it or the server refuses the plain-http backend.
- One swap is open per connection. A second key while one is `quoting` or `awaiting_owner` gets `swap_in_progress`.
- `expired` is not final; status keeps reading the backend because a deposit signed in time can land late.
- Postgres runs on tmpfs; dump the `swaps` and `payments` rows into `evidence/` before `down.sh`.
