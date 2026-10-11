#!/usr/bin/env bash
# Stops what up.sh and hosted-up.sh started for this run and deletes the work
# dir. evidence/ stays. Acts only on what the run's own run.env and pids/
# record: a COMPOSE_PROJECT exported in the shell never selects a project.
# Usage: down.sh <run-dir>
set -uo pipefail
RUN=${1:?run dir}
[ -f "$RUN/run.env" ] || { echo "no run.env in $RUN; refusing to guess what to stop" >&2; exit 1; }
unset COMPOSE_PROJECT
. "$RUN/run.env"
# Runs started before pids/ existed recorded only SELLER_PID.
[ -d "$RUN/pids" ] || { mkdir -p "$RUN/pids"; [ -z "${SELLER_PID:-}" ] || echo "$SELLER_PID" >"$RUN/pids/seller"; }
for f in "$RUN"/pids/*; do
  [ -f "$f" ] || continue
  kill "$(cat "$f")" 2>/dev/null && echo "stopped $(basename "$f") $(cat "$f")"
  rm -f "$f"
done
if [ -n "${COMPOSE_PROJECT:-}" ]; then
  docker compose -p "$COMPOSE_PROJECT" -f "$(dirname "$0")/compose.yaml" --profile mcp down -v >/dev/null 2>&1 && echo "removed compose project $COMPOSE_PROJECT"
fi
[ -d "${SRC:-}" ] && git -C "$REPO" worktree remove --force "$SRC"
git -C "$REPO" worktree prune
rm -rf "$RUN/work"
echo "evidence kept in $RUN/evidence"
