# JAW Demo

The guided product tour at [demo.jaw.id](https://demo.jaw.id). Three mock consumer apps in a
phone frame. Every CTA opens the **real** keys.jaw.id dialog and sends a **real** request on
Arbitrum Sepolia (421614), with Monerium's sandbox EURe
(`0xFdEed5cE7E281B4e0F163B70eBe2Cf0B10803b7B`, 18 decimals). Gas is paid in EURe through the
JAW ERC-20 paymaster.

## The tour

| #   | Screen            | Request                                                                          |
| --- | ----------------- | -------------------------------------------------------------------------------- |
| 1   | Sign in / Sign up | `eth_requestAccounts` (passkey onboarding), then `/api/fund` sends 5 EURe        |
| 2   | Send (Splitos)    | `wallet_sendCalls`: 2 × 1 EURe transfer, atomic                                  |
| 3   | Agent delegation  | `wallet_grantPermissions` (ERC-7715): 25 EURe/day, 0.01 ETH/month, 30-day expiry |

Each screen pushes its own `JawTheme`, so the dialog is painted like the host app. Sign-in
always disconnects first, so onboarding is demoed fresh.

## Run it

From the repo root:

```bash
bun install
cp apps/demo/.env.example apps/demo/.env.local   # fill in NEXT_PUBLIC_API_KEY
bunx nx dev @jaw-mono/demo
```

`NEXT_PUBLIC_API_KEY` ([dashboard.jaw.id](https://dashboard.jaw.id/)) is the only required
var; dev throws without it. Funding stays off unless `TREASURY_PRIVATE_KEY` is set, and the
treasury needs EURe and a little Arbitrum Sepolia ETH. Analytics stays off unless
`NEXT_PUBLIC_ANALYTICS_ENABLED=true`.

The iframe transport needs a secure context: over plain `http://localhost` the SDK falls back
to the popup on its own, so use `next dev --experimental-https` to exercise the real path.
`.env.example` points `NEXT_PUBLIC_KEYS_URL` at a local keys app on `:3001`.
