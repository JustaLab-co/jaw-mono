# E2E

Two scripts, neither part of `nx test`: both need something the test suite
deliberately does not have, a running dev server or a live chain.

## published (installed packages, runs in CI)

Packs core, wagmi, ui and cli, publishes them to a Verdaccio registry on
`localhost:4873` under a prerelease version made for the run
(`<version>-e2e.<timestamp>`), installs them into projects outside the workspace
and checks what an integrator gets. Inside the workspace every import resolves
to `src/` through the `@jaw-mono/source` condition, so the unit tests never see
the tarballs, the exports map or the CJS build.

The run version cannot exist on npm, and every installed `@jaw.id` package must
report it, so a copy of the same release from npm cannot pass for the local
build. The released tarballs have the same bytes, so comparing files would not
tell them apart.

Core and cli are each installed alone first, so a runtime dependency that only
resolves because a sibling package installs it fails there. Then all four go
into one project, which checks that each package imports under Node, that
core's CJS build exports the same names as its ESM one, that wagmi and ui refuse
`require` with their ESM-only message, that every relative path in the
published declarations exists, that the types resolve for a bundler-style
consumer, and that the `jaw` binary runs, ships its oclif manifest and lists
its commands.

```bash
bunx nx run published-e2e:e2e   # builds the four packages first
```

CI runs it through `nx affected`, whenever one of the four packages or
`.verdaccio/config.yml` changes. Each run gets its own registry storage, and
`@jaw.id/*` is never proxied to npm. Nothing leaves the machine: publish and
installs run with their own home directory and npm userconfig, so `~/.npmrc`
and any registry override in it are never read.

## permission-onchain (real chain)

Asks the deployed `JustaPermissionManager` on the session's chain whether the
struct the CLI rebuilds hashes to the permission that was granted, and whether
the period window it computes locally is the one the contract is in. Read-only:
`eth_call` plus one relay GET, no signing and no spending.

It exists because the unit tests verify that the code does what its author
believed the contract does, and that belief was wrong twice while this was being
written. A test written from the same belief agrees with it; the chain does not.

```bash
bun e2e/permission-onchain.e2e.ts
```

Needs a live session in `~/.jaw` on a chain in the USDC registry and an apiKey
in `~/.jaw/config.json`. A session from before the CLI stored the struct works:
the script recovers it from the relay, the same way the CLI now does.

## session-flow (real chain, real approval)

Runs `session setup`, `session add`, `x402 status` and `session revoke` against
Base Sepolia and checks the on-chain effect of each one. Semi-automated: it
drives the CLI and the assertions, prints the approval URL, and waits for you to
approve with your own passkey.

Driving the approval would need a passkey the test owns, which means an account
it created, which the API key cannot register (it manages no ENS domains) and
which would hold no USDC to fund a grant with. A person with a funded account is
the cheaper answer.

```bash
bunx nx build @jaw.id/cli
bun e2e/session-flow.e2e.ts
JAW_E2E_STEPS=setup,status bun e2e/session-flow.e2e.ts   # a subset
JAW_E2E_NO_BROWSER=1 bun e2e/session-flow.e2e.ts         # print the URL instead
```

The CLI opens the browser itself, which is what you want when you are sitting in
front of it. `JAW_E2E_NO_BROWSER=1` prints the URL instead, for a machine with no
browser to open. Both waits on a person are raised to fifteen minutes;
`JAW_E2E_APPROVAL_MS` changes that.

Each run gets a fresh scratch home. Pass `JAW_E2E_HOME=<dir>` to reuse one, which
is how a run picks up where an earlier one stopped: the steps each need a person,
and the session one creates is the input to the next.

Every command runs with `HOME` pointed at a throwaway directory, so it reads and
writes a scratch `~/.jaw` and your own session is untouched. It does spend: each
grant carries a small USDC prefund to the session, and the grant and revoke cost
gas, paid by the account you approve with.

## iframe-transport (real browser)

A minimal real-browser check for the embedded iframe transport — covers what
jsdom/unit tests cannot (real CSS compositing and the browser's iframe
`color-scheme` canvas behavior). Runs on **chromium, firefox, and webkit**
(webkit ≈ Safari).

It is intentionally **not** part of `nx test`: it needs the two dev servers
running. It does **not** drive the passkey/connect flow, so it is deterministic,
cross-engine, and needs **no API key** — only the prewarmed, load-time iframe
state. (The passkey ceremonies need a virtual authenticator that only Chromium
exposes, so they are covered by Chromium-only tests + manual QA on real Safari.)

