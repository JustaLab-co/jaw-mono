#!/usr/bin/env bash
# Read-only: is this run worth driving? Runs every check, then exits non-zero if
# any hard check failed. A WARN does not fail the run.
# Usage: doctor.sh <run-dir> [--live]
set -uo pipefail
RUN=${1:?run dir}; . "$RUN/run.env"
FAILED=0
fail() { echo "FAIL $*"; FAILED=1; }
warn() { echo "WARN $*"; }
ok() { echo "ok   $*"; }

if ! kill -0 "$SELLER_PID" 2>/dev/null; then fail "seller pid $SELLER_PID is not running"
elif ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -a -p "$SELLER_PID" >/dev/null; then fail "seller port $PORT is not owned by pid $SELLER_PID"
else ok "seller $SELLER on pid $SELLER_PID"; fi

bins=ok
[ "$("$BIN_head" --version 2>/dev/null | grep -o '0\.[0-9.]*' | head -1)" ] || { fail "head binary does not run"; bins=; }
[ "$("$BIN_base" --version 2>/dev/null | grep -o '[0-9]*\.[0-9]*\.[0-9]*' | head -1)" = 0.4.0 ] || { fail "baseline is not 0.4.0"; bins=; }
grep -q "jaw.id-cli-.*\.tgz\|file:" "$RUN/work/head/package.json" || { fail "head is not installed from the packed tarball"; bins=; }
[ -n "$bins" ] && ok "head and baseline binaries run (head from tarball ${HEAD_TGZ_SHA:-?})"

if [ "$(git -C "$REPO" rev-parse --short HEAD)" != "$REV" ] || [ "$(git -C "$REPO" diff HEAD | shasum | cut -c1-12)" != "$TREE" ]; then
  warn "working tree changed since the build at $REV; rerun up.sh before attributing results to it"
else ok "build matches the working tree ($REV + tree $TREE)"; fi

# Local --pay drives fund the payer from its real Base Sepolia balance, so an
# unfunded payer fails every one of them for a reason outside the change.
payer=$(HOME=$RUN/work/home-head "$BIN_head" x402 status -o json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { const p = JSON.parse(s).payer; console.log(p.address, p.usdc); } catch {}
  });')
read -r address usdc <<<"$payer"
if [ -z "${usdc:-}" ]; then warn "could not read the payer balance with x402 status; --pay drives may fail on funding"
elif node -e 'process.exit(Number(process.argv[1]) >= 1.2 ? 0 : 1)' "$usdc"; then ok "payer $address holds $usdc USDC"
else warn "payer $address holds $usdc USDC, under the 1.2 USDC local --pay drives need; fund it (node tools/verify/payer.mjs)"; fi

if [ "${2:-}" = --live ]; then
  if [ ! -f "$HOME/.jaw/session-config.json" ]; then fail "no real session in ~/.jaw; run jaw session setup on Base Sepolia"
  elif ! "$BIN_head" x402 status -o json >"$RUN/evidence/live-status.json" 2>&1; then fail "jaw x402 status failed, see evidence/live-status.json"
  else ok "real session answers x402 status (evidence/live-status.json)"; fi
fi

if [ -n "${COMPOSE_PROJECT:-}" ]; then
  if docker compose -p "$COMPOSE_PROJECT" -f "$(dirname "$0")/compose.yaml" exec -T postgres pg_isready -U jaw >/dev/null 2>&1; then
    ok "postgres ready at ${DATABASE_URL:-?}"
  else fail "postgres not ready"; fi
  # Healthy says nothing about which code runs: an image reused through
  # JAW_VERIFY_MCP_IMAGE can come from another commit.
  mcp=$(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --filter label=com.docker.compose.service=mcp | head -1)
  if [ -n "$mcp" ]; then
    built=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$mcp")
    if [ -z "$built" ]; then warn "mcp image has no revision label, so nothing ties it to $REV; build it with --label org.opencontainers.image.revision=$HEAD_SHA"
    elif [ "$built" != "$HEAD_SHA" ]; then fail "mcp image is from $built, not $HEAD_SHA; rebuild it or unset JAW_VERIFY_MCP_IMAGE"
    else ok "mcp image built from $REV"; fi
  fi
fi
if [ -n "${MCP_URL:-}" ]; then
  if curl -fsS --max-time 5 "${MCP_URL%/mcp}/api/health" >"$RUN/evidence/mcp-health.json"; then
    ok "mcp healthy ($(cat "$RUN/evidence/mcp-health.json"))"
  else fail "mcp /api/health is not 200, see evidence/mcp-health.json and docker logs"; fi
fi
exit $FAILED
