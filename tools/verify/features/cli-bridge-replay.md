# Bridge answer replay

`apps/keys-jaw-id/src/app/cli-bridge/page.tsx` is the wallet tab that the jaw CLI and the hosted server ask through the relay. The relay forwards a page frame only while the server's socket is attached, so an answer the owner gives while the server is away is dropped. The page keeps every answer it gave in the relay session: a request repeated under the same id with the same method and params gets that answer again with no new dialog, and the same id with another request is refused with `-32600`. `ready` carries `replays: true`, and a server re-asks only a page that announced it.

## Sub-features

- `replay-flag`: `ready` holds `replays: true`.
- `replay-rejoin`: the server leaves right after asking, the relay drops the answer, the server rejoins the same session and asks again under the same id; the answer arrives.
- `replay-conflict`: the same id with other params answers `success: false` with code `-32600`, never the stored answer.

## Driving it

Preconditions: Playwright's Chromium installed; the keys app's `connect-src` for `/cli-bridge` allows `ws://localhost:*`, so a local relay works and nothing touches `relay.jaw.id`. Run the relay from the JustaLab-co/jaw-relay source (`PORT=18080 bun src/index.ts` in a checkout).

```bash
(cd apps/keys-jaw-id && bunx next dev -p 13002) &
node tools/verify/bridge-replay.mjs ws://localhost:18080 http://localhost:13002
```

A page with the change prints `"replays":true` on `ready`, `none (the relay dropped it)` after the rejoin, then the answer, then the `-32600` refusal. The same drive against the page before the change prints no `replays` and answers the tampered request with `success: true`, because that page runs every request it gets. Kill the dev server and the relay by the PIDs you started.
