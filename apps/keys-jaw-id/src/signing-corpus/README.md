# Signing corpus

Hostile and malformed signing requests, each paired with the outcome a user must get. `corpus.test.tsx` renders every fixture through the real keys modal and `@jaw.id/ui` dialog, presses sign, and captures the challenge handed to the passkey. Everything between the screen and `navigator.credentials.get` runs for real: core's ERC-7739 wrapping and viem/ox's WebAuthn request. Only the passkey is fake, and it refuses after recording what it was asked to sign.

Two things are checked per fixture:

- **What the user sees.** The decision (`sign`, `ack` when the risk box holds the button back, `blocked`), text that must be on screen without expanding or hovering anything (`shows`), text that must not be (`hides`), text that only appears on hover (`hovers`, never counted as shown), and labels that must sit in the same row as their value (`pairs`).
- **That what is shown is what gets signed.** For EIP-712 the challenge must equal the ERC-7739 `TypedDataSign` built from the Domain Hash and Message Hash the screen displays. For messages it must equal `PersonalSign` over the text the screen presents, and for SIWE every displayed field must sit on its line of those signed bytes.

`challenge.ts` is independent of the signing path only at the ERC-7739 layer: it rebuilds the wrapping by hand, without viem's erc7739 module. The Domain Hash and Message Hash it starts from are the ones on screen, which `erc8213.ts` computes with viem's `hashDomain` and `hashStruct`, the same library that hashes for signing. A viem EIP-712 bug would move both sides together. The cast anchors below are what check that layer.

## Rules

- **Append-only.** A fixture is never removed or weakened. New attack patterns from a review, a bug report or the wild get added. The corpus can only get stricter.
- **Expectations are written by hand from the payload.** Never render the current screen and paste what it shows: that freezes whatever the code does today, bugs included.
- **Known holes are `gap` entries.** `expect` holds what is right today; `gap.expect` holds what should be true and is not; `gap.fails` is the start of the assertion message it must fail with (every assertion is labelled: `decision`, `shows <text>`, `hides <text>`, `pair <label>`, `integrity`). The gap test passes only while the check fails on that assertion, so it cannot stay green by breaking somewhere else, and it turns red the day the hole is fixed. When that happens, merge `gap.expect` into `expect` and delete the `gap`.
- Only a gap may set `integrity: false`. A test enforces it.

## Anchors

Four fixtures pin their challenge to a value computed outside TypeScript with Foundry's `cast`, so the hand-written formulas in `challenge.ts` are checked against an independent implementation, not only against the code they test. Account `0x9fD37D2cF1b32b3f7dBae480bbd44BE3De2A9e0F`, chain 8453.

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

`eip712-nested-anchor` (a dependency, `Asset`, that sorts before the primary type) and `eip712-arrays-strings-anchor` (string, `string[]`, `uint256[]`), both on the `Vault` domain, reusing `DT`, `ACCOUNT` and `ZERO`:

```bash
VAULT=0x1111111111111111111111111111111111111111
DH=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" $DT $(cast keccak Vault) $(cast keccak 1) 8453 $VAULT))
SIGN="string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"
wrap() { # $1 the TypedDataSign type string after "TypedDataSign(", $2 the message hash
  TT=$(cast keccak "TypedDataSign($1")
  SH=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,bytes32,uint256,address,bytes32)" $TT $2 $(cast keccak JustanAccount) $(cast keccak 1) 8453 $ACCOUNT $ZERO))
  cast keccak $(cast concat-hex 0x1901 $DH $SH)
}

AT=$(cast keccak "Asset(address token,uint256 amount)")
AH=$(cast keccak $(cast abi-encode "f(bytes32,address,uint256)" $AT 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 1000000))
TRT=$(cast keccak "Transfer(Asset asset,address to)Asset(address token,uint256 amount)")
MH=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,address)" $TRT $AH 0xbad0000000000000000000000000000000000bad))
wrap "Transfer contents,$SIGN""Asset(address token,uint256 amount)Transfer(Asset asset,address to)" $MH
# 0xad5ce8e8a6ac5c78ef1add3ebcd6494c15ef66820a4420b9589ab925341ac230

NT=$(cast keccak "Note(string text,string[] tags,uint256[] ids)")
TAGS=$(cast keccak $(cast concat-hex $(cast keccak alpha) $(cast keccak beta)))
IDS=$(cast keccak $(cast abi-encode "f(uint256,uint256)" 1 2))
MH=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,bytes32)" $NT $(cast keccak "gm, café") $TAGS $IDS))
wrap "Note contents,$SIGN""Note(string text,string[] tags,uint256[] ids)" $MH
# 0x99f6953854a89f354926800573d70f6cc5842427106a6e14763f934f567cfd89
```

In the nested anchor EIP-712 sorts `Asset` ahead of `Transfer` inside the `TypedDataSign` type. That pins the hash the passkey signs, not the signature blob that carries it.

## Known gaps

Recorded as fixtures: `eip712-domain-type-omits-chain-id`, `eip712-deep-nesting`, `eip712-vanity-address`, `eip712-homoglyph-symbol`, `eip712-bidi-override`, `eip712-unhashable-value`, `siwe-uri-on-attacker-host`, `siwe-hex-encoded`, `personal-zero-width`, and the passkey cancellation code in `corpus.test.tsx`.

Not covered by a fixture: viem's `wrapTypedDataSignature` emits the ERC-7739 contents type in implicit mode, primary type first. When a dependency sorts before the primary type (Permit2's `PermitSingle` with `PermitDetails`), the contract derives a different type string from what was hashed and the signature does not verify. The corpus stops at the passkey challenge and does not decode the signature, so it cannot see this.

## Limits

jsdom has no layout, so nothing here can tell whether content is scrolled out of view or clipped; `eip712-array-flood` only pins that the last entry is rendered. Tooltips are read from `aria-label`, which is what a screen reader announces, not what a sighted user sees without hovering.

## Adding a fixture

Add an entry to `eip712.json` or `messages.json`: a unique `id`, the `attack` in one sentence, the request (`typedData`, `message`, or raw `params` with a `method`), and `expect`. Run `bunx vitest run src/signing-corpus` from `apps/keys-jaw-id`.
