# Bridge wire fixtures

Each file here is one message a client really sends to this page, kept as the client sent it. `wire-contract.test.tsx` replays every file through the real page, so a change that stops the page from understanding a shape an installed client still sends fails the build.

A file holds `sentBy`, the clients and versions known to send the shape, and one of:

- `frame`: the decrypted inner frame (`init`, `rpc_request`, `shutdown`), with an `expect` block saying what the page must do with it. For an `init`: `appName`, `defaultChainId`, `apiKey` and `ens` and `paymasters` as the SDK receives them, `readyApiKey` when the page hands a key back, and `client` when the page reports it. For an `rpc_request`: `params`, what the provider receives.
- `fragment` and `query`: the link fragment (`pk=<hex>`, plus `&s=<secret>` for clients that prove the link secret) and the query (`session=<id>&relay=<url>`) the client puts on the page URL. `expect.proof` says whether the key exchange must carry a proof.

`manifest.json` lists the fixture files. The test fails when it and the folder differ, so adding or deleting a fixture is a change to the manifest in the same PR.

A fixture is never edited to match the code. If a fixture fails, the page changed: fix the page. The values are fake, but the field names, types and presence come from the client's source. The `pk` in the link fixtures is a throwaway public key generated for them, and `s` is a made-up secret.

## Where the shapes come from

In `JustaLab-co/jaw-agent`:

- `packages/cli/src/lib/ws-bridge.ts`: `buildInitPayload` and `request`.
- `packages/cli/src/lib/bridge-singleton.ts`: the link.
- `apps/mcp/src/connections/relay.ts`: the MCP init, the link and the request ids.

Old CLI versions are in the published `@jaw.id/cli` npm tarballs. Read the shape there, not from the current source.

To add one, copy what the client builds. Never write a fixture from what this page accepts. A new frame type also needs a test case in `wire-contract.test.tsx` and an entry in its list of handled types.

## Support floor and retirement

The page supports `@jaw.id/cli` 0.4.0 and later, and every `@jaw-mono/mcp` image still deployable. A published shape is retired only with a minimum supported CLI version announced in the CLI release notes. Shapes from clients that send `client` can be retired when the `bridge client` logs show none for 30 days. Retiring a fixture is recorded in the description of the PR that removes it.
