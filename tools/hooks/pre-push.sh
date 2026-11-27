#!/bin/sh
# Runs the tests of the projects this push changes, sized to the machine load.
# CI runs the same tests on the PR, so a test that still fails only on a
# timeout or a killed worker after one serial rerun only warns, and a machine
# past the load ceiling skips tests.
#
# Usage: pre-push.sh <default-base> <vitest|jest> <nx affected args...> < stdin
# FULL_HOOKS=1 in .husky/pre-push runs the previous full checks instead.

default_base=$1
runner=$2
shift 2
zero=0000000000000000000000000000000000000000
# Load per core above which tests are left to CI.
ceiling=30

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

base=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null) || base=
[ -n "$base" ] || base=$default_base
git fetch -q origin "$base" 2>/dev/null || true
git rev-parse -q --verify "origin/$base" >/dev/null || base=$default_base
if ! git rev-parse -q --verify "origin/$base" >/dev/null; then
  echo "pre-push: no origin/$base, leaving tests to CI"
  exit 0
fi

# Files the branch's own pushed commits change. Commits a merge brings in are
# already on origin/<base>, so they drop out, and a merge commit adds only the
# files its resolution changed.
: >"$tmp/files"
while read -r _ local _ remote; do
  [ "$local" = "$zero" ] && continue
  pushed=
  if [ "$remote" != "$zero" ] && git cat-file -e "$remote^{commit}" 2>/dev/null; then
    pushed=$remote
  fi
  git log --no-merges --format= --name-only "$local" --not "origin/$base" $pushed >>"$tmp/files"
  for merge in $(git rev-list --merges "$local" --not "origin/$base" $pushed); do
    git diff-tree --cc --name-only --no-commit-id "$merge" >>"$tmp/files"
  done
done
files=$(grep -v '^$' "$tmp/files" | sort -u | paste -sd, -)
if [ -z "$files" ]; then
  echo "pre-push: no changes against origin/$base, nothing to test"
  exit 0
fi

cores=$(getconf _NPROCESSORS_ONLN)
load=$(uptime | sed 's/.*load averages*: *//; s/[, ].*//')
ratio=$(awk -v l="$load" -v c="$cores" 'BEGIN { r = int(l / c); if (r < l / c) r++; print r }')
if [ "$ratio" -gt "$ceiling" ]; then
  echo "pre-push: load $load on $cores cores is past the ceiling, skipping tests. CI runs them on the PR."
  exit 0
fi

# Jest's test timeout covers hooks; Vitest has a separate one.
timeouts() {
  if [ "$runner" = vitest ]; then
    echo "--testTimeout=$1 --hookTimeout=$1"
  else
    echo "--testTimeout=$1"
  fi
}

set -- "$@" --files="$files"
timeout=5000
if [ "$ratio" -gt 1 ]; then
  timeout=$((5000 * (ratio < 6 ? ratio : 6)))
  set -- "$@" --parallel=1
fi
echo "pre-push: testing against origin/$base, load $load on $cores cores, test timeout ${timeout}ms"

run() {
  { "$@" 2>&1; echo $? >"$tmp/rc"; } | tee "$tmp/log"
  perl -pe 's/\e\[[0-9;]*m//g' "$tmp/log" >"$tmp/plain"
  [ "$(cat "$tmp/rc")" = 0 ]
}

run nx affected "$@" -- $(timeouts "$timeout") && exit 0

# Nx lists failed tasks and the tasks it skipped because a dependency failed.
# Only a failed test is worth a rerun; anything else is a real failure.
awk '
  /^Failed tasks:/ { section = "failed"; next }
  /^Tasks not run because/ { section = "skipped"; next }
  /^ *- / && section { sub(/^ *- /, ""); print section, $1; next }
  /[^ ]/ { section = "" }
' "$tmp/plain" >"$tmp/tasks"
blocking=$(awk '$1 == "skipped" || $2 !~ /:test$/ { print $2 }' "$tmp/tasks" | paste -sd, -)
failed=$(awk '$1 == "failed" && $2 ~ /:test$/ { sub(/:test$/, "", $2); print $2 }' "$tmp/tasks" | sort -u | paste -sd, -)
if [ -n "$blocking" ] || [ -z "$failed" ]; then
  echo "pre-push: ${blocking:-a task} failed or never ran, blocking the push"
  exit 1
fi

echo "pre-push: rerunning $failed one at a time with a 30s timeout"
if run nx run-many -t test -p "$failed" --parallel=1 --skip-nx-cache -- $(timeouts 30000); then
  echo "pre-push: WARNING $failed passed only on the serial rerun, likely load"
  exit 0
fi

# Every failure Vitest or Jest reports opens with a header, and the next line
# names the error. The push goes through only when each of them is a timeout
# or a killed worker, or when the run died of memory before reporting any.
verdict=$(awk '
  pending && /[^ ]/ {
    if (/timed out in|Exceeded timeout of/) load++
    else if (/Channel closed|ERR_IPC_CHANNEL_CLOSED|was terminated by another process/) load++
    else real++
    pending = 0
    next
  }
  /^ FAIL  .*( > |\[ )/ || /^  ● / || /Unhandled (Rejection|Error) / { pending = 1 }
  /heap out of memory/ { oom = 1 }
  END { print (real == 0 && (load > 0 || oom)) ? "load" : "real" }
' "$tmp/plain")
if [ "$verdict" = load ]; then
  echo "pre-push: WARNING $failed failed only on timeouts or a killed worker, pushing. CI reruns these tests."
  exit 0
fi
echo "pre-push: $failed failed, blocking the push"
exit 1
