# @jaw.id/cli

CLI + MCP Server for JAW.id smart accounts -- built for humans and AI agents.

Uses browser-based passkey authentication via keys.jaw.id -- no private key management needed for the account itself.

Two ways to use it. Drive your own account from a terminal or an agent, where anything touching the account opens the browser for a passkey. Or grant a session once and let an agent work on its own after that: the session holds a scoped on-chain permission, payments come out of your account through it, capped, and `jaw rpc call --session` signs the four methods it supports with the local key instead of the browser.

## Installation

```bash
# Run directly with npx
npx @jaw.id/cli <command>

# Install globally
npm install -g @jaw.id/cli
```

## Quick Start

An agent that hits a paywalled endpoint can pay it without asking you each time. That takes one browser approval, once.

```bash
# 1. Configure. Get an API key at https://dashboard.jaw.id;
#    the chain has no default, so it has to be set.
jaw config set apiKey=YOUR_API_KEY defaultChain=8453

# 2. Grant a session: opens the browser once for the on-chain approval
jaw session setup --chain 8453 --x402 --limit 25/day --expiry 14

# 3. Check what it can spend, and out of whose funds
jaw x402 status

# 4. Pay a 402. Dry run by default; --pay actually spends
jaw x402 pay https://api.example.com/resource
jaw x402 pay https://api.example.com/resource --pay

# 5. Read what was spent
jaw x402 log
```

Your account needs USDC on the chain you granted on. Payments are pulled from it through the permission, and the session pays its own gas in USDC too, so an empty account cannot do either.

## Driving Your Own Account

The other way to use it: every call goes to the browser and you approve it with a passkey.

```bash
# Connect (opens the browser for passkey auth)
jaw rpc call wallet_connect

# Send a transaction
jaw rpc call wallet_sendCalls '{"calls":[{"to":"0x...","value":"0x0"}]}'

# Check its status
jaw rpc call wallet_getCallsStatus '{"id":"0xBatchId"}'

# Close the relay session and the browser tab
jaw disconnect
```

## What a Session Is

`session setup` generates a key that lives on this machine and grants it a permission on your smart account. The permission is the bound, and a contract enforces it: how much per period, which token, which function, until when. Your funds stay in your account and are pulled through it.

The session key signs payments without a passkey prompt, which is what makes an agent autonomous. It is also why the permission matters: the key can only ever do what the permission says, and `jaw session revoke` ends it.

Two caps apply, and they are not the same thing. The on-chain permission is what the chain enforces. The local caps in `~/.jaw/config.json` are tighter limits you set underneath it, counted from a ledger this CLI keeps, and `jaw x402 log` reports the same figure those caps enforce.

An `upto` payment is worth its whole ceiling until a settlement is confirmed, so a failed attempt costs the ceiling against your caps rather than the charge. That is deliberate: until the chain says what moved, the ceiling is what a signed authorization is worth to whoever holds it.

### Paying Without an API Key

The payment path does not need one. `jaw x402 pay` never asks for an API key: it warns that a short payer cannot be refilled, and pays from whatever USDC the payer already holds.

A session is a different matter and it is required. The payer key is written by `session setup`, after the grant, so there is no payer without a permission behind it. Without one, `jaw x402 pay` stops with `No session key. Run jaw session setup`, and `jaw x402 status` says the same instead of reporting.

## How It Works

Anything that needs your account needs the browser, because that is where your passkey is. The CLI reaches it through a relay rather than a local server:

1. The CLI opens a relay session and writes it to `~/.jaw/relay.json`
2. It opens your browser to `keys.jaw.id/cli-bridge`, carrying the session id and the relay url
3. The page runs the JAW SDK and joins the same relay session
4. The two sides exchange keys, and from there every message is encrypted end to end with ECDH P-256 and AES-256-GCM. The relay forwards ciphertext it cannot read
5. The browser executes the request, prompting for your passkey when the account is involved
6. The reply comes back the same way

The relay session in `relay.json` outlives a single command, so pairing happens once and the browser tab stays usable across calls. Each call connects on demand, so there is no process in the background between them. `jaw disconnect` ends the session and closes the tab.

A session key skips all of this. Once `session setup` has granted a permission, `jaw x402 pay` and `jaw rpc call --session` sign locally, with no browser and no relay, which is what lets an agent work unattended.

## CLI Commands

### `jaw rpc call <method> [params]`

Execute any JAW.id RPC method via the browser bridge.

