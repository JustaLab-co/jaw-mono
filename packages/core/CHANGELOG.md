## 1.3.1 (2026-09-14)

### 🩹 Fixes

- add support for Unichain and Hyvechain ([#336](https://github.com/JustaName-id/jaw-mono/pull/336))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.3.0 (2026-09-03)

### 🚀 Features

- **core,cli:** let the grant leave the spender able to pay for its own first op ([2765cf40](https://github.com/JustaName-id/jaw-mono/commit/2765cf40))

### 🩹 Fixes

- **core:** size the paymaster approval over the batch the prefund is in ([ea8d3056](https://github.com/JustaName-id/jaw-mono/commit/ea8d3056))
- **core:** send an even yParity as one byte, the way the send path does ([0bd189b7](https://github.com/JustaName-id/jaw-mono/commit/0bd189b7))
- **core:** take the tightest allowance as the prefund ceiling ([9958a38c](https://github.com/JustaName-id/jaw-mono/commit/9958a38c))
- **core:** take the widest allowance when a token carries several periods ([e1726a10](https://github.com/JustaName-id/jaw-mono/commit/e1726a10))
- **core:** bound the prefund by what the permission lets the session spend ([3831454d](https://github.com/JustaName-id/jaw-mono/commit/3831454d))
- **core,ui:** price the prefund off the wallet's own paymaster ([2ae91627](https://github.com/JustaName-id/jaw-mono/commit/2ae91627))
- **core,cli:** close two edges the last two commits left open ([1a05732d](https://github.com/JustaName-id/jaw-mono/commit/1a05732d))
- **core:** decide the prefund fee against the token it actually sends ([340a57bb](https://github.com/JustaName-id/jaw-mono/commit/340a57bb))
- **core:** stop the approval from going missing or to the wrong spender ([93a67eb8](https://github.com/JustaName-id/jaw-mono/commit/93a67eb8))
- **core,cli:** size the approval over the sent userOp, and stop failing silently ([ac01c82e](https://github.com/JustaName-id/jaw-mono/commit/ac01c82e))
- **core,cli:** resolve the paymaster once, so the approval matches the send ([b66338f7](https://github.com/JustaName-id/jaw-mono/commit/b66338f7))
- **cli,core:** review follow-ups for the ERC-7739 wrapped signer ([04ea5e3f](https://github.com/JustaName-id/jaw-mono/commit/04ea5e3f))
- **core:** expose the EIP-7702 authorization on the smart account ([baa76467](https://github.com/JustaName-id/jaw-mono/commit/baa76467))
- **core:** carry the EIP-7702 authorization through paymaster gas estimation ([d204986f](https://github.com/JustaName-id/jaw-mono/commit/d204986f))

### ❤️ Thank You

- Claude Code
- Ghadi Mhawej
- Mariano Aguero @mariano-aguero

## 1.2.3 (2026-08-20)

### 🩹 Fixes

- **repo:** relicense under apache-2.0 and drop dos chain ([#287](https://github.com/JustaName-id/jaw-mono/pull/287))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.2.2 (2026-08-19)

### 🩹 Fixes

- **ui:** measure asset preview with viem's traceAssetChanges ([#270](https://github.com/JustaName-id/jaw-mono/pull/270))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.2.1 (2026-08-19)

### 🩹 Fixes

- theme configuration across screens ([#286](https://github.com/JustaName-id/jaw-mono/pull/286))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.2.0 (2026-08-17)

### 🚀 Features

- keys ui revamp ([#248](https://github.com/JustaName-id/jaw-mono/pull/248))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.1.4 (2026-08-05)

### 🩹 Fixes

- **core:** accept EIP-5792 v2.0.0 wallet_sendCalls envelopes explicitly ([#260](https://github.com/JustaName-id/jaw-mono/pull/260))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.1.3 (2026-08-04)

### 🩹 Fixes

- **core:** pass proper chain block time to client config ([#257](https://github.com/JustaName-id/jaw-mono/pull/257))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.1.2 (2026-07-30)

### 🩹 Fixes

- **wagmi,core:** forward the chainId param in wallet_getPermissions ([#253](https://github.com/JustaName-id/jaw-mono/pull/253))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.1.1 (2026-07-28)

### 🩹 Fixes

- add soneium support ([#252](https://github.com/JustaName-id/jaw-mono/pull/252))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.1.0 (2026-07-27)

### 🚀 Features

- **core:** report wallet signatures for per-workspace analytics ([#250](https://github.com/JustaName-id/jaw-mono/pull/250))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.0.9 (2026-07-16)

### 🩹 Fixes

- **core:** don't re-handshake at the iframe after a first popup conne… ([#243](https://github.com/JustaName-id/jaw-mono/pull/243))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.0.8 (2026-07-16)

### 🩹 Fixes

- **core,keys:** persist 'Continue as' across visits in embedded mode ([#238](https://github.com/JustaName-id/jaw-mono/pull/238))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.0.7 (2026-07-15)

### 🩹 Fixes

- add icons to the tx screen ([#242](https://github.com/JustaName-id/jaw-mono/pull/242))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.0.6 (2026-07-10)

### 🩹 Fixes

- add Robinhood Chain support ([#237](https://github.com/JustaName-id/jaw-mono/pull/237))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.0.5 (2026-07-06)

### 🩹 Fixes

- gas estimation using eth_simulateV1 ([#226](https://github.com/JustaName-id/jaw-mono/pull/226))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.0.4 (2026-07-02)

### 🩹 Fixes

- **core,ui:** show the realistic ERC-20 gas fee and approve the worst-case ceiling ([#225](https://github.com/JustaName-id/jaw-mono/pull/225))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.0.3 (2026-06-23)

### 🩹 Fixes

- **core:** force pointer-events:auto on iframe transport dialog ([#214](https://github.com/JustaName-id/jaw-mono/pull/214))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.0.2 (2026-06-23)

### 🩹 Fixes

- **core,keys:** re-establish iframe session on Safari instead of "No session found" ([#209](https://github.com/JustaName-id/jaw-mono/pull/209))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.0.1 (2026-06-22)

### 🩹 Fixes

- **core:** fallback to popup for non-secure http environments ([#208](https://github.com/JustaName-id/jaw-mono/pull/208))

### ❤️ Thank You

- Ghadi @Ghadi8

# 1.0.0 (2026-06-22)

### 🚀 Features

- ⚠️  embedded iframe transport for keys ([#198](https://github.com/JustaName-id/jaw-mono/pull/198), [#1](https://github.com/JustaName-id/jaw-mono/issues/1), [#2](https://github.com/JustaName-id/jaw-mono/issues/2), [#7](https://github.com/JustaName-id/jaw-mono/issues/7), [#5](https://github.com/JustaName-id/jaw-mono/issues/5), [#6](https://github.com/JustaName-id/jaw-mono/issues/6))

### ⚠️  Breaking Changes

- integrators upgrading without setting transportMode

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 0.4.5 (2026-06-16)

### 🩹 Fixes

- listener accumulation no timeout config ([#199](https://github.com/JustaName-id/jaw-mono/pull/199))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.4.4 (2026-06-15)

### 🩹 Fixes

- polygon support ([#197](https://github.com/JustaName-id/jaw-mono/pull/197))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.4.3 (2026-06-11)

### 🩹 Fixes

- phishing host injection in SIWE ([#189](https://github.com/JustaName-id/jaw-mono/pull/189))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.4.2 (2026-06-04)

### 🩹 Fixes

- **core:** new npm token ([eabc965](https://github.com/JustaName-id/jaw-mono/commit/eabc965))

### ❤️ Thank You

- anthony @anthony23991

## 0.4.1 (2026-06-04)

### 🩹 Fixes

- **core:** add support for arc testnet ([#177](https://github.com/JustaName-id/jaw-mono/pull/177))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.4.0 (2026-05-08)

### 🚀 Features

- **core:** add React Native passkey adapter support for Account class ([#120](https://github.com/JustaName-id/jaw-mono/pull/120), [#133](https://github.com/JustaName-id/jaw-mono/issues/133))

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.3.0 (2026-05-05)

### 🚀 Features

- **cli:** added auto mode ([#164](https://github.com/JustaName-id/jaw-mono/pull/164), [#175](https://github.com/JustaName-id/jaw-mono/issues/175))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.2.8 (2026-04-28)

### 🩹 Fixes

- **core:** erc20 gas override issue ([#174](https://github.com/JustaName-id/jaw-mono/pull/174))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.2.7 (2026-04-27)

### 🩹 Fixes

- **core:** added MIT license ([#171](https://github.com/JustaName-id/jaw-mono/pull/171))

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.2.6 (2026-04-27)

### 🩹 Fixes

- **core:** erc20 gas estimation with permissionId ([#172](https://github.com/JustaName-id/jaw-mono/pull/172))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.2.5 (2026-04-25)

### 🩹 Fixes

- **core:** remove 80% discount ([#169](https://github.com/JustaName-id/jaw-mono/pull/169))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.2.4 (2026-04-22)

### 🩹 Fixes

- **core:** add gnosis support: ([#168](https://github.com/JustaName-id/jaw-mono/pull/168))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.2.3 (2026-04-13)

### 🩹 Fixes

- **core:** allow signer to pass other smart account address ([#163](https://github.com/JustaName-id/jaw-mono/pull/163))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.2.2 (2026-04-07)

### 🩹 Fixes

- **ui:** add theme configuration system for SDK dialogs ([#159](https://github.com/JustaName-id/jaw-mono/pull/159))

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.2.1 (2026-04-06)

### 🩹 Fixes

- dos chain support ([#160](https://github.com/JustaName-id/jaw-mono/pull/160))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.2.0 (2026-03-26)

### 🚀 Features

- **core:** add EIP-7702 account layer — delegation, authorization, a… ([#150](https://github.com/JustaName-id/jaw-mono/pull/150))

### ❤️ Thank You

- AngeloAyranji @AngeloAyranji

## 0.1.5 (2026-03-26)

### 🩹 Fixes

- **core:** flare support ([#157](https://github.com/JustaName-id/jaw-mono/pull/157))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.1.4 (2026-03-24)

### 🩹 Fixes

- **core:** align dependency versions ([#156](https://github.com/JustaName-id/jaw-mono/pull/156))

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.1.3 (2026-03-13)

### 🩹 Fixes

- **cli:** use fresh bridge per MCP tool call instead of caching ([#146](https://github.com/JustaName-id/jaw-mono/pull/146))

### ❤️ Thank You

- AngeloAyranji @AngeloAyranji

## 0.1.2 (2026-03-10)

### 🩹 Fixes

- **cli, core:** add @jaw.id/cli package with MCP server and browser auth ([#136](https://github.com/JustaName-id/jaw-mono/pull/136), [#134](https://github.com/JustaName-id/jaw-mono/issues/134))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.1.1 (2026-03-04)

### 🩹 Fixes

- cached wallet response ([#131](https://github.com/JustaName-id/jaw-mono/pull/131))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.1.0 (2026-03-03)

### 🚀 Features

- beta release ([#128](https://github.com/JustaName-id/jaw-mono/pull/128))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.0.7 (2026-02-27)

### 🩹 Fixes

- **core:** add celo mainnet + sepolia ([#126](https://github.com/JustaName-id/jaw-mono/pull/126))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.0.6 (2026-02-26)

### 🩹 Fixes

- **core:** update signTypedData to use hash signing ([#125](https://github.com/JustaName-id/jaw-mono/pull/125))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.0.5 (2026-02-24)

### 🩹 Fixes

- **core:** revert to hash signing ([#122](https://github.com/JustaName-id/jaw-mono/pull/122))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.0.4 (2026-02-24)

### 🩹 Fixes

- **core:** sign typed data instead of hash ([#121](https://github.com/JustaName-id/jaw-mono/pull/121))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.0.3 (2026-02-20)

### 🩹 Fixes

- **repo:** fixed commonjs warning ([#113](https://github.com/JustaName-id/jaw-mono/pull/113))

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.0.2 (2026-02-19)

### 🩹 Fixes

- **core,ui,wagmi:** updated README.mds ([#112](https://github.com/JustaName-id/jaw-mono/pull/112))

### ❤️ Thank You

- Ghadi @Ghadi8