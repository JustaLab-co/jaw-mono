#!/usr/bin/env bash
# Runs one chaos test file, optionally only the tests matching a name pattern,
# recorded with script(1) into the evidence directory. Exits with the test's code.
# Usage: run.sh <file> [name pattern]. CHAOS_EVIDENCE moves the evidence.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(git -C "$HERE" rev-parse --show-toplevel)
export CHAOS_EVIDENCE=${CHAOS_EVIDENCE:-$ROOT/.verify-cache/chaos}
mkdir -p "$CHAOS_EVIDENCE"
FILE=$1 PATTERN=${2:-}
NAME=${FILE%%.*}${CHAOS_SKEW:+-skew$CHAOS_SKEW}${PATTERN:+-$(printf %s "$PATTERN" | tr -c 'a-zA-Z0-9' '-' | cut -c1-40)}
LOG=$CHAOS_EVIDENCE/${NAME//\//-}.log
CODE=$(mktemp)
echo "head: $(git -C "$ROOT" rev-parse HEAD)" >"$LOG"
ARGS=(--test --test-concurrency=1 --test-reporter=tap)
[ -n "$PATTERN" ] && ARGS+=(--test-name-pattern="$PATTERN")
if [[ $FILE == *.ts ]]; then
  # The in-process tests load apps/mcp source, whose tsconfig maps '@/'.
  cd "$ROOT/apps/mcp" && export TSX_TSCONFIG_PATH=tsconfig.json
  ARGS=(--import tsx "${ARGS[@]}")
  FILE=$HERE/$FILE
else
  cd "$HERE"
fi
script -q -a "$LOG" bash -c 'node "$@"; echo $? >'"$CODE" _ "${ARGS[@]}" "$FILE" >/dev/null
code=$(cat "$CODE"); rm -f "$CODE"
echo "exit: $code" >>"$LOG"
grep -E '^(not )?ok|^# (pass|fail)' "$LOG" | sed 's/\r$//'
exit "$code"
