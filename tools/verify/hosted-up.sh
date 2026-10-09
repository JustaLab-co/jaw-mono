#!/usr/bin/env bash
# Starts Postgres and the apps/mcp container for this run.
# Appends COMPOSE_PROJECT, DATABASE_URL and MCP_URL to run.env.
# Usage: [JAW_KEYS_URL=http://localhost:<keys port>] [JAW_VERIFY_MCP_IMAGE=<tag>] hosted-up.sh <run-dir>
set -euo pipefail
RUN=${1:?run dir}; . "$RUN/run.env"
DIR=$(cd "$(dirname "$0")" && pwd)
docker info >/dev/null 2>&1 || { echo "docker is not running" >&2; exit 1; }
# Hash of the absolute run path: two worktrees can start runs with the same id.
PROJECT=jaw-verify-$(printf %s "$RUN" | shasum | cut -c1-8)
# The image builds from up.sh's clean worktree of HEAD when there is one.
CTX=$REPO; [ -d "${SRC:-}" ] && CTX=$SRC
PROFILE=; [ -f "$CTX/apps/mcp/Dockerfile" ] && PROFILE="--profile mcp"
# The OAuth issuer must equal the URL clients reach, so the host port is fixed
# before start. The sealing key is per run and stays out of run.env, which is
# copied into evidence.
MCP_PORT=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
KEYFILE=$RUN/work/sealing.key
[ -f "$KEYFILE" ] || (umask 077; openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' >"$KEYFILE")
export MCP_PORT JAW_MCP_PUBLIC_URL=http://localhost:$MCP_PORT JAW_KEYS_URL=${JAW_KEYS_URL:-http://localhost:3100}
export JAW_MCP_SEALING_KEYS=$(cat "$KEYFILE")
# JAW_KEYS_URL is required by the server (it builds the approve and authorize
# links from it) but nothing here contacts it, so a placeholder is enough.
# JAW_VERIFY_MCP_IMAGE reuses an image built once per round; otherwise this run
# builds its own tag.
BUILD=--build
if [ -n "${JAW_VERIFY_MCP_IMAGE:-}" ]; then export MCP_IMAGE=$JAW_VERIFY_MCP_IMAGE; BUILD=--no-build
else export MCP_IMAGE=jaw-verify-mcp:$PROJECT; fi
printf 'head: %s\ntree: clean\n' "$HEAD_SHA" >"$RUN/evidence/compose-up.log"
REPO=$CTX docker compose -p "$PROJECT" -f "$DIR/compose.yaml" $PROFILE up -d $BUILD --wait >>"$RUN/evidence/compose-up.log" 2>&1 \
  || { tail -20 "$RUN/evidence/compose-up.log" >&2; exit 1; }
PG=$(docker compose -p "$PROJECT" -f "$DIR/compose.yaml" port postgres 5432 | sed 's/.*://')
{ echo "COMPOSE_PROJECT=$PROJECT"; echo "DATABASE_URL=postgres://jaw:jaw@localhost:$PG/jaw_mcp"; } >>"$RUN/run.env"
if [ -n "$PROFILE" ]; then
  { echo "MCP_URL=http://localhost:$MCP_PORT/mcp"; echo "MCP_PUBLIC_URL=$JAW_MCP_PUBLIC_URL"; echo "KEYS_URL=$JAW_KEYS_URL"; } >>"$RUN/run.env"
else
  echo "apps/mcp/Dockerfile not found: Postgres only" >&2
fi
{ printf 'head: %s\ntree: clean\n' "$HEAD_SHA"; cat "$RUN/run.env"; } >"$RUN/evidence/run.env"
grep -E 'DATABASE_URL|MCP_URL' "$RUN/run.env"
