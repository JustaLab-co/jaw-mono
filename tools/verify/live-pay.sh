#!/usr/bin/env bash
# Spends real testnet USDC: pays the staging x402 endpoint with the head build
# and the REAL session in ~/.jaw, then checks the settlement on Base Sepolia.
# It appends to ~/.jaw/x402-log.jsonl and may top up the payer through the
# permission. Refuses to run without JAW_VERIFY_LIVE=1, and one at a time.
# Usage: JAW_VERIFY_LIVE=1 live-pay.sh <run-dir>
set -uo pipefail
RUN=${1:?run dir}; . "$RUN/run.env"
[ "${JAW_VERIFY_LIVE:-}" = 1 ] || { echo "set JAW_VERIFY_LIVE=1 to spend testnet USDC from the real session" >&2; exit 2; }
LOCK=$HOME/.jaw/.verify-live.lock
mkdir "$LOCK" 2>/dev/null || { echo "another live run holds $LOCK" >&2; exit 1; }
trap 'rmdir "$LOCK"' EXIT
URL=https://api-staging.justaname.id/ens/v2/resolve?ens=vitalik.eth
E=$RUN/evidence/live
mkdir -p "$E"
wc -l <"$HOME/.jaw/x402-log.jsonl" >"$E/ledger-before.count" 2>/dev/null || echo 0 >"$E/ledger-before.count"
"$BIN_head" x402 pay "$URL" --pay -o json >"$E/pay.out" 2>"$E/pay.err"; echo $? >"$E/pay.code"
tail -n +"$(( $(cat "$E/ledger-before.count") + 1 ))" "$HOME/.jaw/x402-log.jsonl" >"$E/ledger-new.jsonl"
TX=$(grep -o '"txHash": *"0x[0-9a-f]\{64\}"' "$E/pay.out" | grep -o '0x[0-9a-f]\{64\}' | head -1)
[ -n "$TX" ] || { echo "no settlement tx in evidence/live/pay.out (exit $(cat "$E/pay.code"))"; exit 1; }
cast receipt "$TX" --rpc-url https://sepolia.base.org --json >"$E/receipt.json"
node -e '
const r = require(process.argv[1]);
const t = r.logs.filter((l) => l.topics[0].startsWith("0xddf252ad"));
const rows = t.map((l) => `Transfer 0x${l.topics[1].slice(-40)} -> 0x${l.topics[2].slice(-40)} ${BigInt(l.data)}`);
console.log(`tx ${r.transactionHash} status ${r.status}\n${rows.join("\n")}`);
process.exit(r.status === "0x1" && rows.length ? 0 : 1);' "$E/receipt.json" | tee "$E/settlement.txt"
