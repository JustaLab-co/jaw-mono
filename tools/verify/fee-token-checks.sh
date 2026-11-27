#!/usr/bin/env bash
# The automated proof of the fee-token preselection: the hook and pure-function tests, and the
# Lean model when a Lean toolchain is installed. Output goes to evidence/<timestamp>/.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
out="$root/tools/verify/evidence/$(date +%Y%m%d-%H%M%S)-fee-token"
mkdir -p "$out"
git -C "$root" rev-parse HEAD > "$out/commit.txt"

(cd "$root/packages/ui" && bunx vitest run src/hooks/useGasEstimation.test.ts src/utils/feePreselect.test.ts) \
  2>&1 | tee "$out/vitest.txt" | grep -E "Test Files|Tests "

if command -v lake >/dev/null 2>&1 || [ -x "$HOME/.elan/bin/lake" ]; then
  export PATH="$HOME/.elan/bin:$PATH"
  (cd "$root/lean" && lake build Model.FeePreselect) > "$out/lean.txt" 2>&1 \
    && echo "lean      Model.FeePreselect builds (proofs and #guard checks hold)" \
    || { echo "lean      FAILED, see $out/lean.txt"; exit 1; }
  if grep -q "declaration uses 'sorry'" "$out/lean.txt"; then echo "lean      unfinished proof (sorry)"; exit 1; fi
else
  echo "lean      not checked: no Lean toolchain (install elan)" | tee "$out/lean.txt"
fi

echo "evidence  $out"
