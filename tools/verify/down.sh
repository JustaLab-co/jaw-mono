#!/usr/bin/env bash
# Stops what up.sh and hosted-up.sh started for this run and deletes the work
# dir. evidence/ stays.
# Usage: down.sh <run-dir>
set -uo pipefail
RUN=${1:?run dir}; . "$RUN/run.env"
kill "$SELLER_PID" 2>/dev/null && echo "stopped seller $SELLER_PID"
if [ -n "${COMPOSE_PROJECT:-}" ]; then
  docker compose -p "$COMPOSE_PROJECT" -f "$(dirname "$0")/compose.yaml" --profile mcp down -v >/dev/null 2>&1 && echo "removed compose project $COMPOSE_PROJECT"
fi
rm -rf "$RUN/work"
echo "evidence kept in $RUN/evidence"
