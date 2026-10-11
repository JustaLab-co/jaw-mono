#!/usr/bin/env bash
# Builds the working tree, packs and installs it, installs published 0.4.0 as the
# baseline, makes two throwaway homes and starts the local x402 seller.
# Builds the checkout this script lives in. Runs go under .verify-cache/ (gitignored)
# unless JAW_VERIFY_ROOT points elsewhere.
# Usage: [JAW_VERIFY_TGZ=<packed cli>] tools/verify/up.sh [run-id]
# Prints the run directory on the last line.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
export JAW_VERIFY_ROOT=${JAW_VERIFY_ROOT:-$REPO/.verify-cache}
ROOT=$JAW_VERIFY_ROOT
RUN=$ROOT/${1:-$(date +%Y%m%d-%H%M%S)}
W=$RUN/work
[ -d "$REPO/node_modules" ] || { echo "run bun install in $REPO first" >&2; exit 1; }
mkdir -p "$W" "$RUN/evidence/head" "$RUN/evidence/base"
# Installs only versions published 7+ days ago, transitive included. Our own
# @jaw.id packages are exempt: a release of core is what the CLI under test needs.
install() {
  mkdir -p "$1" && printf '{"name":"jaw-verify","private":true}
' >"$1/package.json"
  printf 'minimumReleaseAge: 10080 # minutes = 7 days
minimumReleaseAgeExclude:
  - "@jaw.id/*"
' >"$1/pnpm-workspace.yaml"
  (cd "$1" && pnpm add --ignore-scripts "$2" >"$1/install.log" 2>&1) || { tail -15 "$1/install.log" >&2; exit 1; }
}

if [ -n "${JAW_VERIFY_TGZ:-}" ]; then
  # A tarball built once at this SHA, shared by parallel lanes.
  cp "$JAW_VERIFY_TGZ" "$W/jaw.id-cli-prebuilt.tgz"
else
  echo "building @jaw.id/agent and @jaw.id/cli from $REPO" >&2
  (cd "$REPO" && bunx nx run-many -t build -p @jaw.id/agent @jaw.id/cli --skip-nx-cache >"$W/build.log" 2>&1) \
    || { tail -20 "$W/build.log" >&2; exit 1; }
  if grep -rlE "from ['\"]@jaw.id/agent['\"]" "$REPO/packages/cli/dist" | grep -qv '\.map$'; then
    echo "cli dist imports @jaw.id/agent at runtime; the bundle is broken" >&2; exit 1
  fi
  (cd "$REPO/packages/cli" && npx oclif manifest >/dev/null 2>&1 && npm pack --pack-destination "$W" >/dev/null 2>&1; rm -f oclif.manifest.json)
  ls "$W"/jaw.id-cli-*.tgz >/dev/null 2>&1 || { echo "npm pack produced no tarball" >&2; exit 1; }
fi
TGZ=$(ls "$W"/jaw.id-cli-*.tgz 2>/dev/null | head -1)
[ -n "$TGZ" ] || { echo "no packed jaw.id-cli tarball in $W; refusing to install from the registry" >&2; exit 1; }
install "$W/head" "$TGZ"

BASE=$ROOT/baseline-0.4.0
if [ ! -x "$BASE/node_modules/.bin/jaw" ]; then
  install "$BASE" @jaw.id/cli@0.4.0
fi

for which in head base; do node "$HERE/home.mjs" "$REPO" "$W/home-$which" >/dev/null; done
PORT=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
# A new session keeps the seller alive when a recorder or terminal that ran this
# script closes.
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' node "$HERE/seller.mjs" "$REPO" "$PORT" "$RUN/evidence/seller.log" >"$W/seller.out" 2>&1 </dev/null &
SELLER_PID=$!
for _ in $(seq 1 50); do grep -q '"listening"' "$RUN/evidence/seller.log" 2>/dev/null && break; sleep 0.2; done
grep -q '"listening"' "$RUN/evidence/seller.log" || { echo "seller did not start" >&2; kill $SELLER_PID; exit 1; }

cat > "$RUN/run.env" <<ENV
REPO=$REPO
RUN=$RUN
PORT=$PORT
SELLER=http://localhost:$PORT
SELLER_PID=$SELLER_PID
REV=$(git -C "$REPO" rev-parse --short HEAD)
TREE=$(git -C "$REPO" diff HEAD | shasum | cut -c1-12)
BIN_head=$W/head/node_modules/.bin/jaw
HEAD_TGZ_SHA=$(shasum "$TGZ" | cut -c1-12)
BIN_base=$BASE/node_modules/.bin/jaw
ENV
cp "$RUN/run.env" "$RUN/evidence/run.env"
echo "$RUN"
