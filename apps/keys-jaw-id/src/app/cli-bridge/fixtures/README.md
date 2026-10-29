# Bridge wire fixtures

Each file here is one message a client really sends to this page, kept as the client sent it. `page.test.tsx` replays every file through the real page, so a change that stops the page from understanding a shape an installed client still sends fails the build.

A file holds `sentBy`, the clients and versions known to send the shape, and one of:

- `frame`: the decrypted inner frame (`init`, `rpc_request`, `shutdown`).
- `fragment`: the link fragment the client appends to the page URL (`pk=<hex>`, plus `&s=<secret>` for clients that prove the link secret).

A fixture is never edited to match the code. If a fixture fails, the page changed: fix the page. The values are fake, but the field names, types and presence come from the client's source.

To add one, read what the client builds (for the CLI, `buildInitPayload`, `request` and the link in `bridge-singleton`; for the hosted server, `connections/relay.ts`) and copy the shape. Never write a fixture from what this page accepts. Add the file and nothing else: the test picks it up.

Retiring a fixture means no installed client sends that shape any more. That is a decision, recorded in the description of the PR that removes the file.
