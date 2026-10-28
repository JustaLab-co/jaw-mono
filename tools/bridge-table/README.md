# Bridge table

`bun tools/bridge-table/bridge-table.mts` diffs `BRIDGE_CHAINS` in `packages/ui/src/utils/bridgeCalls/contracts.ts` against Across's deployed addresses and Relay's `/chains`, prints an `ok` or `DIFF` line per field and exits 1 on any difference. It needs no install.

`bun tools/bridge-table/bridge-probe.mts` reads real quotes from both APIs through the signing screen's readers and exits 1 if any quote reads as unreadable.

`.github/workflows/bridge-table.yml` runs both every day and keeps one open issue while either fails.

`bun tools/bridge-table/export-bridge-table.mts` prints `BRIDGE_CHAINS` as JSON.
