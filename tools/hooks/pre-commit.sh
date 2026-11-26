#!/bin/sh
# Lints and typechecks the projects that own the staged files. Their
# dependents and tests are left to pre-push and CI.
# Usage: pre-commit.sh <nx run-many args...>

# During a merge the merged files already passed CI; formatting is enough.
git rev-parse -q --verify MERGE_HEAD >/dev/null && exit 0

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
nx graph --file="$dir/graph.json" >/dev/null || exit 1
projects=$(git diff --cached --name-only -z --diff-filter=ACMR |
  xargs -0 node "$(dirname "$0")/owners.mjs" "$dir/graph.json")
[ -n "$projects" ] || exit 0
nx run-many "$@" -p "$projects"
