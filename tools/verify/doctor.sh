#!/usr/bin/env bash
# Read-only: is there a keys app and a playground worth driving, built from this checkout?
set -u
KEYS_URL="${JAW_E2E_KEYS_URL:-http://localhost:3001}"
PLAYGROUND_URL="${JAW_E2E_PLAYGROUND_URL:-http://localhost:3002}"
root="$(git rev-parse --show-toplevel)"
ok=1

echo "checkout  $(git -C "$root" rev-parse --abbrev-ref HEAD) $(git -C "$root" rev-parse --short HEAD)"

for pair in "keys $KEYS_URL" "playground $PLAYGROUND_URL/core"; do
  set -- $pair
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$2" || true)"
  if [ "$code" = "200" ]; then echo "ok        $1 $2"; else echo "DOWN      $1 $2 (http $code)"; ok=0; fi
done

# The ports must belong to this worktree's dev servers, not another checkout's.
for port in 3001 3002; do
  pid="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null | head -1)"
  [ -z "$pid" ] && continue
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  case "$cwd" in
    "$root"*) echo "ok        port $port served from this checkout" ;;
    *) echo "FOREIGN   port $port served from ${cwd:-unknown}"; ok=0 ;;
  esac
done

[ -f "$root/apps/playground/.env.local" ] || echo "note      apps/playground/.env.local missing: the manual Base Sepolia check needs NEXT_PUBLIC_API_KEY there"

[ "$ok" = 1 ] && echo "DOCTOR OK" || { echo "DOCTOR FAIL"; exit 1; }
