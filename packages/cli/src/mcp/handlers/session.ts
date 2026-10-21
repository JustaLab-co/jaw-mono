import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import {
  type OrphanedPermission,
  buildX402Permissions,
  DEFAULT_X402_LIMIT,
  describeX402Grant,
  expiryInstant,
  grantPermissionsSchema,
  liveOrphans,
  mcpError,
  mcpResult,
  readLiveness,
  recoverPermission,
  sessionLives,
  sessionUsable,
  whyGrantExceedsCeiling,
} from '@jaw.id/agent';
import { sessionPayerAddress } from '../../x402/session-payer.js';
import { keystoreExists, loadSessionKey } from '../../lib/keystore.js';
import { loadSessionConfig, sessionFileStore, tryLoadSessionConfig } from '../../lib/session-config.js';
import { grantSession, orphanOf } from '../../lib/session-grant.js';
import { cliChainClients } from '../../x402/balance.js';
import { loadConfig } from '../../lib/config.js';
import { apiKeyFor } from '../../lib/api-key.js';
import { resolveChainId } from './rpc.js';

const DEFAULT_SESSION_EXPIRY_DAYS = 7;
// sessionExpiry is settable through jaw_config_set, so a grant asked for from
// here is held to this however long the config says.
const MAX_GRANT_EXPIRY_DAYS = 30;

interface GrantPermissionsParams {
  x402Budget?: { perDay: string };
  chainId?: number;
}

interface GrantExtra {
  _meta?: { progressToken?: string | number };
  sendNotification(notification: ServerNotification): Promise<void>;
}

/**
 * The key a new grant starts from and the permissions it carries forward.
 * Throws when a session is still active: this path never revokes or replaces
 * one, since the owner is not at a terminal to be asked.
 */
async function startingPoint(
  chainId: number
): Promise<{ reuseKey: `0x${string}` | null; orphaned: OrphanedPermission[] }> {
  if (!keystoreExists()) return { reuseKey: null, orphaned: [] };
  const existing = tryLoadSessionConfig();
  if (!existing) return { reuseKey: loadSessionKey() as `0x${string}`, orphaned: [] };

  const orphaned = liveOrphans(existing.orphanedPermissions);
  if (!sessionLives(existing.expiry)) return { reuseKey: null, orphaned };

  // Only a revoke read off the chain counts as over. A read that fails says
  // nothing, so the session is treated as active.
  const liveness = await readLiveness(existing, { clients: cliChainClients });
  if (liveness === 'revoked') return { reuseKey: null, orphaned: [orphanOf(existing), ...orphaned] };

  const ends = expiryInstant(existing.expiry);
  const where = existing.chainId === chainId ? `on chain ${chainId}` : `on chain ${existing.chainId}, not ${chainId}`;
  throw new Error(
    `A session is already active ${where}, until ${ends ? ends.toISOString() : 'a time the session file does not record'}. ` +
      'Pay with jaw_pay_and_fetch, which uses it. Replacing it needs the user to run `jaw session setup` in a terminal.'
  );
}