```bash
# Connect wallet
jaw rpc call wallet_connect

# Send transaction
jaw rpc call wallet_sendCalls '{"calls":[{"to":"0x...","value":"0x0","data":"0x..."}]}'

# Sign a message
jaw rpc call personal_sign '"Hello World"'

# Sign typed data (EIP-712)
jaw rpc call eth_signTypedData_v4 '["0xYOUR_ADDRESS", "{\"types\":{...},\"primaryType\":\"...\",\"domain\":{...},\"message\":{...}}"]'

# Grant permissions
jaw rpc call wallet_grantPermissions '{"expiry":1750000000,"spender":"0x...","permissions":{...}}'

# Get assets
jaw rpc call wallet_getAssets

# Get chain ID
jaw rpc call eth_chainId
```

| Flag            | Description                      | Default        |
| --------------- | -------------------------------- | -------------- |
| `-o, --output`  | Output format: `json` or `human` | `human`        |
| `-c, --chain`   | Chain ID                         | config default |
| `--api-key`     | JAW API key                      | config/env     |
| `-t, --timeout` | Request timeout (seconds)        | `120`          |
| `-y, --yes`     | Skip confirmations               | `false`        |
| `-q, --quiet`   | Suppress non-essential output    | `false`        |

### `jaw config show`

Display current configuration (API key redacted).

```bash
jaw config show
jaw config show --output json
```

### `jaw config set`

Set one or more configuration values.

```bash
jaw config set apiKey=your-api-key defaultChain=8453
jaw config set ens=yourdomain.eth keysUrl=https://keys.jaw.id
jaw config set sessionExpiry=14 grantCeiling=50/day

# The x402 caps too, by their dotted path
jaw config set x402.maxAmountPerPayment=1000000

# Legacy syntax also supported
jaw config set apiKey your-api-key
```

### `jaw session <setup|add|revoke|status>`

The session key and its on-chain permission.

```bash
# Grant a session with the x402 preset: a USDC transfer capped per period
jaw session setup --chain 8453 --x402 --limit 25/day --expiry 14

# Grant a hand-written permission instead
jaw session setup --chain 8453 --permissions ./permissions.json --expiry 14

# Add to what the session already holds (one approval to grant, one to revoke the old)
jaw session add --x402 --limit 50/day

# What the session is, and what the chain says about its permission
jaw session status

# End it: revoke on chain and delete the local key
jaw session revoke
```

`--limit` is `<amount>/<period>`, where the period is one of `minute`, `hour`, `day`, `week`, `month`, `year` or `forever`. Default `10/day`.

### `jaw x402 <pay|status|log>`

Paying for HTTP resources that answer `402`.

```bash
# Dry run: chooses a payment option and stops before spending
jaw x402 pay https://api.example.com/resource

# Actually pay
jaw x402 pay https://api.example.com/resource --pay

# A hard ceiling for this one call, in base units, on top of the policy
jaw x402 pay https://api.example.com/resource --pay --max-amount 50000

# Readiness: whose funds, which caps, what has been spent
jaw x402 status

# The ledger
jaw x402 log
jaw x402 log --limit 20
jaw x402 log --status failed
```

### `jaw disconnect`

Stop the background bridge daemon and close the browser session.

```bash
jaw disconnect
```

## Testing Guide

Full end-to-end testing sequence:

```bash
# 0. Setup
jaw config set apiKey=YOUR_API_KEY defaultChain=1

# 1. Connect wallet (opens browser, daemon starts)
jaw rpc call wallet_connect

# 2. Verify connection
jaw rpc call eth_accounts
jaw rpc call eth_chainId
jaw rpc call net_version

# 3. Read-only calls
jaw rpc call wallet_getAssets
jaw rpc call wallet_getCapabilities
jaw rpc call wallet_getPermissions
jaw rpc call wallet_getCallsHistory

# 4. Sign a message
jaw rpc call personal_sign '"Hello from JAW CLI"'

# 5. Sign typed data
jaw rpc call eth_signTypedData_v4 '["0xYOUR_ADDRESS", "{\"types\":{\"EIP712Domain\":[{\"name\":\"name\",\"type\":\"string\"}],\"Person\":[{\"name\":\"name\",\"type\":\"string\"}]},\"primaryType\":\"Person\",\"domain\":{\"name\":\"Test\"},\"message\":{\"name\":\"Alice\"}}"]'

# 6. Send transaction
jaw rpc call wallet_sendCalls '{"calls":[{"to":"0x0000000000000000000000000000000000000000","value":"0x0","data":"0x"}]}'

# 7. Switch chain
jaw rpc call wallet_switchEthereumChain '[{"chainId":"0x2105"}]'
jaw rpc call eth_chainId  # verify: should return 0x2105

# 8. Grant permissions
jaw rpc call wallet_grantPermissions '{"expiry":1750000000,"spender":"0x0000000000000000000000000000000000000001","permissions":{"calls":[{"target":"0x3232323232323232323232323232323232323232","selector":"0xe0e0e0e0"}],"spends":[{"token":"0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE","allowance":"0x2386F26FC10000","unit":"day","multiplier":1}]}}'

# 9. Verify permissions
jaw rpc call wallet_getPermissions

# 10. Revoke permissions (use permissionId from step 9)
jaw rpc call wallet_revokePermissions '{"id":"0xPERMISSION_ID_FROM_STEP_9"}'

# 11. Disconnect
jaw rpc call wallet_disconnect
jaw rpc call eth_accounts  # should return []

# 12. Stop daemon
jaw disconnect
```

