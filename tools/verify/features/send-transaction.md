# Send a transaction from a dApp

The playground sends `eth_sendTransaction` (or `wallet_sendCalls`), the keys popup shows `TransactionModal`: the calls, the asset changes, the network fee row and Confirm. Confirm signs with the passkey and submits a userOp through the bundler.

## Sub-features

- Single call and batched calls.
- Network fee in the coin, or in an ERC-20 through the paymaster (see [fee-token-preselection.md](fee-token-preselection.md)).
- Sponsored fee when the dApp configures a paymaster (playground: the paymaster panel). Then the fee row reads "Sponsored" and there is no token picker.

## How to get to it (user POV)

With both apps running and `.env.local` set as `SKILL.md` describes, open `http://localhost:3002/core`, connect, pick `eth_sendTransaction`, set `to` to an address (your own is fine) and `value` to `0`, press Execute.

## Driving it with a person on Base Sepolia

There is no mocked bundler, so a person runs this with a funded Base Sepolia account. Proof: after Confirm, the playground log shows `OK` with a hash, and the transaction appears on https://sepolia.basescan.org under the account address.

## Gotchas

- Leave the paymaster panel empty. With a paymaster set the fee is sponsored and the token picker never appears.
- The first popup load compiles the route under `next dev`; wait for "Network fee" to leave "Estimating...".