/** Hands the wallet URL to the client, so it can be shown when no browser opens. */
function urlNotifier(extra: GrantExtra): (url: string) => void {
  return (url) => {
    const message = `Ask the owner to open this URL and approve the budget in their wallet: ${url}`;
    const progressToken = extra._meta?.progressToken;
    const notification: ServerNotification =
      progressToken !== undefined
        ? { method: 'notifications/progress', params: { progressToken, progress: 0, message } }
        : { method: 'notifications/message', params: { level: 'info', logger: 'jaw', data: message } };
    extra.sendNotification(notification).catch(() => undefined);
  };
}

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
        'eth_signTypedData_v4 stay on the browser either way. Create a session with ' +
        'jaw_grant_permissions (the owner approves a daily USDC budget in their wallet), or the user ' +
        'can run `jaw session setup` in a terminal.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        if (!keystoreExists()) {
          return mcpResult({
            exists: false,
            hint:
              'No session key. Call jaw_grant_permissions to ask the owner for a payment budget, or ask the ' +
              'user to run `jaw session setup` in a terminal.',
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
        const permission = await recoverPermission(config, apiKeyFor(loadConfig()), { store: sessionFileStore });
        const current = permission ? { ...config, permission } : config;
        const permissionOnChain = await readLiveness(current, { clients: cliChainClients });
        return mcpResult({
          exists: true,
          ...current,
          // Reported the way the paying path answers it, not the way the
          // cleanup paths do: an agent reads this to decide whether to try, and
          // `SessionBridge` refuses to sign under an expiry it cannot read.
          expired: !sessionUsable(config.expiry),
          permissionOnChain,
          ...(payerAddress ? { payerAddress } : {}),
        });
      } catch (err) {
        return mcpError(err);
      }
    }
  );

  // One grant at a time: a second call would open a second browser for the
  // same owner while the first still waits.
  let waiting = false;

  // The SDK types its schemas against zod 4 and these are zod 3. Explicit
  // signature, the same as `jaw_pay_and_fetch`.
  type RegisterGrant = (
    name: string,
    config: { description: string; inputSchema: typeof grantPermissionsSchema },
    handler: (params: GrantPermissionsParams, extra: GrantExtra) => Promise<unknown>
  ) => void;
  (server.registerTool as unknown as RegisterGrant)(
    'jaw_grant_permissions',
    {
      description:
        'Ask the wallet owner for an x402 payment budget: a daily USDC allowance that ' +
        'jaw_pay_and_fetch pays and refills from. Creates the local session key and has the owner ' +
        'approve the grant with their passkey in the browser; the wallet URL is also sent as a ' +
        'notification, so show it to the user if no browser opens. Blocks until the owner answers ' +
        'or the approval times out. Call it when a payment tool reports there is no session. ' +
        'Refuses, without opening anything, when a session is already active (pay with ' +
        'jaw_pay_and_fetch) or when the budget is over the grant ceiling the user set in a terminal. ' +
        'It never revokes or replaces an existing session.',
      inputSchema: grantPermissionsSchema,
    },
    async (params, extra) => {
      if (waiting) {
        return mcpError(new Error('A grant is already waiting for the owner. Wait for that call to return.'));
      }
      waiting = true;
      try {
        const config = loadConfig();
        const chainId = resolveChainId(params.chainId, config);
        const limit = params.x402Budget ? `${params.x402Budget.perDay}/day` : DEFAULT_X402_LIMIT;
        const permissions = buildX402Permissions(chainId, limit);
        // Before the keystore and the bridge, and the ceiling itself is not
        // settable from here: only a person at a terminal moves it.
        const overCeiling = whyGrantExceedsCeiling(permissions, chainId, config.grantCeiling);
        if (overCeiling) throw new Error(overCeiling);

        const { reuseKey, orphaned } = await startingPoint(chainId);
        const expiryDays = Math.min(config.sessionExpiry ?? DEFAULT_SESSION_EXPIRY_DAYS, MAX_GRANT_EXPIRY_DAYS);
        const result = await grantSession({
          chainId,
          permissions,
          expiryDays,
          x402: true,
          reuseKey,
          orphaned,
          apiKey: apiKeyFor(config),
          onUrl: urlNotifier(extra),
        });

        const granted = {
          sessionAddress: result.sessionAddress,
          ownerAddress: result.ownerAddress,
          permissionId: result.permissionId,
          chainId: result.chainId,
          expiry: result.expiry,
          summary:
            `The owner granted ${describeX402Grant(limit)} on chain ${chainId} ` +
            `until ${new Date(result.expiry * 1000).toISOString()}. Pay with jaw_pay_and_fetch.`,
          ...(result.unfunded ? { unfunded: result.unfunded } : {}),
        };
        return { ...mcpResult(granted), structuredContent: granted };
      } catch (err) {
        return mcpError(err);
      } finally {
        waiting = false;
      }
    }
  );
}
