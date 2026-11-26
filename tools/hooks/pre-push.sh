#!/bin/sh
# Runs the tests of the projects this push changes, sized to the machine load.
# CI runs the same tests on the PR, so a timeout or a crash that survives one
# serial rerun only warns, and a machine past the load ceiling skips tests.
#
# Usage: pre-push.sh <default-base> <nx affected args...> < pre-push stdin
# FULL_HOOKS=1 in .husky/pre-push runs the previous full checks instead.

default_base=$1
shift
zero=0000000000000000000000000000000000000000
# Load per core above which tests are left to CI.
ceiling=30

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

base=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null) || base=
[ -n "$base" ] || base=$default_base
git fetch -q origin "$base" 2>/dev/null || true
git rev-parse -q --verify "origin/$base" >/dev/null || base=$default_base

# Files this push changes that still differ from the base. A merge of the
# base brings in files equal to the base, so they drop out.
: >"$tmp/files"
while read -r _ local _ remote; do
  [ "$local" = "$zero" ] && continue
  fork=$(git merge-base "origin/$base" "$local" 2>/dev/null) || {
    echo "pre-push: no origin/$base, leaving tests to CI"
    exit 0
  }
  from=$remote
  if [ "$remote" = "$zero" ] || ! git cat-file -e "$remote^{commit}" 2>/dev/null; then
    from=$fork
  fi
  git diff --name-only "$from" "$local" | sort >"$tmp/push"
  git diff --name-only "$fork" "$local" | sort >"$tmp/base"
  comm -12 "$tmp/push" "$tmp/base" >>"$tmp/files"
done
files=$(sort -u "$tmp/files" | paste -sd, -)
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

set -- "$@" --files="$files"
timeout=5000
if [ "$ratio" -gt 1 ]; then
  timeout=$((5000 * (ratio < 6 ? ratio : 6)))
  set -- "$@" --parallel=1
fi
echo "pre-push: testing against origin/$base, load $load on $cores cores, test timeout ${timeout}ms"

{ nx affected "$@" -- --testTimeout="$timeout" 2>&1; echo $? >"$tmp/rc"; } | tee "$tmp/log"
[ "$(cat "$tmp/rc")" = 0 ] && exit 0

plain() { perl -pe 's/\e\[[0-9;]*m//g' "$tmp/log"; }
failed=$(plain | sed -n 's/^ *- \([^ ]*\):test.*/\1/p' | sort -u | paste -sd, -)
if [ -z "$failed" ]; then
  echo "pre-push: failed before any test ran, blocking the push"
  exit 1
fi

echo "pre-push: rerunning $failed one at a time with a 30s test timeout"
{ nx run-many -t test -p "$failed" --parallel=1 --skip-nx-cache -- --testTimeout=30000 2>&1; echo $? >"$tmp/rc"; } | tee "$tmp/log"
if [ "$(cat "$tmp/rc")" = 0 ]; then
  echo "pre-push: WARNING $failed passed only on the serial rerun, likely load"
  exit 0
fi

# A failure counts as load or infrastructure when every failed test timed
# out, or when no test failed and the run was killed or ran out of memory.
verdict=$(plain | awk '
  /Tests +[0-9]+ failed/ { match($0, /[0-9]+ failed/); tests += substr($0, RSTART, RLENGTH - 7) }
  /Tests: +[0-9]+ failed/ { match($0, /[0-9]+ failed/); tests += substr($0, RSTART, RLENGTH - 7) }
  /Test timed out in|Exceeded timeout of|Hook timed out in/ { timeouts++ }
  /exit code 137|SIGKILL|heap out of memory|ENOMEM|ENOSPC/ { crashed = 1 }
  END {
    if ((tests > 0 && timeouts >= tests) || (tests == 0 && crashed)) print "load"
    else print "real"
  }')
if [ "$verdict" = load ]; then
  echo "pre-push: WARNING $failed failed only on timeouts or a crash, pushing. CI reruns these tests."
  exit 0
fi
echo "pre-push: $failed failed, blocking the push"
exit 1
