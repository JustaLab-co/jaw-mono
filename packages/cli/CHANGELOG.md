## 0.2.1 (2026-09-14)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.3.1

## 0.2.0 (2026-09-03)

### 🚀 Features

- **cli:** evaluate the x402 policy against every spend limit ([dd5490e1](https://github.com/JustaName-id/jaw-mono/commit/dd5490e1))
- **cli:** print the approval URL when there is no browser to open ([4d180b44](https://github.com/JustaName-id/jaw-mono/commit/4d180b44))
- **cli:** recover the permission struct for sessions written without one ([d09ed6c2](https://github.com/JustaName-id/jaw-mono/commit/d09ed6c2))
- **cli:** add permissions to a session without taking away its own ([e4008680](https://github.com/JustaName-id/jaw-mono/commit/e4008680))
- **cli:** let a human bound what a grant may ask for ([25a1e03b](https://github.com/JustaName-id/jaw-mono/commit/25a1e03b))
- **cli:** keep hold of the permission a re-setup stops tracking ([ee5c6028](https://github.com/JustaName-id/jaw-mono/commit/ee5c6028))
- **cli:** ask the chain what the period allowance has lost ([27a6b54c](https://github.com/JustaName-id/jaw-mono/commit/27a6b54c))
- **cli:** tell whether the permission is still live on chain ([1a9ecbf9](https://github.com/JustaName-id/jaw-mono/commit/1a9ecbf9))
- **cli:** keep the permission struct the on-chain reads need ([9c71592b](https://github.com/JustaName-id/jaw-mono/commit/9c71592b))
- **cli:** grant Permit2 the allowance an upto payment settles through ([020ade97](https://github.com/JustaName-id/jaw-mono/commit/020ade97))
- **cli:** let a challenge be paid with upto ([9b0350d3](https://github.com/JustaName-id/jaw-mono/commit/9b0350d3))
- **cli:** tell a payment's ceiling apart from its charge ([e69ad007](https://github.com/JustaName-id/jaw-mono/commit/e69ad007))
- **cli:** build and sign the upto payment ([4d38fa46](https://github.com/JustaName-id/jaw-mono/commit/4d38fa46))
- **cli:** pin the upto proxy, the address a permit hands the funds to ([6410a75a](https://github.com/JustaName-id/jaw-mono/commit/6410a75a))
- **cli:** charge every session operation, now that the grant pays for the first ([efe3e211](https://github.com/JustaName-id/jaw-mono/commit/efe3e211))
- **core,cli:** let the grant leave the spender able to pay for its own first op ([2765cf40](https://github.com/JustaName-id/jaw-mono/commit/2765cf40))
- **cli:** make every session EIP-7702, so one account holds the funds and sends the ops ([e52d9e24](https://github.com/JustaName-id/jaw-mono/commit/e52d9e24))
- **cli:** seed the x402 policy from the on-chain grant at session setup ([#263](https://github.com/JustaName-id/jaw-mono/pull/263))
- **cli:** sponsor auto-mode gas by default, no paymaster to configure ([30c309f4](https://github.com/JustaName-id/jaw-mono/commit/30c309f4))
- **cli:** add `jaw x402 log` to read the payment ledger ([0ac88704](https://github.com/JustaName-id/jaw-mono/commit/0ac88704))
- **cli:** add `jaw x402 pay`, dry run by default ([23e299b3](https://github.com/JustaName-id/jaw-mono/commit/23e299b3))
- **cli:** add `jaw x402 status` to check a payment setup without spending ([4f5e215e](https://github.com/JustaName-id/jaw-mono/commit/4f5e215e))
- **cli:** build the x402 permission from a limit instead of by hand ([bbf63d64](https://github.com/JustaName-id/jaw-mono/commit/bbf63d64))
- **cli:** add jaw_discover to search the x402 Bazaar for paid services ([64a88d1d](https://github.com/JustaName-id/jaw-mono/commit/64a88d1d))
- **cli:** sign x402 payments with the ERC-7739 envelope once the session EOA is delegated ([e2ef119b](https://github.com/JustaName-id/jaw-mono/commit/e2ef119b))
- **cli:** opt-in EIP-7702 session mode via jaw session setup --eip7702 ([6e457bd7](https://github.com/JustaName-id/jaw-mono/commit/6e457bd7))
- **cli:** surface top-ups in the pay result and the x402 ledger ([2cb1bb51](https://github.com/JustaName-id/jaw-mono/commit/2cb1bb51))
- **cli:** x402 permission top-up so the payer refills itself on-chain ([0cad7a08](https://github.com/JustaName-id/jaw-mono/commit/0cad7a08))
- **cli:** apply default x402 caps and add a jaw://x402 guide ([5c9038b1](https://github.com/JustaName-id/jaw-mono/commit/5c9038b1))
- **cli:** set the x402 policy via jaw config set (CLI only) ([a9d4fa8f](https://github.com/JustaName-id/jaw-mono/commit/a9d4fa8f))
- **cli:** add jaw_x402_balance to read the payer's USDC balance ([aaef4d63](https://github.com/JustaName-id/jaw-mono/commit/aaef4d63))
- **cli:** persist an x402 payment ledger and expose jaw_x402_log ([10efa114](https://github.com/JustaName-id/jaw-mono/commit/10efa114))
- **cli:** add jaw_pay_and_fetch MCP tool and x402 config block ([084886ec](https://github.com/JustaName-id/jaw-mono/commit/084886ec))
- **cli:** add x402 pull-mode payer and the 402-aware fetch loop ([041f9b13](https://github.com/JustaName-id/jaw-mono/commit/041f9b13))
- **cli:** add x402 payment primitive and policy for agentic payments ([838c3488](https://github.com/JustaName-id/jaw-mono/commit/838c3488))

### 🩹 Fixes

- **cli:** refuse to guess a network for the payer balance ([7ea334ff](https://github.com/JustaName-id/jaw-mono/commit/7ea334ff))
- **cli:** check the asset for readability too, and say which fault it is ([5431f0c4](https://github.com/JustaName-id/jaw-mono/commit/5431f0c4))
- **cli:** refuse an unreadable address instead of re-casing it ([37efc0da](https://github.com/JustaName-id/jaw-mono/commit/37efc0da))
- **cli:** echo an address on the wire only when it round-trips ([90617fd5](https://github.com/JustaName-id/jaw-mono/commit/90617fd5))
- **cli:** finish the wire-casing rule and refuse the zero address ([52d8ebc4](https://github.com/JustaName-id/jaw-mono/commit/52d8ebc4))
- **cli:** refuse a facilitator-less upto challenge before funding it ([dfb9da70](https://github.com/JustaName-id/jaw-mono/commit/dfb9da70))
- **cli:** keep the challenge's own address casing on the x402 wire ([ff7ac09b](https://github.com/JustaName-id/jaw-mono/commit/ff7ac09b))
- **cli:** normalize server-cased addresses before signing x402 payments ([ec928fd7](https://github.com/JustaName-id/jaw-mono/commit/ec928fd7))
- **cli:** bind the Permit2 approval to its executor before handing it on ([69a64bb5](https://github.com/JustaName-id/jaw-mono/commit/69a64bb5))
- **cli:** guard the Date, and resolve the policy after the recovery ([3820c5c8](https://github.com/JustaName-id/jaw-mono/commit/3820c5c8))
- **cli:** report the limits the policy holds, not the ones with usage ([cca1d81e](https://github.com/JustaName-id/jaw-mono/commit/cca1d81e))
- **cli:** stop a missing usage entry from removing a cap ([70ea844c](https://github.com/JustaName-id/jaw-mono/commit/70ea844c))
- **cli:** report every spend limit on the token, not the one we picked ([6ad8b1de](https://github.com/JustaName-id/jaw-mono/commit/6ad8b1de))
- **cli:** stop expiry meaning two things at once ([a91664d6](https://github.com/JustaName-id/jaw-mono/commit/a91664d6))
- **cli:** act on the last review of the permission work ([d6dcfda3](https://github.com/JustaName-id/jaw-mono/commit/d6dcfda3))
- **cli:** act on the review of the E2E and recovery work ([35ede717](https://github.com/JustaName-id/jaw-mono/commit/35ede717))
- **cli:** keep the human-sized wait off the path that opens nothing ([43dfcedf](https://github.com/JustaName-id/jaw-mono/commit/43dfcedf))
- **cli:** raise the wait that actually runs out ([4008c79c](https://github.com/JustaName-id/jaw-mono/commit/4008c79c))
- **cli:** make the approval wait fit the person doing the approving ([28a51306](https://github.com/JustaName-id/jaw-mono/commit/28a51306))
- **cli:** stop the merge from dropping caps nobody named ([3f05f9df](https://github.com/JustaName-id/jaw-mono/commit/3f05f9df))
- **cli:** act on the review of the whole day's work ([57f0ff94](https://github.com/JustaName-id/jaw-mono/commit/57f0ff94))
- **cli:** act on the review of the ceiling and session add ([d97339e7](https://github.com/JustaName-id/jaw-mono/commit/d97339e7))
- **cli:** ship the session add command ([e472a27a](https://github.com/JustaName-id/jaw-mono/commit/e472a27a))
- **cli:** default the other two MCP tools to the session's chain ([587ef929](https://github.com/JustaName-id/jaw-mono/commit/587ef929))
- **cli:** give a permission that can never be revoked a way out ([f72caa80](https://github.com/JustaName-id/jaw-mono/commit/f72caa80))
- **cli:** act on the review of the on-chain permission work ([6b97d66b](https://github.com/JustaName-id/jaw-mono/commit/6b97d66b))
- **cli:** leave a revoke that failed part way through retryable ([0e3168e5](https://github.com/JustaName-id/jaw-mono/commit/0e3168e5))
- **cli:** bound the wait on a permission read ([601ceb15](https://github.com/JustaName-id/jaw-mono/commit/601ceb15))
- **cli:** report a rejected x402 amount the way the rest of the command does ([e439df26](https://github.com/JustaName-id/jaw-mono/commit/e439df26))
- **cli:** look up networks and outcomes by own keys only ([5b477c5f](https://github.com/JustaName-id/jaw-mono/commit/5b477c5f))
- **cli:** read the payer balance on the session's own network ([8f6b6beb](https://github.com/JustaName-id/jaw-mono/commit/8f6b6beb))
- **cli:** refuse a refill the payment cannot be made out of ([cd6a357c](https://github.com/JustaName-id/jaw-mono/commit/cd6a357c))
- **cli:** wait for the granted allowance to be visible, not just confirmed ([506d43c8](https://github.com/JustaName-id/jaw-mono/commit/506d43c8))
- **cli:** the --max-amount refusal was the one still calling a ceiling a price ([6b33d794](https://github.com/JustaName-id/jaw-mono/commit/6b33d794))
- **cli:** keep the Permit2 approval in the trace when no principal moved ([084a7017](https://github.com/JustaName-id/jaw-mono/commit/084a7017))
- **cli:** fund the payer before asking it to pay for its own approval ([688cea13](https://github.com/JustaName-id/jaw-mono/commit/688cea13))
- **cli:** skip an unsettleable upto option instead of dying after paying for it ([c65e716e](https://github.com/JustaName-id/jaw-mono/commit/c65e716e))
- **cli:** refuse a price cap that is not a number ([d1af72cc](https://github.com/JustaName-id/jaw-mono/commit/d1af72cc))
- **cli:** the ceiling labels were right, what they were gated on was not ([c063aa1f](https://github.com/JustaName-id/jaw-mono/commit/c063aa1f))
- **cli:** show a ceiling as a ceiling where a person and an agent read it ([67c909aa](https://github.com/JustaName-id/jaw-mono/commit/67c909aa))
- **cli:** stop the seeding warning from firing at the wrong people ([04fe761f](https://github.com/JustaName-id/jaw-mono/commit/04fe761f))
- **cli:** say when the wallet ignored the request to seed the session ([1af6903d](https://github.com/JustaName-id/jaw-mono/commit/1af6903d))
- **cli:** make a server pay for the budget it spends ([f4954cc3](https://github.com/JustaName-id/jaw-mono/commit/f4954cc3))
- **cli:** disarm tool results at the encoder, not per call site ([7811f8c1](https://github.com/JustaName-id/jaw-mono/commit/7811f8c1))
- **cli:** say what session mode does where the model reads it ([c547189e](https://github.com/JustaName-id/jaw-mono/commit/c547189e))
- **cli:** disarm the paid body the MCP twin hands to the host ([d8538c61](https://github.com/JustaName-id/jaw-mono/commit/d8538c61))
- **cli:** count the period figure in top-ups, not payments ([3772122e](https://github.com/JustaName-id/jaw-mono/commit/3772122e))
- **cli:** report the spend figures as the floor they are ([2a37cb1a](https://github.com/JustaName-id/jaw-mono/commit/2a37cb1a))
- **cli:** disarm the text a tool error hands back ([a441b40c](https://github.com/JustaName-id/jaw-mono/commit/a441b40c))
- **cli:** stop the session key signing whatever it is handed ([fac45108](https://github.com/JustaName-id/jaw-mono/commit/fac45108))
- **core,ui:** price the prefund off the wallet's own paymaster ([2ae91627](https://github.com/JustaName-id/jaw-mono/commit/2ae91627))
- **cli:** refuse to sign rather than guess which signature the account takes ([11ef5b2b](https://github.com/JustaName-id/jaw-mono/commit/11ef5b2b))
- **core,cli:** close two edges the last two commits left open ([1a05732d](https://github.com/JustaName-id/jaw-mono/commit/1a05732d))
- **cli:** sponsor the refill when the sender has no USDC to charge ([cfb2bca3](https://github.com/JustaName-id/jaw-mono/commit/cfb2bca3))
- **cli,keys:** resolve the bridge paymaster once, so its context survives ([fefbeae9](https://github.com/JustaName-id/jaw-mono/commit/fefbeae9))
- **core,cli:** size the approval over the sent userOp, and stop failing silently ([ac01c82e](https://github.com/JustaName-id/jaw-mono/commit/ac01c82e))
- **core,cli:** resolve the paymaster once, so the approval matches the send ([b66338f7](https://github.com/JustaName-id/jaw-mono/commit/b66338f7))
- **cli:** close the payment-lock races and the gaps that lose an audit row ([133da79d](https://github.com/JustaName-id/jaw-mono/commit/133da79d))
- **cli:** meter the period cap by top-ups, since that is what draws it down ([98324358](https://github.com/JustaName-id/jaw-mono/commit/98324358))
- **cli:** bound a top-up by what is left of the caps, not their full width ([c69018a3](https://github.com/JustaName-id/jaw-mono/commit/c69018a3))
- **cli:** the x402 resource description still pointed at the payer ([21a7ddc2](https://github.com/JustaName-id/jaw-mono/commit/21a7ddc2))
- **cli:** read the challenge body once, and say what the top-up's gas costs ([416da551](https://github.com/JustaName-id/jaw-mono/commit/416da551))
- **cli:** bound the body read, shape-check the receipt hash, disarm the deadline ([9559f13e](https://github.com/JustaName-id/jaw-mono/commit/9559f13e))
- **cli:** record the payment inside the lock, not after releasing it ([7400e15e](https://github.com/JustaName-id/jaw-mono/commit/7400e15e))
- **cli:** serialize payments across processes, not just within one ([215e3b80](https://github.com/JustaName-id/jaw-mono/commit/215e3b80))
- **cli:** say when a payment has no top-up behind it ([d7b63263](https://github.com/JustaName-id/jaw-mono/commit/d7b63263))
- **cli:** disarm the ledger read path, not just what gets written to it ([a3101cf8](https://github.com/JustaName-id/jaw-mono/commit/a3101cf8))
- **cli:** close the gaps left by the first sanitizing pass ([d33af38f](https://github.com/JustaName-id/jaw-mono/commit/d33af38f))
- **cli:** stop server-controlled text from forging terminal output ([9c8ca9d4](https://github.com/JustaName-id/jaw-mono/commit/9c8ca9d4))
- **cli:** three inconsistencies between the x402 commands' two output modes ([c4fde0ee](https://github.com/JustaName-id/jaw-mono/commit/c4fde0ee))
- **cli:** recover session setup when the keystore outlives its config ([793d2764](https://github.com/JustaName-id/jaw-mono/commit/793d2764))
- **cli:** accept a decimal spend allowance, matching the SDK ([5c64ca3d](https://github.com/JustaName-id/jaw-mono/commit/5c64ca3d))
- **cli:** tighten MCP tool input validation surfaced by fuzzing ([10ae4848](https://github.com/JustaName-id/jaw-mono/commit/10ae4848))
- **cli:** bound x402 network waits so a hung server can't wedge all payments ([518cceb5](https://github.com/JustaName-id/jaw-mono/commit/518cceb5))
- **cli:** serialize the x402 spend cap and harden against server-driven failures ([a5314c5c](https://github.com/JustaName-id/jaw-mono/commit/a5314c5c))
- **cli:** close the redirect-downgrade bypass on the x402 https gate ([8ef93a65](https://github.com/JustaName-id/jaw-mono/commit/8ef93a65))
- **cli:** refuse to sign x402 payments over cleartext http ([3115aa17](https://github.com/JustaName-id/jaw-mono/commit/3115aa17))
- **cli,core:** review follow-ups for the ERC-7739 wrapped signer ([04ea5e3f](https://github.com/JustaName-id/jaw-mono/commit/04ea5e3f))
- **cli:** warn that x402 pull payments break once an eip7702 session delegates ([806d9b18](https://github.com/JustaName-id/jaw-mono/commit/806d9b18))
- **cli:** count failed settlements toward the x402 session cap ([26f974e3](https://github.com/JustaName-id/jaw-mono/commit/26f974e3))
- **cli:** harden the x402 payment path against untrusted challenges ([0a35ca74](https://github.com/JustaName-id/jaw-mono/commit/0a35ca74))
- **cli:** bound the top-up float and harden amount parsing ([d5afdbb7](https://github.com/JustaName-id/jaw-mono/commit/d5afdbb7))
- **cli:** store topUpFloat as a scalar, not an array ([28a62db0](https://github.com/JustaName-id/jaw-mono/commit/28a62db0))
- **cli:** keep the top-up trace when funding is refused after broadcast ([b988fcc3](https://github.com/JustaName-id/jaw-mono/commit/b988fcc3))
- **cli:** read the call id from the sendCalls result object ([218927ad](https://github.com/JustaName-id/jaw-mono/commit/218927ad))
- **cli:** refuse cross-chain and wrong-asset top-ups ([71ff6ea1](https://github.com/JustaName-id/jaw-mono/commit/71ff6ea1))
- **cli:** make topUpFloat settable via jaw config set ([cfa51a5a](https://github.com/JustaName-id/jaw-mono/commit/cfa51a5a))
- **cli:** call registerTool for jaw_config_set through an explicit signature ([2dcf55e0](https://github.com/JustaName-id/jaw-mono/commit/2dcf55e0))
- **cli:** widen the EIP-3009 authorization window so settlement doesn't expire ([e15ab0bd](https://github.com/JustaName-id/jaw-mono/commit/e15ab0bd))
- **cli:** surface the x402 re-challenge error, not a bare status ([7f8bdb20](https://github.com/JustaName-id/jaw-mono/commit/7f8bdb20))
- **cli:** address x402 review findings ([da3c22c6](https://github.com/JustaName-id/jaw-mono/commit/da3c22c6))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.3.0

### ❤️ Thank You

- Claude Code
- Ghadi Mhawej
- Mariano Aguero @mariano-aguero

## 0.1.26 (2026-08-20)

### 🩹 Fixes

- **repo:** relicense under apache-2.0 and drop dos chain ([#287](https://github.com/JustaName-id/jaw-mono/pull/287))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.2.3

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.1.25 (2026-08-19)

### 🩹 Fixes

- **ui:** measure asset preview with viem's traceAssetChanges ([#270](https://github.com/JustaName-id/jaw-mono/pull/270))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.2.2

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.1.24 (2026-08-19)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.2.1

## 0.1.23 (2026-08-17)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.2.0

## 0.1.22 (2026-08-05)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.1.4

## 0.1.21 (2026-08-04)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.1.3

## 0.1.20 (2026-07-30)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.1.2

## 0.1.19 (2026-07-28)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.1.1

## 0.1.18 (2026-07-27)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.1.0

## 0.1.17 (2026-07-16)

### 🩹 Fixes

- **cli:** bring MCP server in sync with CLI capabilities ([#230](https://github.com/JustaName-id/jaw-mono/pull/230))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.1.16 (2026-07-16)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.9

## 0.1.15 (2026-07-16)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.8

## 0.1.14 (2026-07-15)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.7

## 0.1.13 (2026-07-10)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.6

## 0.1.12 (2026-07-06)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.5

## 0.1.11 (2026-07-02)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.4

## 0.1.10 (2026-06-23)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.3

## 0.1.9 (2026-06-23)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.2

## 0.1.8 (2026-06-22)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.1

## 0.1.7 (2026-06-22)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.0

## 0.1.6 (2026-06-16)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.5

## 0.1.5 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.4

## 0.1.4 (2026-06-11)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.3

## 0.1.3 (2026-06-04)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.2

## 0.1.2 (2026-06-04)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.1

## 0.1.1 (2026-05-08)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.0

## 0.1.0 (2026-05-05)

### 🚀 Features

- **cli:** added auto mode ([#164](https://github.com/JustaName-id/jaw-mono/pull/164), [#175](https://github.com/JustaName-id/jaw-mono/issues/175))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.3.0

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.0.8 (2026-04-27)

### 🩹 Fixes

- **core:** added MIT license ([#171](https://github.com/JustaName-id/jaw-mono/pull/171))

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.0.7 (2026-03-13)

### 🩹 Fixes

- **cli:** use fresh bridge per MCP tool call instead of caching ([#146](https://github.com/JustaName-id/jaw-mono/pull/146))

### ❤️ Thank You

- AngeloAyranji @AngeloAyranji

## 0.0.6 (2026-03-11)

### 🩹 Fixes

- **cli:** dependency ([#143](https://github.com/JustaName-id/jaw-mono/pull/143))

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.0.5 (2026-03-11)

### 🩹 Fixes

- **cli:** new cli architecture using a relay as blind pipe ([#141](https://github.com/JustaName-id/jaw-mono/pull/141), [#142](https://github.com/JustaName-id/jaw-mono/issues/142))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.0.4 (2026-03-11)

### 🩹 Fixes

- **cli:** oclif error ([#139](https://github.com/JustaName-id/jaw-mono/pull/139))

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.0.3 (2026-03-10)

### 🩹 Fixes

- **cli:** preflight handling ([#138](https://github.com/JustaName-id/jaw-mono/pull/138))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.0.2 (2026-03-10)

### 🩹 Fixes

- **cli, core:** add @jaw.id/cli package with MCP server and browser auth ([#136](https://github.com/JustaName-id/jaw-mono/pull/136), [#134](https://github.com/JustaName-id/jaw-mono/issues/134))

### ❤️ Thank You

- Ghadi @Ghadi8