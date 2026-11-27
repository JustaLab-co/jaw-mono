#!/bin/sh
# Lints and typechecks the projects that own the staged files. It runs on a
# copy of the index, so unstaged edits and untracked files neither hide nor
# cause an error. Their dependents and tests are left to pre-push and CI.
# Usage: pre-commit.sh <nx run-many args...>

# During a merge the merged files already passed CI; formatting is enough.
git rev-parse -q --verify MERGE_HEAD >/dev/null && exit 0

here=$(cd "$(dirname "$0")" && pwd)
root=$(git rev-parse --show-toplevel)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
# Deletions and both sides of a move count: what is left behind may break.
git diff --cached --name-only -z --no-renames --diff-filter=ACMRD >"$dir/staged"
[ -s "$dir/staged" ] || exit 0

# The staged tree, with the installed dependencies linked in. The Nx cache is
# shared, since its keys hash the inputs it reads.
git checkout-index -a --prefix="$dir/tree/"
find "$root" -name .git -prune -o -name node_modules -type d -prune -print |
  while read -r modules; do
    target="$dir/tree/${modules#"$root"/}"
    mkdir -p "$(dirname "$target")" && ln -s "$modules" "$target"
  done
cd "$dir/tree" || exit 1
export NX_DAEMON=false NX_CACHE_DIRECTORY="$root/.nx/cache"

nx graph --file="$dir/graph.json" >/dev/null || exit 1
projects=$(node "$here/owners.mjs" "$dir/graph.json" "$dir/staged") || exit 1
[ -n "$projects" ] || exit 0
nx run-many "$@" -p "$projects"
