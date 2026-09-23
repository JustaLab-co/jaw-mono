# Golden vectors

The `expected` bytes in these files were **not** produced by this codebase. Each
one comes from `cast abi-encode` with the struct signature copied out of the
Solidity, so it is the contract's statement of the encoding rather than ours.

That distinction is the whole point. `toJustanAccount.encoding.test.ts` decodes
what we encoded back through the shape we believe the contract reads, which
proves we are consistent with ourselves and nothing more. Move a field in the
implementation and in that shape at the same time, which is what a person does
when a mirrored test fails, and it stays green while the on-chain decode breaks.
The vectors fail, because their bytes never moved.

## The structs

Copied verbatim; check them against the submodule before trusting anything here.

`contracts/justanaccount/src/JustanAccount.sol:67`

```solidity
struct SignatureWrapper {
    uint256 ownerIndex;
    bytes signatureData;
}
```

`contracts/justanaccount/lib/solady/src/utils/WebAuthn.sol:17`

```solidity
struct WebAuthnAuth {
    bytes authenticatorData;
    string clientDataJSON;
    uint256 challengeIndex;   // start index of `"challenge":"` in clientDataJSON
    uint256 typeIndex;        // start index of `"type":"`      in clientDataJSON
    bytes32 r;
    bytes32 s;
}
```

Both submodules have to be checked out to read these:

```bash
git submodule update --init contracts/justanaccount
cd contracts/justanaccount && git submodule update --init lib/solady
```

`contracts/permissions/src/JustaPermissionManager.sol:225`

```solidity
struct CallPermission {
    address target;
    bytes4 selector;
    address checker;
}

struct SpendLimit {
    address token;
    uint160 allowance;
    PeriodUnit unit;
    uint16 multiplier;
}

struct Permission {
    address account;
    address spender;
    uint48 start;
    uint48 end;
    uint256 salt;
    CallPermission[] calls;
    SpendLimit[] spends;
}
```

`executeBatch` takes that tuple plus `BaseAccount.Call[]`, which comes from
ERC-4337 rather than from our own contracts,
`contracts/permissions/lib/justanaccount/lib/account-abstraction/contracts/core/BaseAccount.sol:21`:

```solidity
struct Call {
    address target;
    uint256 value;
    bytes data;
}
```

That one is two submodules deep:

```bash
cd contracts/permissions && git submodule update --init lib/justanaccount
cd lib/justanaccount && git submodule update --init lib/account-abstraction
```

## Re-deriving a vector

`signature-wrap.json`, first entry:

```bash
cast abi-encode "f((uint256,bytes))" "(0,0x$(printf 'aa%.0s' {1..32})$(printf 'bb%.0s' {1..32})1b)"
```

Fourth entry, the index past a byte:

```bash
cast abi-encode "f((uint256,bytes))" "(300,0x1234)"
```

The bytes handed to `cast` are what `wrapSignature` produces on the way in, not
its `input.signature`. For a 65-byte signature it repacks as
`abi.encodePacked(r, s, v)` with `v` normalised to 27 or 28 first, so the second
entry takes a signature ending in `01` and its expected bytes end in `1c`. Drop
the raw input into the command above and you will derive something that ends in
`01` and conclude, wrongly, that the vector is broken.

`signature-webauthn.json`:

```bash
cast abi-encode "f((bytes,bytes,uint256,uint256,bytes32,bytes32))" \
  "(0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d00000000,\
0x$(printf '%s' '{"type":"webauthn.get","challenge":"9jEFijuhEWrM4SOW-tChJbUEHEP44VcjcJ-Bqo1fTM8","origin":"https://keys.jaw.id"}' | xxd -p | tr -d '\n'),\
23,1,0x$(printf '11%.0s' {1..32}),0x$(printf '22%.0s' {1..32}))"
```

`clientDataJSON` is passed as `bytes` rather than `string`. The two are
identical in ABI encoding, both being dynamic byte arrays, and the hex form
avoids having to quote a JSON string containing commas through a shell.

`permission-calls.json` is `cast calldata` rather than `cast abi-encode`, so the
four-byte selector is pinned too. That matters here: the selector is a hash of
the whole signature, so retyping or reordering a field inside the `Permission`
tuple moves it even on a call whose arrays are empty.

The tuple and the permission value are both long, and all three entries reuse
them, so name them once:

```bash
PERM='(address,address,uint48,uint48,uint256,(address,bytes4,address)[],(address,uint160,uint8,uint16)[])'

PERMVAL='(0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222,1700000000,2000000000,42,[(0x3333333333333333333333333333333333333333,0xa9059cbb,0x0000000000000000000000000000000000000000)],[(0x4444444444444444444444444444444444444444,1000000,2,7)])'
```

Third entry, `buildRevokePermissionCall`:

```bash
cast calldata "revoke($PERM)" "$PERMVAL"
```

Fourth entry, `encodeExecuteBatchWithPermission`, the same permission plus two
calls. The first call's `data` is itself a `transfer`, derived rather than
written out, because hand-counting the zero padding is how you end up deriving
something one nibble short and concluding the vector is broken:

```bash
XFER=$(cast calldata "transfer(address,uint256)" 0x7777777777777777777777777777777777777777 1000000)

