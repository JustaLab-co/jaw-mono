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
# Lint and typecheck never read prose, so a docs-only commit runs no Nx.
tr '\0' '\n' <"$dir/staged" | grep -vE '\.(md|mdx|txt)$' | tr '\n' '\0' >"$dir/code"
[ -s "$dir/code" ] || exit 0

# The staged tree, with the installed dependencies linked in. Workspace
# packages resolve to their staged copy.
git checkout-index -a --prefix="$dir/tree/" || exit 1
# A folder find cannot read (a container's bind mount) holds no dependencies
# to link, so its errors are left out.
find "$root" -name .git -prune -o -name node_modules -type d -prune -print >"$dir/modules" 2>/dev/null
node "$here/link-modules.mjs" "$root" "$dir/tree" "$dir/modules" || exit 1
cd "$dir/tree" || exit 1
# From a linked worktree git hands the hook GIT_DIR and friends, which would
# point the init below at the real repository and mark it bare. From here on
# the copy is its own empty repo, which keeps Nx from erroring on git.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY
git init -q || exit 1
# Nx keeps its own database and cache for the copy: sharing the checkout's
# cache folder with a second database lets one evict what the other lists.
# Nx 18 reads the graph cache location from NX_PROJECT_GRAPH_CACHE_DIRECTORY,
# later versions from NX_WORKSPACE_DATA_DIRECTORY.
data="$root/.nx/workspace-data/pre-commit"
export NX_DAEMON=false NX_CACHE_DIRECTORY="$data/cache" \
  NX_WORKSPACE_DATA_DIRECTORY="$data" NX_PROJECT_GRAPH_CACHE_DIRECTORY="$data"

nx graph --file="$dir/graph.json" >/dev/null || exit 1
projects=$(node "$here/owners.mjs" "$dir/graph.json" "$dir/code") || exit 1
[ -n "$projects" ] || exit 0
nx run-many "$@" -p "$projects"
