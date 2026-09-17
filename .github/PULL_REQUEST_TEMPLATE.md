## What

<!-- One or two sentences: what changes, from the point of view of whoever uses it. -->

## Why

<!-- The problem behind the change, and the reasoning a reader cannot get from the diff.
     This is where it belongs, rather than in a code comment. -->

Closes

## How to test

<!-- Replace <project> with the package you touched: @jaw.id/core, @jaw.id/cli,
     @jaw.id/wagmi, @jaw.id/ui, @jaw-mono/playground, docs. -->

```bash
bun install
bunx nx run-many -t typecheck lint test --projects=<project>
bunx nx build <project>
```

<!-- Plus whatever has to be checked by hand: a command and the output it should print,
     a screen, a transaction on a testnet. Say what a reviewer should see, not just what to run. -->

## Checklist

- [ ] The title is a conventional commit and reads as the subject it becomes on squash. `nx release` takes the version bump from its type
- [ ] `bunx prettier --check .` and `bunx nx affected -t lint test typecheck build api-check` pass, which is what CI runs
- [ ] `@jaw.id/core`'s public API is unchanged, or `bunx nx api-update @jaw.id/core` ran and the report diff is part of this PR
- [ ] Docs updated, if this changes behaviour somebody integrates against
