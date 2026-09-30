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

## Playwright suites (real browser, SDK and keys together)

`connect-flows.spec.ts` and `iframe-transport.spec.ts` run the SDK and the keys
app together through the playground, with Playwright Test. The config starts
both apps (or reuses them if they are already up) and mocks everything they
call on `api.justaname.id`, so no API key and no network are needed.

The passkey is the test's own: a P-256 key held by Chromium's virtual
authenticator, with the matching account seeded in the keys app's local list.
The sign in runs the real WebAuthn ceremony with nobody at the keyboard. That
authenticator is a CDP feature, so the connect flows are Chromium only.

### connect-flows

The happy path (connect, cached connect, sign) and the ways a flow can end
badly. The rule every test holds the apps to is that the dApp always gets an
answer: a dialog that neither answers nor closes leaves it waiting forever,
since neither side times out, so each test bounds that wait.

- An expired connection shows the account screen instead of hanging on the
  loading skeleton, and a sign on a keys session with no signed-in account asks
  to sign in first. Both hung before #360 and #361, and both tests fail on the
  code from before those fixes.
- Closing the account screen, closing the popup window, cancelling a signature,
  a passkey prompt that times out, the RPC failing during sign in and an
  unreachable keys app each end with an error in the dApp, not a hang.
- A request sent while the last dialog is still closing reuses it and shows its
  screen.

### iframe-transport

The embedded iframe in a real browser: `color-scheme: normal` so the dApp shows
through, reveal gating (hidden until a request), no broken frame when the keys
app is unreachable, and the clickjacking guard that keeps an untrusted host on
the popup where the browser cannot prove the iframe is visible
(IntersectionObserver v2 is Chromium only). Runs on chromium, firefox and webkit.

### http and https

The SDK only uses the iframe on an https origin; plain http routes every dialog
to a popup. So by default the suites run over http and the connect flows go
through the popup, and `JAW_E2E_HTTPS=1` serves both apps with
`next dev --experimental-https`, which exercises the iframe instead and enables
`iframe-transport` (skipped over http, where it would test nothing).

```bash
bunx playwright install chromium firefox webkit   # once
bunx nx run-many -t build -p @jaw.id/core @jaw.id/wagmi @jaw.id/ui
cd e2e

bunx playwright test --config playwright.config.ts                     # http: connect flows through the popup
JAW_E2E_HTTPS=1 bunx playwright test --config playwright.config.ts     # https: iframe, all engines
bunx playwright test --config playwright.config.ts -g "expired"        # one test
```

The playground consumes the built dist of the SDK packages, so rebuild them
after changing one. A dev server that was running during a rebuild can keep
serving stale chunks; stop it and delete the app's `.next` if a suite fails in
a way the code does not explain.

The trusted host run asserts the see-through iframe on every engine. It needs
the keys app started with the host allow-listed:

```bash
JAW_TRUSTED_HOSTS=localhost JAW_E2E_HTTPS=1 JAW_E2E_TRUSTED=1 bunx playwright test --config playwright.config.ts iframe-transport
```

### CI

`.github/workflows/e2e.yml` runs `connect-flows` on Chromium over http, against
production builds, on every PR that touches either app, the SDK packages or
`e2e/`, and uploads the report and traces when it fails. The https run on all
three engines is manual (`workflow_dispatch`), with a throwaway certificate
made on the runner.

## Manual QA (real Safari — not coverable headlessly)

Playwright's `webkit` ≈ Safari but isn't identical, and the passkey ceremonies
need a virtual authenticator that only Chromium exposes. Verify on a real Mac +
Safari:

- **Passkey creation** falls back to a popup (Safari blocks `create()` in a cross-origin iframe).
- **Trusted-host iframe** renders see-through (dApp visible around the card) — requires the host to be on the trusted list.
- **Portability**: connect on dApp-A, then on dApp-B (different origin) → Import → **same account address**.

## Overrides

- `JAW_E2E_KEYS_URL` (default `http://localhost:3001`, or https with `JAW_E2E_HTTPS=1`)
- `JAW_E2E_PLAYGROUND_URL` (default `http://localhost:3002`, likewise)
- `JAW_E2E_TLS_CERT`, `JAW_E2E_TLS_KEY`: a certificate for the https run instead of the one `next dev` makes
