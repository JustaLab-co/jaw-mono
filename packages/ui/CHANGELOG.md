## 1.13.3 (2026-11-13)

### 🩹 Fixes

- **ui:** stop flagging a signature's start date as past ([#650](https://github.com/JustaLab-co/jaw-mono/pull/650))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.13.2 (2026-11-12)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.10.7

## 1.13.1 (2026-11-12)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.10.6

## 1.13.0 (2026-11-11)

### 🚀 Features

- **ui:** add expectedAccount option to react ui handler ([#639](https://github.com/JustaLab-co/jaw-mono/pull/639))

### 🩹 Fixes

- **ui:** drop the approve notices on bridge batches ([#637](https://github.com/JustaLab-co/jaw-mono/pull/637))
- **ui:** read call reverts from the core estimation error ([#636](https://github.com/JustaLab-co/jaw-mono/pull/636))
- **ui:** retry the asset preview and hold the funds block ([#634](https://github.com/JustaLab-co/jaw-mono/pull/634))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.10.5

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.12.3 (2026-11-10)

### 🩹 Fixes

- **ui:** keep signed tick when dismissed during its hold ([32c1f57b](https://github.com/JustaLab-co/jaw-mono/commit/32c1f57b))
- **keys:** close dialog and say so when server ends request ([75100abe](https://github.com/JustaLab-co/jaw-mono/commit/75100abe))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.12.2 (2026-11-09)

### 🩹 Fixes

- **ui:** leave simulated swap tokens unpriced ([df635c32](https://github.com/JustaLab-co/jaw-mono/commit/df635c32))
- **ui:** read only the same-chain shape of relay proxy calls ([0d61b31d](https://github.com/JustaLab-co/jaw-mono/commit/0d61b31d))
- **ui:** drop live relay approval proxies instead of rejecting ([bd79a9c1](https://github.com/JustaLab-co/jaw-mono/commit/bd79a9c1))
- **ui:** accept symbol characters past ascii in token symbols ([aa28823b](https://github.com/JustaLab-co/jaw-mono/commit/aa28823b))
- **ui:** keep bridge tokens outside the pinned table unverified ([074bd617](https://github.com/JustaLab-co/jaw-mono/commit/074bd617))
- **ui:** apply the printable rule to every token symbol ([c9fc373f](https://github.com/JustaLab-co/jaw-mono/commit/c9fc373f))
- **ui:** keep preview when only the symbol probe fails ([d48289de](https://github.com/JustaLab-co/jaw-mono/commit/d48289de))
- **ui:** fall back to bytes32 symbol only on decode errors ([d30fbafe](https://github.com/JustaLab-co/jaw-mono/commit/d30fbafe))
- **ui:** read cross-chain relay proxy swaps as a bridge ([1647e172](https://github.com/JustaLab-co/jaw-mono/commit/1647e172))
- **ui:** drop the refund detail from relay swaps ([3ac1c4c5](https://github.com/JustaLab-co/jaw-mono/commit/3ac1c4c5))
- **ui:** name an unreadable relay proxy call as a swap ([581c331c](https://github.com/JustaLab-co/jaw-mono/commit/581c331c))
- **ui:** read a relay swap without an approve before it ([6689b8b7](https://github.com/JustaLab-co/jaw-mono/commit/6689b8b7))
- **ui:** show simulated receive on unchecked same-chain bridge views ([881701bc](https://github.com/JustaLab-co/jaw-mono/commit/881701bc))
- **ui:** read relay approval proxy swaps on the signing screen ([53fb7ecd](https://github.com/JustaLab-co/jaw-mono/commit/53fb7ecd))
- **ui:** accept relay approval proxies in the live bridge table ([fd6e385f](https://github.com/JustaLab-co/jaw-mono/commit/fd6e385f))
- **ui:** name blank and bytes32 symbol tokens on signing screen ([563c0319](https://github.com/JustaLab-co/jaw-mono/commit/563c0319))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.10.4

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.12.1 (2026-11-09)

### 🩹 Fixes

- **ui:** hold a reverted fee estimate until the preview answers ([8feb96b3](https://github.com/JustaLab-co/jaw-mono/commit/8feb96b3))
- **ui:** tie retrying to the user's retry run ([fbd6de37](https://github.com/JustaLab-co/jaw-mono/commit/fbd6de37))
- **ui:** drop encoding note, show extra bytes beside clear-signed ([e11c7e6f](https://github.com/JustaLab-co/jaw-mono/commit/e11c7e6f))
- **ui:** show retrying only for a retry the user started ([d687bf23](https://github.com/JustaLab-co/jaw-mono/commit/d687bf23))
- **ui:** read raw json-rpc revert codes in isRevert ([0e40240c](https://github.com/JustaLab-co/jaw-mono/commit/0e40240c))
- **ui:** stop revert cause walk on a looping chain ([fa5728f2](https://github.com/JustaLab-co/jaw-mono/commit/fa5728f2))
- **ui:** read strings as bytes when checking canonical encoding ([809c1b7d](https://github.com/JustaLab-co/jaw-mono/commit/809c1b7d))
- **ui:** keep decodes whose integer words have dirty high bits ([7c88dec9](https://github.com/JustaLab-co/jaw-mono/commit/7c88dec9))
- **ui:** show struct arguments as their tuple types ([fb014f8d](https://github.com/JustaLab-co/jaw-mono/commit/fb014f8d))
- **ui:** map selectors once per abi and skip unhashable entries ([fd44b796](https://github.com/JustaLab-co/jaw-mono/commit/fd44b796))
- **ui:** count bytes past a non-canonical decode in the note ([f31428f3](https://github.com/JustaLab-co/jaw-mono/commit/f31428f3))
- **ui:** reject odd-length calldata before decoding ([a03149dd](https://github.com/JustaLab-co/jaw-mono/commit/a03149dd))
- **ui:** keep non-canonical decodes and warn about encoding ([4fd1c415](https://github.com/JustaLab-co/jaw-mono/commit/4fd1c415))
- **ui:** word reverted fee estimate as a bundler failure ([f518a084](https://github.com/JustaLab-co/jaw-mono/commit/f518a084))
- **ui:** trust estimation revert over preview for permissioned calls ([084ee92d](https://github.com/JustaLab-co/jaw-mono/commit/084ee92d))
- **ui:** keep fee-path reverts retryable in fee estimation ([f37d9fcb](https://github.com/JustaLab-co/jaw-mono/commit/f37d9fcb))
- **ui:** stringify bigint fields in decoded struct arguments ([cfa2b07a](https://github.com/JustaLab-co/jaw-mono/commit/cfa2b07a))
- **ui:** skip unresolved abi entries when matching selector ([acafedc7](https://github.com/JustaLab-co/jaw-mono/commit/acafedc7))
- **ui:** match abi by selector and keep suffixed calls decoded ([7f91817c](https://github.com/JustaLab-co/jaw-mono/commit/7f91817c))
- **ui:** decode calldata with the overload the selector names ([ea8695a9](https://github.com/JustaLab-co/jaw-mono/commit/ea8695a9))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.12.0 (2026-11-05)

### 🚀 Features

- **ui:** show the SIWE request id as a code to compare ([c56bcfff](https://github.com/JustaLab-co/jaw-mono/commit/c56bcfff))

### 🩹 Fixes

- **ui:** show only a strict request code and refuse mid-line field blocks ([873d7bcc](https://github.com/JustaLab-co/jaw-mono/commit/873d7bcc))

### ❤️ Thank You

- Ghadi Mhawej

## 1.11.7 (2026-11-03)

### 🩹 Fixes

- **ui:** word the unpaired approval for several deposits ([cb7ab8f6](https://github.com/JustaLab-co/jaw-mono/commit/cb7ab8f6))
- **ui:** drop bridge warnings the owner cannot act on ([baf2a202](https://github.com/JustaLab-co/jaw-mono/commit/baf2a202))
- **ui:** align unreadable marks with their text ([e8928ed5](https://github.com/JustaLab-co/jaw-mono/commit/e8928ed5))
- **ui:** address review of unreadable call icon ([8a851831](https://github.com/JustaLab-co/jaw-mono/commit/8a851831))
- **ui:** show unreadable bridge calls as a warning icon ([bf6d1794](https://github.com/JustaLab-co/jaw-mono/commit/bf6d1794))
- **ui:** name unreadable steps in the bridge alert line ([0d030c4b](https://github.com/JustaLab-co/jaw-mono/commit/0d030c4b))
- **ui:** show unreadable bridge calls as one compact line ([ff3ad068](https://github.com/JustaLab-co/jaw-mono/commit/ff3ad068))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.11.6 (2026-11-03)

### 🩹 Fixes

- **ui:** read a reverting fee estimation as will-fail ([fa2b5331](https://github.com/JustaLab-co/jaw-mono/commit/fa2b5331))
- **ui:** show retry in flight on the fee row ([4196aa5f](https://github.com/JustaLab-co/jaw-mono/commit/4196aa5f))
- **ui:** report will-fail when the calls revert for another reason ([dd46637b](https://github.com/JustaLab-co/jaw-mono/commit/dd46637b))
- **ui:** name bridge rows by the bridge's own token read ([53570cc0](https://github.com/JustaLab-co/jaw-mono/commit/53570cc0))
- **ui:** hold fee retry while an estimation runs ([36f4331d](https://github.com/JustaLab-co/jaw-mono/commit/36f4331d))
- **ui:** strip every control and format character from fee failures ([9f496a33](https://github.com/JustaLab-co/jaw-mono/commit/9f496a33))
- **ui:** let a fee estimation failure outrank dust eth ([d0fa5ee5](https://github.com/JustaLab-co/jaw-mono/commit/d0fa5ee5))
- **ui:** keep symbolless token rows and shorten base units notes ([a8f84e65](https://github.com/JustaLab-co/jaw-mono/commit/a8f84e65))
- **ui:** fall back to bytes32 symbol only on decode errors ([97b1e3f6](https://github.com/JustaLab-co/jaw-mono/commit/97b1e3f6))
- **ui:** replace stale fee failures when a round throws ([2b65e3fe](https://github.com/JustaLab-co/jaw-mono/commit/2b65e3fe))
- **ui:** treat fee tokens missing from a quote as unproven ([e4c7402d](https://github.com/JustaLab-co/jaw-mono/commit/e4c7402d))
- **ui:** read every fee rejection message the same way ([ebf55040](https://github.com/JustaLab-co/jaw-mono/commit/ebf55040))
- **ui:** show unreadable token decimals in base units ([4274495a](https://github.com/JustaLab-co/jaw-mono/commit/4274495a))
- **ui:** read bytes32 token symbols ([73d564af](https://github.com/JustaLab-co/jaw-mono/commit/73d564af))
- **ui:** clear stale estimation failure on unquoted fee tokens ([65b0fbfb](https://github.com/JustaLab-co/jaw-mono/commit/65b0fbfb))
- **ui:** bound and sanitize fee estimation failure text ([dacd63fa](https://github.com/JustaLab-co/jaw-mono/commit/dacd63fa))
- **ui:** tell estimation failures apart from insufficient funds ([2d7626bf](https://github.com/JustaLab-co/jaw-mono/commit/2d7626bf))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.11.5 (2026-11-03)

### 🩹 Fixes

- **ui:** show relay orders that refund another recipient ([#623](https://github.com/JustaLab-co/jaw-mono/pull/623))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.11.4 (2026-11-02)

### 🩹 Fixes

- **ui:** show ens names without waiting on records ([#621](https://github.com/JustaLab-co/jaw-mono/pull/621))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.11.3 (2026-11-02)

### 🩹 Fixes

- **ui:** show Relay orders whose solver chain is outside the route ([#618](https://github.com/JustaLab-co/jaw-mono/pull/618))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.11.2 (2026-10-30)

### 🩹 Fixes

- **ui:** drop the unverified tag from bridge tokens ([#610](https://github.com/JustaLab-co/jaw-mono/pull/610))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.11.1 (2026-10-30)

### 🩹 Fixes

- **ui:** name the dApp when fetching the bridge table ([#611](https://github.com/JustaLab-co/jaw-mono/pull/611))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.10.3

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.11.0 (2026-10-30)

### 🚀 Features

- **ui:** show bridge notices compact under the transfer ([#608](https://github.com/JustaLab-co/jaw-mono/pull/608))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.10.2

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.10.4 (2026-10-30)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.10.1

## 1.10.3 (2026-10-29)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.10.0

## 1.10.2 (2026-10-29)

### 🩹 Fixes

- **ui:** read across swaps that pay the app fee ([#597](https://github.com/JustaLab-co/jaw-mono/pull/597))

### ❤️ Thank You

- Mariano Aguero

## 1.10.1 (2026-10-28)

### 🩹 Fixes

- **ui:** read across deposits that swap through uniswap v4 ([#590](https://github.com/JustaLab-co/jaw-mono/pull/590))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.10.0 (2026-10-27)

### 🚀 Features

- **ui:** pin bridge contracts for the signing screen ([#556](https://github.com/JustaLab-co/jaw-mono/pull/556))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.9.1 (2026-10-27)

### 🩹 Fixes

- **ui:** flag unlimited approvals inline and drop the token approvals card ([#584](https://github.com/JustaLab-co/jaw-mono/pull/584))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.9.0 (2026-10-27)

### 🚀 Features

- **core:** let a grant carry a call checker ([#572](https://github.com/JustaLab-co/jaw-mono/pull/572))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.9.0

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.8.3 (2026-10-27)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.8.0

## 1.8.2 (2026-10-22)

### 🩹 Fixes

- **ui:** show the token approvals card only for unlimited approvals ([#541](https://github.com/JustaLab-co/jaw-mono/pull/541))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.8.1 (2026-10-21)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.7.1

## 1.8.0 (2026-10-19)

### 🚀 Features

- **core:** add pending to the revoke permission response ([#429](https://github.com/JustaLab-co/jaw-mono/pull/429))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.7.0

### ❤️ Thank You

- Mariano Aguero

## 1.7.1 (2026-10-19)

### 🩹 Fixes

- **ui:** resolve ens, token and clear-signing names with one shared hook ([#486](https://github.com/JustaLab-co/jaw-mono/pull/486))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.7.0 (2026-10-16)

### 🚀 Features

- **mcp:** add the hosted MCP server with x402 budgets ([#367](https://github.com/JustaLab-co/jaw-mono/pull/367))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.6.4 (2026-10-14)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.6.4

## 1.6.3 (2026-10-13)

### 🩹 Fixes

- **core:** keep each account's address fixed by storing the record it was created from ([#374](https://github.com/JustaLab-co/jaw-mono/pull/374))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.6.3

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.6.2 (2026-10-09)

### 🩹 Fixes

- **core:** send passkey requests to the configured serverUrl ([#373](https://github.com/JustaLab-co/jaw-mono/pull/373))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.6.2

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.6.1 (2026-10-06)

### 🩹 Fixes

- add support for adi chain ([#366](https://github.com/JustaLab-co/jaw-mono/pull/366))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.6.1

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.6.0 (2026-10-01)

### 🚀 Features

- agentic payments batch ([#315](https://github.com/JustaLab-co/jaw-mono/pull/315))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.6.0

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.5.5 (2026-09-30)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.5.5

## 1.5.4 (2026-09-29)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.5.4

## 1.5.3 (2026-09-29)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.5.3

## 1.5.2 (2026-09-29)

### 🩹 Fixes

- add Citrea mainnet support ([#359](https://github.com/JustaLab-co/jaw-mono/pull/359))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.5.2

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.5.1 (2026-09-24)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.5.1

## 1.5.0 (2026-09-23)

### 🚀 Features

- **core:** let the backend decide whether a request is served ([#321](https://github.com/JustaLab-co/jaw-mono/pull/321))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.5.0

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.4.5 (2026-09-22)

### 🩹 Fixes

- **ui:** key reverse answers by address and chain ([#349](https://github.com/JustaLab-co/jaw-mono/pull/349))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.4.4 (2026-09-22)

### 🩹 Fixes

- **ui:** refuse offchain lookups on the shared public client ([#348](https://github.com/JustaLab-co/jaw-mono/pull/348))

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.4.3 (2026-09-18)

### 🩹 Fixes

- add funds section ([#340](https://github.com/JustaLab-co/jaw-mono/pull/340))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.4.3

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.4.2 (2026-09-17)

### 🩹 Fixes

- **deps:** bump viem to 2.56.7, drop local arc/hyveChain definitions ([#343](https://github.com/JustaName-id/jaw-mono/pull/343))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.4.2

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.4.1 (2026-09-16)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.4.1

## 1.4.0 (2026-09-15)

### 🚀 Features

- add funds ([#303](https://github.com/JustaName-id/jaw-mono/pull/303))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.4.0

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.3.6 (2026-09-14)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.3.2

## 1.3.5 (2026-09-14)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.3.1

## 1.3.4 (2026-09-03)

### 🩹 Fixes

- **core,ui:** price the prefund off the wallet's own paymaster ([2ae91627](https://github.com/JustaName-id/jaw-mono/commit/2ae91627))
- **ui:** pair the paymaster url with its own context ([be17c203](https://github.com/JustaName-id/jaw-mono/commit/be17c203))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.3.0

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.3.3 (2026-08-20)

### 🩹 Fixes

- **repo:** relicense under apache-2.0 and drop dos chain ([#287](https://github.com/JustaName-id/jaw-mono/pull/287))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.2.3

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.3.2 (2026-08-19)

### 🩹 Fixes

- **ui:** measure asset preview with viem's traceAssetChanges ([#270](https://github.com/JustaName-id/jaw-mono/pull/270))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.2.2

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.3.1 (2026-08-19)

### 🩹 Fixes

- theme configuration across screens ([#286](https://github.com/JustaName-id/jaw-mono/pull/286))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.2.1

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.3.0 (2026-08-17)

### 🚀 Features

- keys ui revamp ([#248](https://github.com/JustaName-id/jaw-mono/pull/248))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.2.0

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.2.17 (2026-08-05)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.1.4

## 1.2.16 (2026-08-04)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.1.3

## 1.2.15 (2026-07-30)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.1.2

## 1.2.14 (2026-07-28)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.1.1

## 1.2.13 (2026-07-27)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.1.0

## 1.2.12 (2026-07-17)

### 🩹 Fixes

- **ui:** render app-specific dialogs in a native <dialog> top layer ([#247](https://github.com/JustaName-id/jaw-mono/pull/247))

### ❤️ Thank You

- AngeloAyranji @AngeloAyranji

## 1.2.11 (2026-07-16)

### 🩹 Fixes

- native only gas fee icons ([#244](https://github.com/JustaName-id/jaw-mono/pull/244))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.2.10 (2026-07-16)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.9

## 1.2.9 (2026-07-16)

### 🩹 Fixes

- **core,keys:** persist 'Continue as' across visits in embedded mode ([#238](https://github.com/JustaName-id/jaw-mono/pull/238))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.8

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.2.8 (2026-07-15)

### 🩹 Fixes

- add icons to the tx screen ([#242](https://github.com/JustaName-id/jaw-mono/pull/242))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.7

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.2.7 (2026-07-14)

### 🩹 Fixes

- asset changes ([#241](https://github.com/JustaName-id/jaw-mono/pull/241))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.2.6 (2026-07-10)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.6

## 1.2.5 (2026-07-06)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.5

## 1.2.4 (2026-07-06)

### 🩹 Fixes

- **ui,keys,docs:** match embedded action modals to the account-selec… ([#228](https://github.com/JustaName-id/jaw-mono/pull/228))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.2.3 (2026-07-06)

### 🩹 Fixes

- bump justaname/sdk to v0.3.0 ([#227](https://github.com/JustaName-id/jaw-mono/pull/227))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.2.2 (2026-07-02)

### 🩹 Fixes

- **core,ui:** show the realistic ERC-20 gas fee and approve the worst-case ceiling ([#225](https://github.com/JustaName-id/jaw-mono/pull/225))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.4

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 1.2.1 (2026-07-02)

### 🩹 Fixes

- **ui:** improve account selection ux ([#224](https://github.com/JustaName-id/jaw-mono/pull/224))

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.2.0 (2026-06-30)

### 🚀 Features

- **ui, keys:** asset preview ([#222](https://github.com/JustaName-id/jaw-mono/pull/222))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.1.2 (2026-06-24)

### 🩹 Fixes

- **ui:** add max-height and overflow-y to dialog content for better responsiveness ([#216](https://github.com/JustaName-id/jaw-mono/pull/216))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.1.1 (2026-06-23)

### 🩹 Fixes

- **ui:** generate declarations via tsc to fix project-reference typecheck ([#215](https://github.com/JustaName-id/jaw-mono/pull/215))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.3

### ❤️ Thank You

- Ghadi @Ghadi8

## 1.1.0 (2026-06-23)

### 🚀 Features

- **ui:** add support for erc-8213 ([#212](https://github.com/JustaName-id/jaw-mono/pull/212))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 1.0.2 (2026-06-23)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.2

## 1.0.1 (2026-06-22)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.1

# 1.0.0 (2026-06-22)

### 🚀 Features

- ⚠️  embedded iframe transport for keys ([#198](https://github.com/JustaName-id/jaw-mono/pull/198), [#1](https://github.com/JustaName-id/jaw-mono/issues/1), [#2](https://github.com/JustaName-id/jaw-mono/issues/2), [#7](https://github.com/JustaName-id/jaw-mono/issues/7), [#5](https://github.com/JustaName-id/jaw-mono/issues/5), [#6](https://github.com/JustaName-id/jaw-mono/issues/6))

### ⚠️  Breaking Changes

- integrators upgrading without setting transportMode

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 1.0.0

### ❤️ Thank You

- Mariano Aguero @mariano-aguero

## 0.4.15 (2026-06-17)

### 🩹 Fixes

- **ui:** adjust Eip712Dialog layout for overflow handling ([#200](https://github.com/JustaName-id/jaw-mono/pull/200))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.4.14 (2026-06-16)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.5

## 0.4.13 (2026-06-15)

### 🩹 Fixes

- **ui:** add sanitizeDisplayName utility for safe app name display ([#196](https://github.com/JustaName-id/jaw-mono/pull/196))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.4.12 (2026-06-15)

### 🩹 Fixes

- added safe url check and address check ([#194](https://github.com/JustaName-id/jaw-mono/pull/194))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.4.11 (2026-06-15)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.4

## 0.4.10 (2026-06-15)

### 🩹 Fixes

- **ui:** add native decimals support to clear signing hooks and utils ([#195](https://github.com/JustaName-id/jaw-mono/pull/195))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.4.9 (2026-06-15)

### 🩹 Fixes

- **ui:** switch token price api ([#193](https://github.com/JustaName-id/jaw-mono/pull/193))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.4.8 (2026-06-12)

### 🩹 Fixes

- **ui:** safely load ens profiles avatars ([#192](https://github.com/JustaName-id/jaw-mono/pull/192))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.4.7 (2026-06-12)

### 🩹 Fixes

- **ui:** improve gas fee display and fallback logic ([#191](https://github.com/JustaName-id/jaw-mono/pull/191))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.4.6 (2026-06-11)

### 🩹 Fixes

- phishing host injection in SIWE ([#189](https://github.com/JustaName-id/jaw-mono/pull/189))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.3

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.4.5 (2026-06-11)

### 🩹 Fixes

- resolve with avatars on transaction and permission screens ([#190](https://github.com/JustaName-id/jaw-mono/pull/190))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.4.4 (2026-06-04)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.2

## 0.4.3 (2026-06-04)

### 🩹 Fixes

- **core:** add support for arc testnet ([#177](https://github.com/JustaName-id/jaw-mono/pull/177))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.1

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.4.2 (2026-05-18)

### 🩹 Fixes

- **ui:** republish after token renewal ([843d820](https://github.com/JustaName-id/jaw-mono/commit/843d820))

### ❤️ Thank You

- anthony @anthony23991

## 0.4.1 (2026-05-18)

### 🩹 Fixes

- **ui:** enhance EIP-712 descriptor handling for ERC-7730 compliance ([#182](https://github.com/JustaName-id/jaw-mono/pull/182))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.4.0 (2026-05-14)

### 🚀 Features

- **ui:** implement ERC-7730 clear signing ([#181](https://github.com/JustaName-id/jaw-mono/pull/181))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.3.0 (2026-05-08)

### 🚀 Features

- **core:** add React Native passkey adapter support for Account class ([#120](https://github.com/JustaName-id/jaw-mono/pull/120), [#133](https://github.com/JustaName-id/jaw-mono/issues/133))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.4.0

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.2.8 (2026-05-05)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.3.0

## 0.2.7 (2026-04-28)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.2.8

## 0.2.6 (2026-04-27)

### 🩹 Fixes

- **ui:** use proxy instead of public rpc in permission dialog ([#173](https://github.com/JustaName-id/jaw-mono/pull/173))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.2.5 (2026-04-27)

### 🩹 Fixes

- **core:** added MIT license ([#171](https://github.com/JustaName-id/jaw-mono/pull/171))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.2.7

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.2.4 (2026-04-27)

### 🩹 Fixes

- **core:** erc20 gas estimation with permissionId ([#172](https://github.com/JustaName-id/jaw-mono/pull/172))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.2.6

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.2.3 (2026-04-27)

### 🩹 Fixes

- **ui:** remove rendering of empty data in TransactionDialog ([#170](https://github.com/JustaName-id/jaw-mono/pull/170))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.2.2 (2026-04-25)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.2.5

## 0.2.1 (2026-04-22)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.2.4

## 0.2.0 (2026-04-17)

### 🚀 Features

- **ui:** show ENS names in interop format across wallet dialogs ([#166](https://github.com/JustaName-id/jaw-mono/pull/166))

### ❤️ Thank You

- AngeloAyranji @AngeloAyranji

## 0.1.11 (2026-04-13)

### 🩹 Fixes

- **core:** allow signer to pass other smart account address ([#163](https://github.com/JustaName-id/jaw-mono/pull/163))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.2.3

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.1.10 (2026-04-08)

### 🩹 Fixes

- **playground:** added dark mode light mode in playground and auto theme mode on keys-jaw-id ([#162](https://github.com/JustaName-id/jaw-mono/pull/162))

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.1.9 (2026-04-07)

### 🩹 Fixes

- **ui:** add theme configuration system for SDK dialogs ([#159](https://github.com/JustaName-id/jaw-mono/pull/159))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.2.2

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.1.8 (2026-04-06)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.2.1

## 0.1.7 (2026-03-27)

### 🩹 Fixes

- **ui:** full css isolation for ui components ([#158](https://github.com/JustaName-id/jaw-mono/pull/158))

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.1.6 (2026-03-26)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.2.0

## 0.1.5 (2026-03-26)

### 🩹 Fixes

- **core:** flare support ([#157](https://github.com/JustaName-id/jaw-mono/pull/157))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.1.5

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.1.4 (2026-03-24)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.1.4

## 0.1.3 (2026-03-13)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.1.3

## 0.1.2 (2026-03-10)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.1.2

## 0.1.1 (2026-03-04)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.1.1

## 0.1.0 (2026-03-03)

### 🚀 Features

- removed x from dialog ([#130](https://github.com/JustaName-id/jaw-mono/pull/130))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015

## 0.0.10 (2026-03-03)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.1.0

## 0.0.9 (2026-03-02)

### 🩹 Fixes

- **ui:** reverse resolve addresses in decoded calldata screens ([#127](https://github.com/JustaName-id/jaw-mono/pull/127))

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.0.8 (2026-02-27)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.0.7

## 0.0.7 (2026-02-26)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.0.6

## 0.0.6 (2026-02-24)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.0.5

## 0.0.5 (2026-02-24)

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.0.4

## 0.0.4 (2026-02-20)

### 🩹 Fixes

- **repo:** fixed commonjs warning ([#113](https://github.com/JustaName-id/jaw-mono/pull/113))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.0.3

### ❤️ Thank You

- Anthony Khoury @anthony23991

## 0.0.3 (2026-02-19)

### 🩹 Fixes

- **core,ui,wagmi:** updated README.mds ([#112](https://github.com/JustaName-id/jaw-mono/pull/112))

### 🧱 Updated Dependencies

- Updated @jaw.id/core to 0.0.2

### ❤️ Thank You

- Ghadi @Ghadi8

## 0.0.2 (2026-02-19)

### 🩹 Fixes

- **ui,keys:** prevent crash when call permission selector is undefined ([#111](https://github.com/JustaName-id/jaw-mono/pull/111))

### ❤️ Thank You

- Leo Franklin @LeoFranklin015