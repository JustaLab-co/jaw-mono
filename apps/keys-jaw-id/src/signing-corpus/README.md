# Signing corpus

Hostile and malformed signing requests, each paired with the outcome a user must get. `corpus.test.tsx` renders every fixture through the real keys modal and `@jaw.id/ui` dialog, presses sign, and captures the challenge handed to the passkey. Everything between the screen and `navigator.credentials.get` runs for real: core's ERC-7739 wrapping and viem/ox's WebAuthn request. Only the passkey is fake, and it refuses after recording what it was asked to sign.

Two things are checked per fixture:

- **What the user sees.** The decision (`sign`, `ack` when the risk box holds the button back, `blocked`), text that must be on screen without expanding anything (`shows`), and text that must not be (`hides`).
- **That what is shown is what gets signed.** For EIP-712 the challenge must equal the ERC-7739 `TypedDataSign` built from the Domain Hash and Message Hash the screen displays. For messages it must equal `PersonalSign` over the text the screen presents, and for SIWE every displayed field must sit on its line of those signed bytes. `challenge.ts` rebuilds both by hand from the specs, without viem's erc7739 or typed-data hashing, so it cannot share a bug with the signing path.

## Rules

- **Append-only.** A fixture is never removed or weakened. New attack patterns from a review, a bug report or the wild get added. The corpus can only get stricter.
- **Expectations are written by hand from the payload.** Never render the current screen and paste what it shows: that freezes whatever the code does today, bugs included.
- **Known holes are `gap` entries.** `expect` holds what is right today; `gap.expect` holds what should be true and is not. The gap runs under `it.fails`, so it stays green while the hole exists and turns red the day it is fixed. When that happens, merge `gap.expect` into `expect` and delete the `gap`.
- Only a gap may set `integrity: false`. A test enforces it.

## Anchors

Two fixtures pin their challenge to a value computed outside TypeScript with Foundry's `cast`, so the hand-written formulas in `challenge.ts` are checked against an independent implementation, not only against the code they test. Account `0x9fD37D2cF1b32b3f7dBae480bbd44BE3De2A9e0F`, chain 8453.

`eip712-permit-anchor` (also `eip712-wallet-sign-envelope`):

```bash
ACCOUNT=0x9fD37D2cF1b32b3f7dBae480bbd44BE3De2A9e0F
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
ZERO=0x0000000000000000000000000000000000000000000000000000000000000000
DT=$(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
DH=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" $DT $(cast keccak "USD Coin") $(cast keccak "2") 8453 $USDC))
PT=$(cast keccak "Permit(address owner,uint256 value)")
MH=$(cast keccak $(cast abi-encode "f(bytes32,address,uint256)" $PT $ACCOUNT 1000))
TT=$(cast keccak "TypedDataSign(Permit contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)Permit(address owner,uint256 value)")
SH=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,bytes32,uint256,address,bytes32)" $TT $MH $(cast keccak JustanAccount) $(cast keccak 1) 8453 $ACCOUNT $ZERO))
cast keccak $(cast concat-hex 0x1901 $DH $SH)
# 0x1ac8bbf747fd61141ce6ee5aedbac7a5dd76ebae42f964cc02f4d922d0d9876f
```

`personal-hello-anchor` (also `personal-wallet-sign-envelope`), reusing `DT` and `ACCOUNT`:

```bash
AD=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" $DT $(cast keccak JustanAccount) $(cast keccak 1) 8453 $ACCOUNT))
PS=$(cast keccak $(cast abi-encode "f(bytes32,bytes32)" $(cast keccak "PersonalSign(bytes prefixed)") $(cast hash-message "hello")))
cast keccak $(cast concat-hex 0x1901 $AD $PS)
# 0xe00999f5e65e3e331330febc5a777acef248a4acdef93d50d2cc663c64b92053
```

## Adding a fixture

Add an entry to `eip712.json` or `messages.json`: a unique `id`, the `attack` in one sentence, the request (`typedData`, `message`, or raw `params` with a `method`), and `expect`. Run `bunx vitest run src/signing-corpus` from `apps/keys-jaw-id`.
