# Pay for a resource

`jaw x402 pay <url>` fetches a URL and, when it answers 402, pays it from the session payer within the configured caps. Without `--pay` it stops before funding or signing and reports what it would pay.

## Sub-features

- `paid`: a 402 priced under the caps is signed, sent and settled; the resource comes back.
- `dry-run`: without `--pay`, nothing is signed or sent.
- `over-cap`: a price above the per-call or configured cap is refused before signing.
- `asset-mismatch`: a challenge in another asset is refused.
- `upto-refused`: an `upto` challenge the payer cannot satisfy is refused with a reason.
- `max-amount`: `--max-amount` lowers the ceiling for one call.

## How to get to it (user POV)

- Terminal: `jaw x402 pay <url> [--pay] [--max-amount <base units>] [-o json]`.
- The same flow backs the MCP tool `jaw_pay_and_fetch`; that entry point is in mcp-pay-and-fetch.md.

## Driving it with drive.sh

Preconditions: baseline preconditions from the index, and `node $S/payer.mjs "$PWD"` reports at least 1200000 for the verification payer (see ../README.md, Launch). Refusal sub-features (over-cap, asset-mismatch, max-amount, dry-run) work without it.

- paid: `$S/drive.sh "$RUN" head pay-exact x402 pay '{SELLER}/exact' --pay -o json`, same for `base`, then `node $S/compare.mjs "$RUN" pay-exact` prints `same`. `evidence/seller.log` gains a `"path":"/exact","event":"payment"` row with `"signatureValid":true,"termsMatch":true`.
- dry-run: `... pay-dry x402 pay '{SELLER}/exact' -o json` on both. Output carries `wouldPay`; `seller.log` has only a `challenge` row for that call, no `payment` row.
- over-cap: `... pay-overcap x402 pay '{SELLER}/overcap' --pay -o json`. `paid:false`, `refusedReason` names the cap; no `payment` row.
- asset-mismatch: `... pay-asset x402 pay '{SELLER}/wrong-asset' --pay -o json`. Refused, no `payment` row.
- upto-refused: `... pay-upto x402 pay '{SELLER}/upto' --pay -o json`. Refused with a reason; compare against base.
- max-amount: `... pay-max x402 pay '{SELLER}/exact' --pay --max-amount 1000 -o json`. Refused, no `payment` row.

## Gotchas

- `top-up refused on-chain (Request failed with status code 404)` on a paid drive means the verification payer is not funded or `payer.json` is missing.
- The throwaway session has no on-chain permission, so a top-up can never succeed here. A change in the top-up path is not exercised here; use live-settlement with a payer short of funds.
- The seller verifies plain ECDSA only. A payer that is EIP-7702 delegated signs ERC-7739 and is refused by this seller by design.
- Each paid call appends to `work/home-<which>/.jaw/x402-log.jsonl`, and later calls see that spend against the caps. Run comparisons in the same order on both binaries.
