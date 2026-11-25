# Feature map

One file per user-facing feature: what it is, how a person reaches it, how to drive it, and what end state proves it. Start a proof from the feature's file and drive every entry point it lists.

| Feature                                      | File                                                   | Layers |
| -------------------------------------------- | ------------------------------------------------------ | ------ |
| Connect and sign from a dApp                 | [connect-and-sign.md](connect-and-sign.md)             | 2      |
| Send a transaction from a dApp               | [send-transaction.md](send-transaction.md)             | 3      |
| Fee-token preselection in the signing dialog | [fee-token-preselection.md](fee-token-preselection.md) | 1, 3   |

Not mapped yet: permission grants and revokes (`PermissionModal`), the CLI bridge (`/cli-bridge`, covered by `e2e/cli-bridge.spec.ts` and the wire-contract fixtures), the embedded iframe transport (`e2e/iframe-transport.spec.ts`).
