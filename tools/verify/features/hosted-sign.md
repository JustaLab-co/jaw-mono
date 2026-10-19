# Hosted sign

`jaw_sign` in `apps/mcp` asks the account owner to sign a message (EIP-191, `wallet_sign` type `0x45`) or EIP-712 typed data (type `0x01`) with the account. The owner reviews it on keys.jaw.id and approves with the passkey. The session key never signs it. The tool needs `wallet:read` only.

## Sub-features

- `sign-message`: a plain message goes to the owner and the signature verifies against the account with `verifyMessage`.
- `sign-typed`: an EIP-712 permit goes to the owner and `verifyTypedData` accepts the signature.
- `sign-screen`: the keys screen shows the permit's spender, amount and deadline.
- `sign-decline`: the owner declines and the tool answers `owner_declined`.
- `sign-malformed`: typed data with no `types`, an undefined `primaryType` or a value that does not fit its type gives `invalid_typed_data` before any link opens.
- `sign-expired`: a link nobody signs past 30 minutes answers `expired`.
- `sign-cap`: three links open for one account, the fourth gives `account_busy`.
- `sign-no-session`: no session key signature is recorded and the audit row names the connection.
- `sign-utf8`: a message with non-ASCII text shows the same text on the keys screen and the signature verifies.

## How to get to it (user POV)

- An MCP client on the hosted server with `wallet:read`. `jaw_sign` takes exactly one of `message` (text, up to 8192 characters, no invisible or control characters besides line breaks and tabs) and `typedData` (`{ domain, types, primaryType, message }`), and optionally `chainId` and `idempotencyKey`.
- The first call returns `state: awaiting_owner` with a `url`. The owner opens it within 30 minutes. The same call again, with the same key and input, returns `signed` with the `signature`, or `owner_declined`, `expired` or `failed`.
- Requests are rows in `permission_requests` with `method = 'sign'`. A restart keeps them: the same key answers the same request, and once its session's lease lapses, one the wallet was not asked yet ends `expired` with code `session_lost`, which still turns `signed` if the owner's answer lands after all, and one already asked stays open with its link until its approval window ends. A connection waits on one sign link at a time, and another key gets `sign_in_progress`.
- By hand: `node tools/verify/hosted-client.mjs "$MCP_PUBLIC_URL" wallet:read`, then `sign-message '<text>' [key]` and `sign-typed '<json>' [key]`. Run the same line again to read the outcome.

## Driving it

Preconditions: baseline preconditions of this map; Docker running; `JAW_KEYS_URL=https://keys.jaw.id`, since the owner step opens its link.

```bash
S=tools/verify
RUN=$($S/up.sh | tail -1)
$S/doctor.sh "$RUN"
JAW_KEYS_URL=https://keys.jaw.id $S/hosted-up.sh "$RUN"
. "$RUN/run.env"
node $S/hosted-client.mjs "$MCP_PUBLIC_URL" wallet:read
```

- sign-message: `sign-message 'hello from jaw' m1`, open the `url` as the owner and approve, then the same line again. Pass: `signed`, and viem `verifyMessage` on Base Sepolia accepts the signature for the connected account.
- sign-typed: `sign-typed '<permit json>' t1` with a USDC permit (owner the account, a spender, a value, a nonce, a deadline), approve, run it again. Pass: `verifyTypedData` accepts the signature.
- sign-screen: before approving the permit, read the keys screen. Pass: it shows the spender, the amount and the deadline.
- sign-decline: reject in the wallet, run the line again. Pass: `owner_declined`, no `signature`.
- sign-malformed: `sign-typed '{"primaryType":"Permit","message":{}}' bad`. Pass: `invalid_typed_data`, no link.
- sign-expired: ask, do not open the link, wait past `approveBy` with `$S/run-bounded.sh`, run the line again. Pass: `expired` with `refusal.code` `expired`, no `url`.
- sign-cap: ask for four different messages under four keys on connections of one account. Pass: the fourth gives `account_busy`, and so does a `jaw_send_calls` on the account while the three wait.
- sign-no-session: after sign-message, dump `audit_events` and the `grants` and `payments` rows with psql. Pass: an audit row for `jaw_sign` on the connection and no session key signature anywhere.
- sign-utf8: `sign-message 'Firmo: ñandú, 日本語' u1`. Pass: the keys screen shows the same text and the signature verifies.

## Risks

- What the owner sees is what gets signed. The wallet must show the message or the typed data exactly as the tool sent it.
- A session key must never sign. Nothing in `jaw_sign` may touch the session store or the budget.
- Sign links share the account's cap of three with grant, revoke, `jaw_send_calls` and `jaw_swap` links, across replicas.

## What counts as evidence

- Quote `REV` and `TREE` from `evidence/run.env` and the `head:` line from `up.sh` with every result.
- Each drive saves the tool output and the keys screenshot under `$RUN/evidence/<drive name>`.
- A signature drive passes only when viem verifies the signature against the account on Base Sepolia.
