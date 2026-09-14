import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpError, mcpResult } from '../helpers.js';
import { keystoreExists } from '../../lib/keystore.js';
import { loadSessionConfig } from '../../lib/session-config.js';
import { sessionPayerAddress } from '../../x402/payer.js';
import { readLiveness } from '../../x402/permission-onchain.js';
import { recoverPermission } from '../../x402/permission-recovery.js';
import { loadConfig } from '../../lib/config.js';

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'jaw_session_status',
    {
      description:
        'Show the local session-key (auto mode) status — session address, owner, permission ID, ' +
        'chain, expiry, the x402 payer address, and what the chain says about the permission ' +
        '(permissionOnChain: active, revoked, unapproved, mismatch, or unknown when it could not be ' +
        'read). When a valid session exists, jaw_rpc can send ' +
        'transactions with session: true instead of opening the browser; personal_sign and ' +
        'eth_signTypedData_v4 stay on the browser either way. Sessions are created with ' +
        '`jaw session setup` in a terminal (requires a one-time browser passkey approval).',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        if (!keystoreExists()) {
          return mcpResult({
            exists: false,
            hint: 'No session key. Ask the user to run `jaw session setup` in a terminal to enable autonomous sends.',
          });
        }
        const config = loadSessionConfig();
        // The EOA that jaw_pay_and_fetch signs payments from, which is the
        // same address as sessionAddress: the session key, upgraded in place
        // via EIP-7702. NOT the address to fund: it refills from
        // ownerAddress through the permission, and money sent here directly
        // bypasses the granted cap. Non-fatal: a malformed key must not break
        // the whole status report.
        let payerAddress: string | undefined;
        try {
          payerAddress = sessionPayerAddress();
        } catch {
          payerAddress = undefined;
        }
        // The local file cannot know about a revoke made from keys.jaw.id or
        // from another machine, and an agent reading `expired: false` off it
        // would go on to spend against a permission that no longer exists.
        // Recovered here and not only in the commands: an agent is the consumer
        // this whole path exists for, and a session created before the struct
        // was stored would otherwise read `unknown` forever.
        const permission = await recoverPermission(config, loadConfig().apiKey);
        const current = permission ? { ...config, permission } : config;
        const permissionOnChain = await readLiveness(current);
        return mcpResult({
          exists: true,
          ...current,
          expired: config.expiry <= Date.now() / 1000,
          permissionOnChain,
          ...(payerAddress ? { payerAddress } : {}),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );
}
