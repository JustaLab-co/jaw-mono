# Hosted session execute

`jaw_session_execute` in `apps/mcp` sends up to 10 calls as the connection's session key under a custom grant the owner approved with `jaw_grant_permissions`. Nothing is asked of the owner. Before any userOp, `fit` in `src/grants/fit.ts` checks each call against the grant and reads the chain for liveness and what each spend limit has left. A refusal starts with its name: `call-not-allowed`, `over-limit`, `expired` or `no-grant`.

## Sub-features

- `execute-happy`: a USDC transfer inside a custom grant lands, and the account's USDC balance drops by the amount. No wallet link opens.
- `not-allowed`: a call to a target or function the grant does not name returns `call-not-allowed:` and no userOp hash.
- `over-limit`: a batch past what the period has left returns `over-limit:` before sending, naming the token and what is left.
- `expired`: a grant past its end returns `expired:`.
- `no-grant`: an unknown `permissionId`, one revoked, or one on another chain returns `no-grant:`.
- `x402-refused`: the x402 budget's `permissionId` returns `no-grant:` naming it as the x402 budget, which pays x402 only.
- `race`: two executes that together pass the limit. One lands and the other returns `over-limit:`. Runs take the connection's float lock in turn and hold it to the receipt, and a run still `open` in `sends` counts against the next.
- `history`: `jaw_session_history` lists each run under `executes`, one row per token moved, with `userOpHash`, `state` and `txHash`.
- `reconciler`: a run whose receipt did not come back within 60 seconds stays `open` and is handed to the reconciler. `/api/cron/reconcile` settles it `landed` from the EntryPoint `UserOperationEvent`.
- `pay-unaffected`: an x402 payment after an execute still pays from the x402 budget, and the custom grant's counter does not move.
- `revert-mapped`: a permission manager revert after `fit` passed (`UnauthorizedCall`, `ExceededSpendLimit`, `AfterPermissionEnd`) comes back under the same names. Unit tests cover it (`session-execute.test.ts`), since a live drive cannot make the chain disagree with `fit`.

## How to get to it (user POV)

- An MCP client on the hosted server whose connection holds an x402 budget, so the session key has USDC for fees, and a custom grant from `jaw_grant_permissions`.
- `jaw_session_execute` takes `permissionId`, optional `chainId` (the connection's by default) and `calls`, 1 to 10 `{ to, value?, data? }`. `value` is wei as a decimal integer and `data` is hex.
- The result holds `status` (`landed`, `reverted` or `unconfirmed`), `userOpHash`, `txHash` and a `summary`.
- By hand: `node tools/verify/hosted-client.mjs "$MCP_PUBLIC_URL"`, then `execute <permissionId> '<json array>'`.

## Driving it

Preconditions: baseline preconditions of this map; Docker running; `JAW_KEYS_URL=https://keys.jaw.id` and `JAW_MCP_API_KEY` set when the stack starts, per hosted-mcp.md. Base Sepolia USDC is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. The account holds a little USDC, and the connection's x402 budget was approved, so the session key holds its prefund. Dump `sends` and `grants` with psql in the postgres container after each drive.

Set up (Owner lane): `grant '{"calls":[{"target":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","functionSignature":"transfer(address,uint256)"}],"spends":[{"token":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","allowance":"20000","unit":"day"}]}'`, then the owner approves the link. `connections` shows the new `permissionId` as `custom`. The transfer calldata for 0.01 USDC to `<to>` is `cast calldata 'transfer(address,uint256)' <to> 10000`.

- execute-happy: `cast call` USDC `balanceOf(<account>)`, then `execute <id> '[{"to":"0x036C...CF7e","data":"<0.01 USDC to 0x...dEaD>"}]'`, then read the balance again. Pass: `status` `landed` with a `txHash` that Base Sepolia shows, a balance 10000 lower, and no wallet link.
- not-allowed: the same call with `to` set to WETH `0x4200000000000000000000000000000000000006`. Pass: `call-not-allowed:`, no `userOpHash`, no `sends` row.
- over-limit: an amount past what is left today, 20001 on a fresh grant. Pass: `over-limit:` within 1500 ms, no `sends` row.
- expired: grant with `"expiresAt"` 31 minutes out, approve it, wait for its end, execute. Pass: `expired:`.
- no-grant: `execute 0x<64 hex that is no grant> '[...]'`. Pass: `no-grant:`.
- x402-refused: `execute <the x402 budget id from connections> '[...]'`. Pass: `no-grant:` naming the x402 budget.
- race: two clients on the same connection, each sending 0.015 USDC under a 0.02 a day grant, started together. Pass: one `landed`, the other `over-limit:`, one new transfer on chain.
- history: `history` after execute-happy. Pass: `executes` holds the run with its `userOpHash` and `txHash`.
- reconciler: with the stack's bundler slowed or a receipt past 60 seconds, the run answers `unconfirmed`, then `curl -H "Authorization: Bearer $JAW_MCP_CRON_SECRET" "$MCP_PUBLIC_URL/api/cron/reconcile"`. Pass: the report's `sends.landed` counts it and its row reads `landed` with the transaction hash.
- pay-unaffected: `pay <seller url>` after execute-happy. Pass: the payment settles, and `getCurrentPeriod` for the custom grant reads the same spend as before it.