## Run

1. Start the keys app:

   ```bash
   bunx nx dev @jaw-mono/keys-jaw-id --port=3001
   ```

2. Start the playground pointing at the local keys app:

   ```bash
   NEXT_PUBLIC_KEYS_URL=http://localhost:3001 bunx nx dev @jaw-mono/playground --port=3002
   ```

3. Run the E2E (defaults to chromium):

   ```bash
   node e2e/iframe-transport.e2e.mjs
   # or pick an engine:
   JAW_E2E_BROWSER=firefox node e2e/iframe-transport.e2e.mjs
   JAW_E2E_BROWSER=webkit  node e2e/iframe-transport.e2e.mjs
   ```

   Install the engines once with `bunx playwright install chromium firefox webkit`.

Exits `0` on pass, `1` on failure or unmet prerequisites.

## CI

`.github/workflows/e2e.yml` builds the SDK packages (the playground consumes the
built dist, not source), starts both dev servers, and runs the **default** and
**keys-down (error)** modes across chromium/firefox/webkit. Triggers on PRs
touching the transport, the keys app, the playground, or `e2e/`, and via manual
`workflow_dispatch`.

## What it asserts

Scenario: **OS in dark mode, playground forced to light.** Assertions are
**engine-aware** — the clickjacking guard only lets an _untrusted_ host
embed the iframe on browsers that can verify visibility via **IntersectionObserver
v2, which is Chromium-only**.

### Errors / guards (the priority — these catch the dangerous regressions)

- **Firefox / WebKit, untrusted host** → the SDK must **not** embed; it falls back to the popup (security gate).
- **Keys unreachable** (`JAW_E2E_KEYS_DOWN=1`, blocks the keys origin) → **no broken embedded frame is ever shown** (reveal gating) and **the dApp does not hang**.
- **Reveal gating** (Chromium) → even after the handshake, the prewarmed iframe stays **hidden** until an actual request — the user never sees it unprompted.

### Success path (Chromium, prewarmed iframe)

1. The embedded iframe is the **default** transport (mounted on load, pointed at the keys app).
2. The iframe element keeps **`color-scheme: normal`** so the browser does not paint an opaque canvas — the host dApp stays visible (see-through regression guard).
3. The iframe runs in **embedded mode** (`jaw-embedded`).
4. **Theme sync**: the embedded dialog follows the dApp's light mode (no `.dark`), not the OS.
5. The embedded document body is **transparent**.

> **Implication:** the see-through embedded iframe is available to every host on
> Chromium, but only to **trusted (allow-listed) partners** on Firefox/Safari;
> everyone else gets the popup. See `packages/core/src/trusted-hosts.ts`.

## Trusted-host fixture (see-through on every engine)

To validate that the see-through iframe renders on Firefox/WebKit too, start the
keys app with the host allow-listed and run in trusted mode (drives a connect to
mount the iframe — stops before the passkey ceremony, so no API key/authenticator
is needed):

```bash
JAW_TRUSTED_HOSTS=localhost bunx nx dev @jaw-mono/keys-jaw-id --port=3001
# then, against the running playground:
JAW_E2E_BROWSER=webkit  JAW_E2E_TRUSTED=1 node e2e/iframe-transport.e2e.mjs
JAW_E2E_BROWSER=firefox JAW_E2E_TRUSTED=1 node e2e/iframe-transport.e2e.mjs
```

It asserts the transport-level see-through core (iframe mounted, `color-scheme:
normal`, embedded mode). Theme/transparency details are asserted only in the
stable prewarm path — in the connect-driven path the dApp's per-engine theme
resolution and frame-render timing make them flaky, not the transport. Kept out
of CI (the connect drive is less stable than the load-time checks).

## Manual QA (real Safari — not coverable headlessly)

Playwright's `webkit` ≈ Safari but isn't identical, and the passkey ceremonies
need a virtual authenticator that only Chromium exposes. Verify on a real Mac +
Safari:

- **Passkey creation** falls back to a popup (Safari blocks `create()` in a cross-origin iframe).
- **Trusted-host iframe** renders see-through (dApp visible around the card) — requires the host to be on the trusted list.
- **Portability**: connect on dApp-A, then on dApp-B (different origin) → Import → **same account address**.

## Overrides

- `JAW_E2E_KEYS_URL` (default `http://localhost:3001`)
- `JAW_E2E_PLAYGROUND_URL` (default `http://localhost:3002`)
