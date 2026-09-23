#!/usr/bin/env bash
# Publishes the four SDK packages to a throwaway Verdaccio registry, installs
# them into a project outside the workspace and checks what an integrator gets.
# Inside the workspace every import resolves to src/ through the
# @jaw-mono/source condition, so no other test sees the tarballs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY=http://localhost:4873
PACKAGES=(core wagmi ui cli)
WORK="$(mktemp -d)"

cleanup() {
  if [[ -n "${VERDACCIO_PID:-}" ]]; then
    kill "$VERDACCIO_PID" 2>/dev/null || true
    wait "$VERDACCIO_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

for p in "${PACKAGES[@]}"; do
  if [[ ! -d "$ROOT/packages/$p/dist" ]]; then
    echo "packages/$p has no dist, build it first" >&2
    exit 1
  fi
done

# Another registry on the port would take the publishes with whatever it
# already stores, so refuse rather than share it.
if curl -sf "$REGISTRY/-/ping" > /dev/null; then
  echo "something is already listening on $REGISTRY, stop it first" >&2
  exit 1
fi

rm -rf "$ROOT/tmp/local-registry/storage"
"$ROOT/node_modules/.bin/verdaccio" --config "$ROOT/.verdaccio/config.yml" --listen 4873 > "$WORK/verdaccio.log" 2>&1 &
VERDACCIO_PID=$!
for _ in $(seq 1 30); do
  if curl -sf "$REGISTRY/-/ping" > /dev/null; then break; fi
  sleep 1
done
if ! curl -sf "$REGISTRY/-/ping" > /dev/null; then
  cat "$WORK/verdaccio.log"
  exit 1
fi

# A userconfig of its own keeps ~/.npmrc and its tokens out of the publish.
printf 'registry=%s/\n//localhost:4873/:_authToken=local\n' "$REGISTRY" > "$WORK/npmrc"
for p in "${PACKAGES[@]}"; do
  (cd "$ROOT/packages/$p" && npm publish --registry "$REGISTRY" --userconfig "$WORK/npmrc" --loglevel warn)
done

cp -R "$ROOT/e2e/published/consumer" "$WORK/consumer"
cd "$WORK/consumer"

# Written here rather than committed, since a package.json under e2e/ would
# make Nx treat the consumer as a workspace project. viem is the version
# bun.lock already admitted: the packages can ask for one younger than the
# release-age window right after the workspace moves to it.
VIEM_VERSION="$(node -p "require('$ROOT/node_modules/viem/package.json').version")"
cat > package.json <<EOF
{
  "name": "jaw-published-consumer",
  "private": true,
  "dependencies": {
    "@jaw.id/cli": "*",
    "@jaw.id/core": "*",
    "@jaw.id/ui": "*",
    "@jaw.id/wagmi": "*",
    "@tanstack/react-query": "5.90.21",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "viem": "$VIEM_VERSION",
    "wagmi": "^3.0.0"
  }
}
EOF

# An empty cache, because bun keys its cache by name and version, and a copy of
# the same version from npm would be installed instead of the one just built.
BUN_INSTALL_CACHE_DIR="$WORK/bun-cache" bun install

for p in "${PACKAGES[@]}"; do
  if ! cmp -s "$ROOT/packages/$p/dist/index.js" "node_modules/@jaw.id/$p/dist/index.js"; then
    echo "node_modules/@jaw.id/$p is not the package in packages/$p" >&2
    exit 1
  fi
done

node check.mjs
node check.cjs
"$ROOT/node_modules/.bin/tsc" -p tsconfig.json
echo "published packages install and load"
