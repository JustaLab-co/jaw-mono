# Real settlement

A payment that a real facilitator settles on Base Sepolia: the only proof that signatures from a delegated payer (ERC-7739) or from the smart account (passkey, WebAuthn) are accepted, and that a top-up through the permission works.

## Sub-features

- `live-pay`: the head build pays the staging endpoint from the real session; the facilitator settles.
- `live-topup`: the same, with the payer below the price, so funds move through the permission first.
- `passkey-pay`: the owner's passkey signs an EIP-3009 authorization from the smart account and the facilitator settles it.

## How to get to it (user POV)

- Terminal with a real session: `jaw x402 pay https://api-staging.justaname.id/ens/v2/resolve?ens=vitalik.eth --pay`.
- Passkey: an approval page on keys.jaw.id signing for the smart account (today through `jaw rpc call eth_signTypedData_v4`; in the hosted server, `/approve/<id>`).

## Driving it with live-pay.sh and passkey-pay.mjs

Preconditions: a real session in `~/.jaw` on Base Sepolia (`jaw session setup`), `$S/doctor.sh "$RUN" --live` passes, owner account holds test USDC, `cast` on PATH.

- live-pay: `JAW_VERIFY_LIVE=1 $S/live-pay.sh "$RUN"`. Pass means `evidence/live/settlement.txt` shows `status 0x1` and a Transfer from the payer to the endpoint's `payTo`, and `ledger-new.jsonl` has the matching row.
- live-topup: drain the payer below 5000 first (spend it with live-pay, or check `evidence/live-status.json` for the payer balance), then run live-pay. Pass needs a `topUp` in `pay.out` and a second Transfer, owner account to payer, in the receipts. Without the drain this sub-feature is not tested.
- passkey-pay: `JAW_VERIFY_HUMAN=1 node $S/passkey-pay.mjs "$RUN"` with a person approving. Pass means `evidence/passkey/result.json` has `status 200`, a receipt transaction, and the final line prints `1` (receipt status success).

## Gotchas

- These spend testnet USDC and write to the real ledger. Never run them in a loop.
- A QR code on keys.jaw.id means the passkey is not in that browser profile.
- A bridge timeout means the approval came after 300 s; the request can be repeated.
- The local seller refuses delegated payers; only this path proves ERC-7739 acceptance.
