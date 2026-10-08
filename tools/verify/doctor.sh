#!/usr/bin/env bash
# Read-only: is this run worth driving? Exits non-zero on the first hard failure.
# Usage: doctor.sh <run-dir> [--live]
set -uo pipefail
RUN=${1:?run dir}; . "$RUN/run.env"
fail() { echo "FAIL $*"; exit 1; }
ok() { echo "ok   $*"; }
kill -0 "$SELLER_PID" 2>/dev/null || fail "seller pid $SELLER_PID is not running"
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -a -p "$SELLER_PID" >/dev/null || fail "port $PORT is not owned by seller pid $SELLER_PID"
ok "seller $SELLER on pid $SELLER_PID"
[ "$("$BIN_head" --version 2>/dev/null | grep -o '0\.[0-9.]*' | head -1)" ] || fail "head binary does not run"
[ "$("$BIN_base" --version | grep -o '[0-9]*\.[0-9]*\.[0-9]*' | head -1)" = 0.4.0 ] || fail "baseline is not 0.4.0"
grep -q "jaw.id-cli-.*\.tgz\|file:" "$RUN/work/head/package.json" || fail "head is not installed from the packed tarball"
ok "head and baseline binaries run (head from tarball ${HEAD_TGZ_SHA:-?})"
if [ "$(git -C "$REPO" rev-parse --short HEAD)" != "$REV" ] || [ "$(git -C "$REPO" diff HEAD | shasum | cut -c1-12)" != "$TREE" ]; then
  echo "WARN working tree changed since the build at $REV; rerun up.sh before attributing results to it"
else ok "build matches the working tree ($REV + tree $TREE)"; fi
if [ "${2:-}" = --live ]; then
  [ -f "$HOME/.jaw/session-config.json" ] || fail "no real session in ~/.jaw; run jaw session setup on Base Sepolia"
  "$BIN_head" x402 status -o json >"$RUN/evidence/live-status.json" 2>&1 || fail "jaw x402 status failed, see evidence/live-status.json"
  ok "real session answers x402 status (evidence/live-status.json)"
fi
if [ -n "${COMPOSE_PROJECT:-}" ]; then
  docker compose -p "$COMPOSE_PROJECT" -f "$(dirname "$0")/compose.yaml" exec -T postgres pg_isready -U jaw >/dev/null || fail "postgres not ready"
  ok "postgres ready at $DATABASE_URL"
fi
exit 0
