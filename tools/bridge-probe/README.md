# Bridge probe

`node tools/bridge-probe/probe.mjs --keys <origin> --relay <ws url> [--clients 3|0.6,0.7]` checks that a keys deployment still speaks the bridge protocol to real clients. It needs `bun install` (for Playwright, with Chromium installed through `bunx playwright install chromium`) and `npm`. It prints one `ok:`, `fail:` or `infra:` line per check and ends within 5 minutes. Exit codes: 0 every check passed, 1 at least one `fail:` (a bridge regression), 2 bad arguments, 3 only `infra:` lines (npm, the relay or Chromium unavailable, so the result says nothing about the bridge). Links are logged with `pk` and `s` redacted.

## What it checks

- `page proves the link`: the page's key exchange carries the HMAC proof for the secret in the link fragment.
- `page answers eth_chainId`: with that session, `init` gets `ready`, and `eth_chainId` gets `0x14a34`.
- `page refuses an init without chainId`: the page answers with an `error` frame whose reason starts with `Unsupported chainId`.
- `<version> answered eth_chainId`: the latest patch of each of the last three minors of `@jaw.id/cli` is installed from npm into a temporary prefix, with a temporary `HOME`, and runs `jaw rpc call eth_chainId --chain 84532`. The probe opens the link the CLI prints (`JAW_NO_BROWSER=1`) in Chromium and expects the CLI to exit 0 and print the chain id as its last stdout line.

`--clients` takes a count of minors of 1 or more (default 3) or a list such as `0.6,0.7`. The page checks run whether or not npm answers.

The CLI accepts only a `*.jaw.id` keys origin, so it is configured with `https://keys.jaw.id` and the probe swaps the origin of the printed link for `--keys`. The relay is passed to the CLI through its config.

## When to run it

By hand, before merging a change to `apps/keys-jaw-id/src/app/cli-bridge`, `packages/core` or anything else the bridge uses: run it against the PR's keys preview (add the `preview` label to get one) and against `https://keys.jaw.id`, with `--relay wss://relay.jaw.id`. A preview that fails where production passes is a regression in the PR.

## Reading a failure

- `page ... answered 401` or `403`: the URL is behind Vercel deployment protection. The probe has no bypass.
- `page proves the link` fails alone: the deployed keys build predates the proof, or the link secret is no longer used.
- `no key_exchange from the page`: the page loaded but never joined the relay. Check the relay origin against the page's `connect-src` and the relay's health.
- `infra: ... refused the connection`: the relay is down or the URL is wrong.
- `<version> did not answer eth_chainId`: the reason carries the CLI's exit code and last output. If only the oldest version fails, a keys or core change dropped support for it.
- `did not finish within 5 minutes`: something hung. The step that did not log yet is the one stuck.