## MCP Server (for AI Agents)

Start the MCP server:

```bash
jaw mcp
```

### MCP Configuration

**Claude Code** (`~/.claude.json`):

```json
{
  "mcpServers": {
    "jaw": {
      "command": "npx",
      "args": ["@jaw.id/cli", "mcp"],
      "env": {
        "JAW_API_KEY": "your-api-key"
      }
    }
  }
}
```

### MCP Tools

| Tool                 | Description                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `jaw_rpc`            | Execute any JAW.id wallet RPC method. Opens the browser for a passkey on anything that uses the account.            |
| `jaw_pay_and_fetch`  | Fetch an HTTP resource, paying an x402 challenge with the local session key when one appears. No browser.           |
| `jaw_x402_log`       | Read the local payment ledger: every attempt, paid, failed or refused, with amount, asset, network, nonce and hash. |
| `jaw_x402_balance`   | The session payer's USDC balance on a network. The payment float, not the budget.                                   |
| `jaw_discover`       | Search the x402 Bazaar for payable endpoints. The catalog is fenced as untrusted.                                   |
| `jaw_session_status` | The local session: address, owner, permission id, chain, expiry, and what the chain says about the permission.      |
| `jaw_status`         | Whether a browser-paired relay session exists, and the configuration in use.                                        |
| `jaw_disconnect`     | Close the relay session and the browser tab.                                                                        |
| `jaw_config_show`    | Show the current CLI configuration, secrets redacted.                                                               |
| `jaw_config_set`     | Set a CLI configuration value.                                                                                      |

### MCP Resources

| Resource                       | Contents                                                                |
| ------------------------------ | ----------------------------------------------------------------------- |
| `jaw://x402`                   | How paying a 402 works here: the schemes, the caps, the ledger.         |
| `jaw://api-reference`          | The RPC methods `jaw_rpc` accepts, with a description of each.          |
| `jaw://api-reference/{method}` | One method in detail: parameters, request and response shape, examples. |

### Example Agent Usage

```
Agent: jaw_rpc({ method: "wallet_sendCalls", params: { calls: [{ to: "0x...", value: "0x0" }] } })
  -> Daemon forwards to browser -> user signs with passkey -> result returned to agent
```

## Environment Variables

| Variable                | Description                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- |
| `JAW_API_KEY`           | JAW API key                                                                   |
| `JAW_CHAIN_ID`          | Default chain ID                                                              |
| `JAW_OUTPUT`            | Output format (`json` or `human`)                                             |
| `JAW_SESSION`           | Default for `--session` on `jaw rpc call` and for `session` on `jaw_rpc`      |
| `JAW_NO_BROWSER`        | Print the pairing url instead of opening a browser. For headless machines     |
| `JAW_BRIDGE_TIMEOUT_MS` | How long to wait on the browser: reaching the relay, and approving once there |

## Configuration

Config file: `~/.jaw/config.json`

```json
{
  "apiKey": "your-api-key",
  "defaultChain": 8453,
  "keysUrl": "https://keys.jaw.id",
  "ens": "yourdomain.eth",
  "sessionExpiry": 14,
  "x402": {
    "maxAmountPerPayment": "1000000",
    "maxTotalPerSession": "10000000"
  }
}
```

The figures under `x402` are in base units, so `1000000` is 1 USDC. They are the caps this CLI enforces underneath the on-chain permission, and `jaw x402 status` shows what they resolve to.

Runtime state lives in `~/.jaw/`, all of it mode 0600:

| File                  | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `config.json`         | User configuration                                                     |
| `relay.json`          | The relay session that pairs this machine with the browser             |
| `keystore.json`       | The session key. Whoever holds it can do what the permission allows    |
| `session-config.json` | Which permission the session holds, on which chain, until when         |
| `x402-log.jsonl`      | The payment ledger. Append-only, and what the local spend caps count   |
| `x402-payment.lock`   | Held while a payment runs, so two of them cannot spend the same budget |

Two of those are worth knowing about. `keystore.json` is a key that signs payments without a passkey prompt, so treat it as one; what bounds it is the on-chain permission, not the file. And `x402-log.jsonl` is not a log: the spend caps are counted from it, so deleting it hands an agent back budget it already spent.

## License

[Apache-2.0](./LICENSE)
