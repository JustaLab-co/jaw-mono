#!/usr/bin/env bash
# Runs a command for at most <max-seconds>, sends its stdout and stderr to <log>
# and writes its exit code to <log>.done, so a caller waits on a file with a
# deadline instead of on a notification. 124 means the limit was hit.
# Pure shell: macOS ships no `timeout`. The command runs in its own process
# group, so the limit also stops whatever it started.
# Usage: run-bounded.sh <max-seconds> <log> <cmd...>
# Wait: until [ -f <log>.done ] || [ $SECONDS -gt N ]; do sleep 5; done; tail <log>
set -uo pipefail
MAX=${1:?max seconds}; LOG=${2:?log}; shift 2
[ $# -gt 0 ] || { echo "usage: run-bounded.sh <max-seconds> <log> <cmd...>" >&2; exit 2; }
rm -f "$LOG.done" "$LOG.timeout"
set -m
"$@" >"$LOG" 2>&1 </dev/null &
CMD=$!
(sleep "$MAX"; touch "$LOG.timeout"; kill -TERM -- -"$CMD"; sleep 2; kill -KILL -- -"$CMD") >/dev/null 2>&1 &
WATCH=$!
set +m
stop() { kill -KILL -- -"$CMD" -"$WATCH" 2>/dev/null; echo 130 >"$LOG.done.tmp"; mv "$LOG.done.tmp" "$LOG.done"; exit 130; }
trap stop INT TERM HUP
wait "$CMD"; CODE=$?
kill -- -"$WATCH" 2>/dev/null
[ -f "$LOG.timeout" ] && { CODE=124; echo "run-bounded: stopped after ${MAX}s" >>"$LOG"; rm -f "$LOG.timeout"; }
echo "$CODE" >"$LOG.done.tmp"; mv "$LOG.done.tmp" "$LOG.done"
exit "$CODE"
