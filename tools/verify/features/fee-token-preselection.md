# Fee-token preselection in the signing dialog

When the dApp has no paymaster, the signing dialog lets the owner pay the network fee in the coin (ETH on Base Sepolia) or in an ERC-20 through the JAW paymaster. The dialog opens on a token the account can pay with:

- the coin, when its balance covers the coin fee plus the value the calls send (under a permission, only the fee);
- otherwise the first ERC-20 the paymaster proved can pay (priced, with a balance over its "Up to" ceiling);
- otherwise nothing, with "Insufficient funds" in the fee row and Confirm disabled.

An ERC-20 is offered only when its balance, less what the batch itself moves out of the account in it, covers its "Up to" ceiling. What the batch moves out comes from the dialog's asset preview, once it has simulated; under a permission, or while the preview has not run, the raw balance counts, as before. A token the owner picks stays picked while it is still the one selected. Code: `preselectFeeToken` in `packages/ui/src/utils/feePreselect.ts`, called from `handleEthSuccess` in `packages/ui/src/hooks/useGasEstimation.ts`. Model: `lean/Model/FeePreselect.lean`.

## Sub-features

- The coin covers its fee: the dialog opens on the coin.
- Dust coin, or no coin, plus a payable ERC-20: the dialog opens on the ERC-20.
- Nothing can pay: "Insufficient funds", nothing preselected.
- The owner's pick survives the estimates landing.
- A coin-only list that loads after the first estimate is still checked.
- A native send whose value leaves too little coin for the fee falls to the ERC-20.
- A batch that spends all of an ERC-20 does not offer it for the fee; one that leaves at least its ceiling does. Code: `outflowOf` and `paysAfterOutflow` in `packages/ui/src/utils/feePreselect.ts`.

## How to get to it (user POV)

Playground `/core`, connected, `eth_sendTransaction` with `value` 0 to any address, Execute. In the popup, the "Network fee" row shows the fee and, on the right, the token button. Clicking it opens the "Pay with" list.

## Driving it with the unit tests and the model (layer 1)

```bash
tools/verify/fee-token-checks.sh
```

Proof: `vitest.txt` shows the `useGasEstimation preselects a fee token the account can pay with` and `useGasEstimation offers a fee token only if what the batch leaves of it covers the fee` blocks passing, `ReactUIHandler hands the batch outflow to the fee estimate` passing, plus `preselectFeeToken` agreeing with the Lean vectors. `lean.txt` shows `Model.FeePreselect` built. All six sub-features are covered here, including the two a person cannot easily reach by hand (the late coin-only list and the native send).

## Driving it with a person on Base Sepolia (layer 3)

Needs: both apps running from the commit under test (`SKILL.md`, Launch), `doctor.sh` printing `DOCTOR OK`, a browser with a passkey provider, a second wallet that holds a little Base Sepolia ETH (to send dust), and the Circle faucet (https://faucet.circle.com, Base Sepolia USDC, token `0x036CbD53842c5426634e7929541eC2318f3dCF7e`). Use https://sepolia.basescan.org to read balances. Leave the playground's paymaster panel empty.

For every case: open `/core`, connect, run `eth_sendTransaction` with `to` your own address and `value` `0`, wait until the fee row stops reading "Estimating...", then take a screenshot of the popup showing the fee row and the token button. Cancel unless the case says Confirm.

**Account 1**, a fresh account: in the popup choose to create a new account with a new passkey. Note its address.

1. **No coin, enough USDC.** Send 2 USDC to the address from the Circle faucet. Run the request.
   Expect: the token button shows USDC, the fee row shows a USDC amount with "Up to", Confirm is enabled.
2. **Dust coin, enough USDC.** From the second wallet send 1000 wei (0.000000000000001 ETH) to the address. Run the request.
   Expect: the dialog opens on USDC, not ETH. Confirm is enabled. Press Confirm and sign: the playground log shows `OK`, and basescan shows the USDC balance lower by about the fee.
   This is the case ENGR-1521 fixed. Before the fix the dialog opened on ETH.
3. **Enough coin.** Send 0.001 ETH to the address. Run the request.
   Expect: the dialog opens on ETH, the fee row shows a dollar amount and an ETH amount, and Confirm is enabled.
4. **The owner's pick stays.** Same account, run the request, open "Pay with" and pick USDC as soon as the popup shows the fee row. Wait 30 seconds.
   Expect: USDC is still selected, with its fee and "Up to", and Confirm is enabled.

**Account 2**, another fresh account:

5. **Nothing can pay.** Send it 1000 wei of ETH and nothing else. Run the request.
   Expect: the fee row reads "Insufficient funds" and Confirm is disabled. Picking ETH by hand in "Pay with" keeps it blocked.
6. **A batch that spends all the USDC.** Account 1 again, with ETH and USDC. Run `wallet_sendCalls` with one call, `transfer(<your second wallet>, <the whole USDC balance>)` on the USDC contract, and wait for the asset preview to list the USDC going out.
   Expect: in "Pay with", USDC is greyed out and the dialog is on ETH. Then the same with all but 1 USDC: USDC is offered again.

Proof: five screenshots plus the basescan page for case 2, saved under `tools/verify/evidence/<timestamp>-fee-token/` with the two addresses and the commit (`git rev-parse HEAD`).

## Gotchas

- An account that holds nothing at all gets an empty fee-token list, which the hook cannot tell apart from "fee tokens not offered". It then depends on the bundler rejecting the coin estimate with AA21. Record what the dialog shows for an empty account; it is not one of the five cases.
- The coin is compared with the displayed estimate (gas times the current gas price), as the owner chose. The bundler's prefund uses `maxFeePerGas`, so a coin balance between the estimate and the prefund opens on the coin and can fail with AA21 at send. Case 3 funds well above both.
- The dynamic list only offers ERC-20s the paymaster quotes. If USDC is missing from "Pay with", the paymaster does not quote it on Base Sepolia that day: report that instead of changing the case.
- A dApp with a paymaster sponsors the fee, and the picker disappears. Check the paymaster panel is empty.
- Under `next dev` the first popup compiles the route; a slow first "Estimating..." is not a failure.
