#!/usr/bin/env bash
# Checks the harness itself: up.sh refuses a dirty tree, run-bounded.sh ends on
# its limit, pre-push compares against the PR base, and two runs with the same
# id get separate compose projects. The compose case needs Docker and starts
# only Postgres, under projects it removes before exiting.
# Usage: tools/verify/selftest.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
T=$(mktemp -d)
FAILED=0
check() {
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; FAILED=1; fi
}

echo "head: $(git -C "$REPO" rev-parse HEAD)"

# up.sh, in a scratch repo holding only tools/verify.
mkdir -p "$T/repo/tools" && cp -R "$HERE" "$T/repo/tools/verify"
git -C "$T/repo" init -q
git -C "$T/repo" add -A
git -C "$T/repo" -c user.name=t -c user.email=t@t commit -qm init
JAW_VERIFY_ROOT=$T/cache "$T/repo/tools/verify/up.sh" >/dev/null 2>"$T/up-clean.err"
check "given a clean tree, up.sh passes the tree check" "! grep -q 'dirty tree' '$T/up-clean.err'"
echo x >"$T/repo/stray.txt"
echo y >>"$T/repo/tools/verify/README.md"
JAW_VERIFY_ROOT=$T/cache "$T/repo/tools/verify/up.sh" >/dev/null 2>"$T/up-dirty.err"
code=$?
sed 's/^/     /' "$T/up-dirty.err"
check "given a dirty tree, up.sh exits non-zero" "[ $code -ne 0 ]"
check "and names each dirty file" "grep -q 'stray.txt' '$T/up-dirty.err' && grep -q 'tools/verify/README.md' '$T/up-dirty.err'"

# run-bounded.sh
start=$(date +%s)
"$HERE/run-bounded.sh" 2 "$T/bounded.log" sleep 10
took=$(( $(date +%s) - start ))
echo "     sleep 10 under a 2 s limit: .done=$(cat "$T/bounded.log.done" 2>/dev/null) after ${took}s"
check "given a 2 s limit on sleep 10, <log>.done exists" "[ -f '$T/bounded.log.done' ]"
check "and holds a non-zero code" "[ -s '$T/bounded.log.done' ] && [ \"\$(cat '$T/bounded.log.done')\" != 0 ]"
check "within about 2 s" "[ $took -le 4 ]"
"$HERE/run-bounded.sh" 5 "$T/ok.log" sh -c 'echo out; echo err >&2; exit 3'
check "given a command that exits 3, <log>.done holds 3 and the log both streams" \
  "[ \"\$(cat '$T/ok.log.done')\" = 3 ] && grep -q out '$T/ok.log' && grep -q err '$T/ok.log'"

# .husky/pre-push, with gh and nx stubbed.
mkdir -p "$T/bin"
printf '#!/bin/sh\necho "$*" >"%s/nx.args"\n' "$T" >"$T/bin/nx"
printf '#!/bin/sh\n[ -n "$GH_BASE" ] || exit 1\necho "$GH_BASE"\n' >"$T/bin/gh"
chmod +x "$T/bin/nx" "$T/bin/gh"
(cd "$T/repo" && GH_BASE=mariano-aguero/agent-verify PATH="$T/bin:$PATH" sh "$REPO/.husky/pre-push" >/dev/null 2>&1)
echo "     with a PR: nx $(cat "$T/nx.args")"
check "given a stacked branch, pre-push uses origin/<PR base>" "grep -q -- '--base=origin/mariano-aguero/agent-verify ' '$T/nx.args'"
(cd "$T/repo" && GH_BASE= PATH="$T/bin:$PATH" sh "$REPO/.husky/pre-push" >/dev/null 2>&1)
echo "     without a PR: nx $(cat "$T/nx.args")"
check "given no PR or a failing gh, pre-push uses origin/main" "grep -q -- '--base=origin/main ' '$T/nx.args'"

# hosted-up.sh and down.sh: two runs with the same id from two roots.
if ! docker info >/dev/null 2>&1; then
  echo "skip compose isolation: docker is not running"
else
  mkdir -p "$T/noapp"
  for r in a b c; do
    run=$T/$r/20261009-120000
    mkdir -p "$run/work" "$run/evidence"
    printf 'REPO=%s\nRUN=%s\nSELLER_PID=\nHEAD_SHA=%s\n' "$T/noapp" "$run" "$(git -C "$REPO" rev-parse HEAD)" >"$run/run.env"
  done
  A=$T/a/20261009-120000 B=$T/b/20261009-120000 C=$T/c/20261009-120000
  "$HERE/hosted-up.sh" "$A" >/dev/null 2>&1
  "$HERE/hosted-up.sh" "$B" >/dev/null 2>&1
  PA=$(sed -n 's/^COMPOSE_PROJECT=//p' "$A/run.env") PB=$(sed -n 's/^COMPOSE_PROJECT=//p' "$B/run.env")
  echo "     projects: a=$PA b=$PB"
  up() { [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$1")" ]; }
  check "given two runs with the same id, their compose projects differ" "[ -n '$PA' ] && [ '$PA' != '$PB' ]"
  check "and both are up" "up '$PA' && up '$PB'"
  "$HERE/down.sh" "$A" >/dev/null
  check "when down.sh runs in a, a is gone" "! up '$PA'"
  check "and b is still up" "up '$PB'"
  COMPOSE_PROJECT=$PB "$HERE/down.sh" "$C" >/dev/null
  check "given COMPOSE_PROJECT=b in the env, down.sh on a run without hosted-up leaves b up" "up '$PB'"
  COMPOSE_PROJECT=$PB "$HERE/down.sh" "$T/missing" >/dev/null 2>&1
  code=$?
  check "given no run.env, down.sh fails and leaves b up" "[ $code -ne 0 ] && up '$PB'"
  "$HERE/down.sh" "$B" >/dev/null
  check "when down.sh runs in b, b is gone" "! up '$PB'"
  for p in $PA $PB; do docker compose -p "$p" -f "$HERE/compose.yaml" down -v >/dev/null 2>&1; done
fi

rm -rf "$T"
[ $FAILED = 0 ] && echo "selftest passed" || echo "selftest FAILED"
exit $FAILED
