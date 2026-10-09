#!/usr/bin/env bash
# Builds HEAD in a clean detached worktree, packs and installs it, installs
# published 0.4.0 as the baseline, makes two throwaway homes and starts the
# local x402 seller. Refuses a dirty tree, so every result belongs to a commit.
# Runs go under .verify-cache/ (gitignored) unless JAW_VERIFY_ROOT points elsewhere.
# Usage: [JAW_VERIFY_TGZ=<packed cli>] tools/verify/up.sh [run-id]
# Prints the run directory on the last line.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
DIRTY=$(git -C "$REPO" status --porcelain)
if [ -n "$DIRTY" ]; then
  printf 'refusing to verify a dirty tree; commit or stash these first:\n%s\n' "$DIRTY" >&2
  exit 1
fi
HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)
mkdir -p "${JAW_VERIFY_ROOT:-$REPO/.verify-cache}"
export JAW_VERIFY_ROOT=$(cd "${JAW_VERIFY_ROOT:-$REPO/.verify-cache}" && pwd)
ROOT=$JAW_VERIFY_ROOT
RUN=$ROOT/${1:-$(date +%Y%m%d-%H%M%S)}
W=$RUN/work
SRC=$W/src
[ -d "$REPO/node_modules" ] || { echo "run bun install in $REPO first" >&2; exit 1; }
mkdir -p "$W" "$RUN/pids" "$RUN/evidence/head" "$RUN/evidence/base"
stamp() { printf 'head: %s\ntree: clean\n' "$HEAD_SHA"; }
# A failed start leaves no registered worktree behind; down.sh removes it otherwise.
drop_src() { local code=$?; [ "$code" -ne 0 ] && [ -d "$SRC" ] && git -C "$REPO" worktree remove --force "$SRC"; return 0; }
trap drop_src EXIT
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
  echo "building @jaw.id/agent and @jaw.id/cli at $HEAD_SHA in $SRC" >&2
  stamp >"$RUN/evidence/build.log"
  git -C "$REPO" worktree add -q --detach "$SRC" "$HEAD_SHA"
  (cd "$SRC" && bun install --frozen-lockfile \
    && NX_DAEMON=false bunx nx run-many -t build -p @jaw.id/agent @jaw.id/cli --skip-nx-cache) >>"$RUN/evidence/build.log" 2>&1 \
    || { tail -20 "$RUN/evidence/build.log" >&2; exit 1; }
  if grep -rlE "from ['\"]@jaw.id/agent['\"]" "$SRC/packages/cli/dist" | grep -qv '\.map$'; then
    echo "cli dist imports @jaw.id/agent at runtime; the bundle is broken" >&2; exit 1
  fi
  (cd "$SRC/packages/cli" && npx oclif manifest >/dev/null 2>&1 && npm pack --pack-destination "$W" >/dev/null 2>&1; rm -f oclif.manifest.json)
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
stamp >"$RUN/evidence/seller.log"
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' node "$HERE/seller.mjs" "$REPO" "$PORT" "$RUN/evidence/seller.log" >"$W/seller.out" 2>&1 </dev/null &
SELLER_PID=$!
echo "$SELLER_PID" >"$RUN/pids/seller"
for _ in $(seq 1 50); do grep -q '"listening"' "$RUN/evidence/seller.log" 2>/dev/null && break; sleep 0.2; done
grep -q '"listening"' "$RUN/evidence/seller.log" || { echo "seller did not start" >&2; kill $SELLER_PID; exit 1; }

cat > "$RUN/run.env" <<ENV
REPO=$REPO
RUN=$RUN
PORT=$PORT
SELLER=http://localhost:$PORT
SELLER_PID=$SELLER_PID
HEAD_SHA=$HEAD_SHA
SRC=$SRC
REV=$(git -C "$REPO" rev-parse --short HEAD)
TREE=$(git -C "$REPO" diff HEAD | shasum | cut -c1-12)
BIN_head=$W/head/node_modules/.bin/jaw
HEAD_TGZ_SHA=$(shasum "$TGZ" | cut -c1-12)
BIN_base=$BASE/node_modules/.bin/jaw
ENV
{ stamp; cat "$RUN/run.env"; } >"$RUN/evidence/run.env"
echo "$RUN"