cast calldata "executeBatch($PERM,(address,uint256,bytes)[])" "$PERMVAL" \
  "[(0x5555555555555555555555555555555555555555,0,$XFER),\
(0x6666666666666666666666666666666666666666,1000000000000000000,0x)]"
```

Fifth entry, every dynamic array empty, which is where a head/tail offset
mistake shows and where only the selector is left to catch a retyped field:

```bash
cast calldata "executeBatch($PERM,(address,uint256,bytes)[])" \
  '(0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222,0,281474976710655,0,[],[])' \
  '[]'
```

The two grant entries are the ones that need care. `apiPermissionsToPermission`
stamps `start` from `Date.now()` and draws the salt from `Math.random()`, so the
test freezes the clock at the `start` recorded in the vector and pins
`Math.random` to 0, which makes the salt 0. Generate them with those two values,
not with the 42 the other entries use. The period is the other thing to watch:
`unit: 'year'` has no enum member, so the second entry encodes as `Month` with
the multiplier times twelve.

To read a vector back:

```bash
cast abi-decode --input "f((uint256,bytes))" 0x<expected>
```

For a `permission-calls.json` entry, drop the leading four bytes first, or use
`cast 4byte-decode`.

`typed-data-sign.json` is the whole `signTypedData` output: the owner tuple, then
the ERC-7739 envelope Solady reads in `ERC1271.sol:_erc1271IsValidSignatureViaNestedEIP712`,
`appDomainSeparator ‖ contents ‖ contentsDescription ‖ uint16(len)`. The
description is in explicit mode: every contents type sorted by name, as EIP-712
encodes them inside `TypedDataSign`, then the primary type's name. The owner is
anvil's second default key, the account `0xf470E70a46414C7aCb92aD6771da22b611C97303`
on chain 31337, and ECDSA signing is deterministic, so `cast wallet sign` gives
the same bytes. Every entry was also accepted by `isValidSignature` on a
`JustanAccount` deployed in forge with that owner.

```bash
PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
ACCOUNT=0xf470E70a46414C7aCb92aD6771da22b611C97303
ZERO=0x0000000000000000000000000000000000000000000000000000000000000000

# wrap <appDomainSeparator> <contentsStructHash> <sortedContentsType> <contentsName>
wrap() {
  local tds=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,bytes32,uint256,address,bytes32)" \
    $(cast keccak "TypedDataSign($4 contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)$3") \
    $2 $(cast keccak "JustanAccount") $(cast keccak "1") 31337 $ACCOUNT $ZERO))
  local sig=$(cast wallet sign --no-hash $(cast keccak $(cast concat-hex 0x1901 $1 $tds)) --private-key $PK)
  local desc=$(cast from-utf8 "$3$4")
  cast concat-hex $(cast abi-encode "f((uint256,bytes))" "(0,$sig)") $1 $2 $desc \
    $(printf '0x%04x' $(( (${#desc} - 2) / 2 )))
}
```

Third entry, `Order`, whose `Asset` dependency sorts before it:

```bash
ASSET=$(cast keccak $(cast abi-encode "f(bytes32,address,uint256)" \
  $(cast keccak "Asset(address token,uint256 id)") 0x3333333333333333333333333333333333333333 7))
ORDER=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256)" \
  $(cast keccak "Order(Asset asset,string memo,uint256 amount)Asset(address token,uint256 id)") \
  $ASSET $(cast keccak "hi") 42))
VAULT=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" \
  $(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)") \
  $(cast keccak "Vault") $(cast keccak "1") 8453 0x1111111111111111111111111111111111111111))

wrap $VAULT $ORDER "Asset(address token,uint256 id)Order(Asset asset,string memo,uint256 amount)" Order
```

The other entries follow the same steps with their own domain and struct hashes.
`PermitSingle` takes the sorted type
`PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)`
and the Permit2 domain `EIP712Domain(string name,uint256 chainId,address verifyingContract)`.
The fourth entry hashes its domain with the declared
`EIP712Domain(string name,string version,address verifyingContract)`, leaving
out the `chainId` the domain object carries, which is what the app contract
verifies against.

Two ways to derive something that looks right and is not: listing the primary
type first in the description (viem's implicit mode, which Solady turns into a
different `TypedDataSign` typehash whenever a dependency sorts before the primary
type), and hashing the app domain with the fields present in the domain object
instead of the declared `EIP712Domain`.

## Two things worth knowing

**The offsets point at the keys.** Solady's `WebAuthn.verify` compares the 21
bytes at `typeIndex` against the literal `"type":"webauthn.get"` and the 13
bytes at `challengeIndex` against `"challenge":"`. Pointing either one at the
value that follows the key fails verification on chain and nothing off chain
notices. That is where `challengeIndex ?? 23` and `typeIndex ?? 1` in
`toJustanAccount.ts` come from.

**`ownerIndex` is `uint256`, and used to be `uint8` here.** Reading the struct
is what surfaced it. The bytes are identical for any value that fits in a byte,
so the first three vectors do not move, but the narrower declaration made viem
refuse to encode past 255 for an index the contract accepts.

That ceiling is easier to reach than it looks. `MultiOwnable` hands out indices
from a counter that only goes up (`s_nextOwnerIndex++`), and removing an owner
deletes its slot without reusing the index or compacting the rest. So the limit
is on how many owners the account has ever had, not on how many it has now: an
account that has rotated owners 300 times has whatever owners it has today, and
if one of them sits at index 260 that owner could not sign through this SDK at
all. The fourth vector pins index 300, which the old declaration threw on.

## Changing a vector

Do not regenerate one because a test went red. A red vector means the bytes we
send no longer match the bytes the contract decodes, which is either a bug in
the encoder or a change in the contract. Say which, in the PR description.
