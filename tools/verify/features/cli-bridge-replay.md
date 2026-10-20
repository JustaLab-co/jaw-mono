# Bridge answer replay

`apps/keys-jaw-id/src/app/cli-bridge/page.tsx` is the wallet tab that the jaw CLI and the hosted server ask through the relay. The relay forwards a page frame only while the server's socket is attached, so an answer the owner gives while the server is away is dropped. The page keeps every answer it gave in the relay session: a request repeated under the same id with the same method and params gets that answer again with no new dialog, and the same id with another request is refused with `-32600`. `ready` carries `replays: true`, and a server re-asks only a page that announced it.

## Sub-features

- `replay-flag`: `ready` holds `replays: true`.
- `replay-rejoin`: the server leaves right after asking, the relay drops the answer, the server rejoins the same session and asks again under the same id; the answer arrives.
- `replay-conflict`: the same id with other params answers `success: false` with code `-32600`, never the stored answer.
- `stale-link`: a link whose server went away (a restart of the hosted server, a CLI that exited) gets no `init` within 20 seconds of the key exchange; the page says "This link is no longer active. Ask the agent for a new one." and closes its socket.
- `keyless-link`: a link opened again (a reload, a second tab) has no key, because the page strips it once read; it shows the same message instead of "Connecting to relay..." forever.

## Driving it

Preconditions: Playwright's Chromium installed; the keys app's `connect-src` for `/cli-bridge` allows `ws://localhost:*`, so a local relay works and nothing touches `relay.jaw.id`. Run the relay from the JustaLab-co/jaw-relay source (`PORT=18080 bun src/index.ts` in a checkout).

```bash
(cd apps/keys-jaw-id && bunx next dev -p 13002) &
node tools/verify/bridge-replay.mjs ws://localhost:18080 http://localhost:13002
```

A page with the change prints `"replays":true` on `ready`, `none (the relay dropped it)` after the rejoin, then the answer, then the `-32600` refusal. The same drive against the page before the change prints no `replays` and answers the tampered request with `success: true`, because that page runs every request it gets. Kill the dev server and the relay by the PIDs you started.

### Stale link on the hosted server

Preconditions: the baseline preconditions of the map, Docker running, the local relay on 18080, and the keys app on `next dev` as above with `JAW_CLI_API_KEY` set, so the live link gets past `init`. The hosted server builds its links on that keys app, and `relay-forward.sh` lets the container reach the local relay at the same `ws://localhost:18080` the page uses.

```bash
S=tools/verify
RUN=$($S/up.sh | tail -1)
JAW_KEYS_URL=http://localhost:13002 JAW_RELAY_URL=ws://localhost:18080 $S/hosted-up.sh "$RUN"
$S/relay-forward.sh "$RUN"
node $S/bridge-stale-link.mjs "$RUN"
docker rm -f "$(sed -n 's/^COMPOSE_PROJECT=//p' "$RUN/run.env")-relay-forward"
$S/down.sh "$RUN"
```

The first link, opened while the server is up, shows the app name and "This tab is the signing backend". The second link is taken from the connect page, then the server restarts, then the link opens: after 20 seconds it reads "This link is no longer active. Ask the agent for a new one."
