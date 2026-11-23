# Bridge table

`bun tools/bridge-table/bridge-table.mts` diffs `BRIDGE_CHAINS` in `packages/ui/src/utils/bridgeCalls/contracts.ts` against Across's deployed addresses and Relay's `/chains`, prints an `ok` or `DIFF` line per field and exits 1 on any difference. It needs no install.

`bun tools/bridge-table/bridge-probe.mts` reads real Across quotes through the proxy and Relay quotes through the signing screen's readers and exits 1 if any quote reads as unreadable, or if no Across quote comes back (for example when the proxy is down). It bridges into every Across mainnet chain in the table, out of every chain with a prefunded store, and into NVDA on Robinhood Chain at a Uniswap size and a LiFi size. A mainnet chain it cannot pair prints a `skip` line. `bun test ./tools/bridge-table` checks that pair list without the network, and CI runs it.

`.github/workflows/bridge-table.yml` runs both every day and keeps one open issue while either fails.

`bun tools/bridge-table/export-bridge-table.mts` prints `BRIDGE_CHAINS` as JSON.
