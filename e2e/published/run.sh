#!/usr/bin/env bash
# Publishes the four SDK packages to a throwaway Verdaccio registry, installs
# them into projects outside the workspace and checks what an integrator gets.
# Inside the workspace every import resolves to src/ through the
# @jaw-mono/source condition, so no other test sees the tarballs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY=http://localhost:4873
PACKAGES=(core wagmi ui cli)
WORK="$(mktemp -d)"
# A version that cannot exist on npm, so nothing but this run's publish can
# satisfy the install. A copy of the same release from npm has the same bytes.
SUFFIX="e2e.$(date +%s)"

cleanup() {
  if [[ -n "${VERDACCIO_PID:-}" ]]; then
    kill "$VERDACCIO_PID" 2>/dev/null || true
    wait "$VERDACCIO_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

ping_registry() {
  curl -sf --max-time 2 "$REGISTRY/-/ping" > /dev/null
}

for p in "${PACKAGES[@]}"; do
  if [[ ! -d "$ROOT/packages/$p/dist" ]]; then
    echo "packages/$p has no dist, build it first" >&2
    exit 1
  fi
done

# Another registry on the port would take the publishes with whatever it
# already stores, so refuse rather than share it.
if ping_registry; then
  echo "something is already listening on $REGISTRY, stop it first" >&2
  exit 1
fi

# Same config as the local-registry target, with storage of its own so a run
# neither reads nor wipes what that target keeps.
sed "s#^storage: .*#storage: $WORK/storage#" "$ROOT/.verdaccio/config.yml" > "$WORK/verdaccio.yml"
"$ROOT/node_modules/.bin/verdaccio" --config "$WORK/verdaccio.yml" --listen 4873 > "$WORK/verdaccio.log" 2>&1 &
VERDACCIO_PID=$!
for _ in $(seq 1 30); do
  if ping_registry; then break; fi
  sleep 1
done
if ! ping_registry; then
  cat "$WORK/verdaccio.log"
  exit 1
fi

# A home and a userconfig of their own keep ~/.npmrc, its tokens and any
# @jaw.id registry override out of both the publish and the installs.
mkdir -p "$WORK/home"
printf 'registry=%s/\n//localhost:4873/:_authToken=local\n' "$REGISTRY" > "$WORK/npmrc"
isolated() {
  HOME="$WORK/home" NPM_CONFIG_USERCONFIG="$WORK/npmrc" BUN_INSTALL_CACHE_DIR="$WORK/bun-cache" "$@"
}

# Pack each package as npm would (prepack included), then publish that exact
# tarball content under the e2e version, with the @jaw.id dependencies moved
# to the same version.
for p in "${PACKAGES[@]}"; do
  (cd "$ROOT/packages/$p" && isolated npm pack --pack-destination "$WORK" --loglevel warn > "$WORK/$p.tgz.name")
  mkdir -p "$WORK/pkg/$p"
  tar -xzf "$WORK/$(tail -n 1 "$WORK/$p.tgz.name")" -C "$WORK/pkg/$p" --strip-components 1
  node -e "
    const fs = require('node:fs');
    const file = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bump = (v) => v + '-$SUFFIX';
    pkg.version = bump(pkg.version);
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith('@jaw.id/')) pkg.dependencies[name] = bump(range);
    }
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  " "$WORK/pkg/$p/package.json"
  (cd "$WORK/pkg/$p" && isolated npm publish --registry "$REGISTRY" --ignore-scripts --tag e2e --loglevel warn)
done

version_of() {
  node -p "require('$WORK/pkg/$1/package.json').version"
}

# viem is the version bun.lock already admitted: the packages can ask for one
# younger than the release-age window right after the workspace moves to it.
VIEM_VERSION="$(node -p "require('$ROOT/node_modules/viem/package.json').version")"

# Writes a package.json outside the repo, since one under e2e/ would make Nx
# treat the consumer as a workspace project, then installs it in isolation.
install_consumer() {
  local dir=$1
  shift
  mkdir -p "$dir"
  cp "$ROOT/e2e/published/consumer/bunfig.toml" "$dir/"
  node -e "
    const deps = Object.fromEntries(process.argv.slice(1).map((d) => {
      const at = d.lastIndexOf('@');
      return [d.slice(0, at), d.slice(at + 1)];
    }));
    require('node:fs').writeFileSync('$dir/package.json',
      JSON.stringify({ name: 'jaw-published-consumer', private: true, dependencies: deps }, null, 2));
  " "$@"
  (cd "$dir" && isolated bun install)
  for p in "${PACKAGES[@]}"; do
    local installed="$dir/node_modules/@jaw.id/$p/package.json"
    [[ -f "$installed" ]] || continue
    if [[ "$(node -p "require('$installed').version")" != "$(version_of "$p")" ]]; then
      echo "$installed is not the version this run published" >&2
      exit 1
    fi
  done
}

# Each package alone, so a runtime dependency that only works because a sibling
# package happens to install it fails here.
install_consumer "$WORK/core-only" "@jaw.id/core@$(version_of core)" "viem@$VIEM_VERSION"
(
  cd "$WORK/core-only"
  node --input-type=module -e "const m = await import('@jaw.id/core'); if (typeof m.create !== 'function') process.exit(1);"
  node -e "require('@jaw.id/core')"
)

install_consumer "$WORK/cli-only" "@jaw.id/cli@$(version_of cli)" "viem@$VIEM_VERSION"
(
  cd "$WORK/cli-only"
  # oclif falls back to scanning commands without it, so its absence is silent.
  test -f node_modules/@jaw.id/cli/oclif.manifest.json
  node_modules/.bin/jaw --help > /dev/null
)

install_consumer "$WORK/consumer" \
  "@jaw.id/core@$(version_of core)" \
  "@jaw.id/wagmi@$(version_of wagmi)" \
  "@jaw.id/ui@$(version_of ui)" \
  "@jaw.id/cli@$(version_of cli)" \
  "@tanstack/react-query@5.90.21" \
  "react@^19.0.0" \
  "react-dom@^19.0.0" \
  "viem@$VIEM_VERSION" \
  "wagmi@^3.0.0"
cp "$ROOT/e2e/published/consumer/"{check.mjs,check.cjs,check-dts.mjs,types.ts,tsconfig.json} "$WORK/consumer/"
cd "$WORK/consumer"
node check.mjs
node check.cjs
node check-dts.mjs
"$ROOT/node_modules/.bin/tsc" -p tsconfig.json
echo "published packages install and load"
