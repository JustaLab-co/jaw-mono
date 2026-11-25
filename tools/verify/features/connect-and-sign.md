# Connect and sign from a dApp

The playground asks for the account with `eth_requestAccounts`, the keys popup signs in with a passkey and returns the address. A later `personal_sign` opens the popup again and returns a signature.

## Sub-features

- First connect with the passkey ceremony.
- Cached connect that answers without a dialog.
- Signing a message after connecting.
- Every way the dialog can end badly (closed window, cancel, passkey timeout, unreachable keys app) returns an error to the dApp instead of hanging.

## How to get to it (user POV)

Open `http://localhost:3002/core`, pick `eth_requestAccounts`, press Execute, sign in in the popup. Then pick `personal_sign` and press Execute.

## Driving it with Playwright

```bash
cd e2e && CI=1 bunx playwright test connect-flows.spec.ts --config playwright.config.ts --project=chromium
```

The suite uses Chromium's virtual authenticator (a P-256 key) and seeds the matching account in the keys app, so no human and no API key are needed. Proof: every test passes in the list reporter, and `signs in with the passkey and returns the account` shows the account returned to the dApp.

## Gotchas

- The virtual authenticator is a CDP feature: Chromium only.
- Under `next dev` the suite is not a clean proof. On a cold cache the first test timed out at 90 seconds waiting for the popup, and `back to back` lost its race: the popup closed before the follow-up request (10 passed, 2 failed; rerun warm, 1 still failed). For a proof, stop the dev servers and run with `CI=1`, which builds both apps and serves them with `next start`, as the e2e workflow does.
- Locally the config reuses servers already on 3001 and 3002. Run `tools/verify/doctor.sh` first so a server from another checkout is not the one under test.
- Over http every dialog is a popup; the embedded iframe needs `JAW_E2E_HTTPS=1`.
