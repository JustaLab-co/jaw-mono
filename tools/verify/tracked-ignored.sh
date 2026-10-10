#!/usr/bin/env bash
# Fails on any tracked file that the repo's own ignore rules match. Such a file
# makes lint-staged's `git add` fail on a commit that stages it, so the
# pre-commit hook blocks the commit. The global excludes file is switched off so
# only rules that travel with the repo count.
# Usage: tools/verify/tracked-ignored.sh [repo-dir]
set -euo pipefail
dir=${1:-$(git rev-parse --show-toplevel)}
hits=$(git -C "$dir" -c core.excludesFile=/dev/null ls-files -ci --exclude-standard)
if [ -z "$hits" ]; then
  echo "ok: no tracked file matches the repo ignore rules"
  exit 0
fi
while IFS= read -r f; do
  rule=$(git -C "$dir" -c core.excludesFile=/dev/null check-ignore -v --no-index "$f" | cut -f1)
  echo "FAIL tracked but ignored: $f ($rule)"
done <<<"$hits"
exit 1
