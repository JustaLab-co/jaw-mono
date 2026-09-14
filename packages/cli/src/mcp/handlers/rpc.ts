import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { rpcMethodSchema } from '../tools.js';
import { mcpError, mcpResult } from '../helpers.js';
import { getBridge } from '../../lib/bridge-singleton.js';
import { SessionBridge } from '../../lib/session-bridge.js';
import { supportsSessionMode } from '../../lib/rpc-classifier.js';
import { loadConfig } from '../../lib/config.js';
import { tryLoadSessionConfig } from '../../lib/session-config.js';
import type { JawConfig } from '../../lib/types.js';

function resolveApiKey(config: JawConfig): string {
  const apiKey = process.env['JAW_API_KEY'] ?? config.apiKey;
  if (!apiKey) {
    throw new Error('API key required. Set JAW_API_KEY env var or run: jaw config set apiKey <key>');
  }
  return apiKey;
}

function resolveChainId(paramChainId: number | undefined, config: JawConfig): number {
  if (paramChainId) return paramChainId;
  const envChainId = parseInt(process.env['JAW_CHAIN_ID'] ?? '', 10);
  if (Number.isInteger(envChainId) && envChainId > 0) return envChainId;
  return config.defaultChain ?? 1;
}

function envSessionEnabled(): boolean {
  const value = process.env['JAW_SESSION']?.toLowerCase();
  return value === '1' || value === 'true';
}

// Autonomous sends have no per-call human confirmation, so a prompt-injected
// agent could burst them. The window slows that down; the bound is the grant.
// A send only reaches a target and selector the permission lists, and a token it
// moves is metered against that token's period allowance: under `--x402` the
// allowance is the ceiling, under a hand-written scope whose `calls` have no
// matching `spends` the allowlist is, and nothing counts how often it fires.
// This window is per-process, so a restart starts a fresh one.
const SEND_RATE_WINDOW_MS = 60_000;
const MAX_SENDS_PER_WINDOW = 5;
const RATE_LIMITED_SESSION_METHODS = ['wallet_sendCalls'];

export function registerRpcTool(server: McpServer): void {
  // Per-server (per-process) sliding window over recent autonomous sends.
  const recentSends: number[] = [];
  function assertUnderSendLimit(): void {
    const now = Date.now();
    while (recentSends.length && now - recentSends[0] > SEND_RATE_WINDOW_MS) recentSends.shift();
    if (recentSends.length >= MAX_SENDS_PER_WINDOW) {
      throw new Error('Autonomous send rate limit reached, retry shortly or call again with session: false.');
    }
    recentSends.push(now);
  }

  // Same explicit signature the other tools use. A `@ts-expect-error` on the
  // handler stops covering anything once the error moves to the schema argument:
  // the directive then reports itself as unused, which is the failure mode the
  // cast is the house pattern against.
  type RegisterRpc = (
    name: string,
    config: { description: string; inputSchema: typeof rpcMethodSchema },
    handler: (params: { method: string; params?: unknown; chainId?: number; session?: boolean }) => Promise<unknown>
  ) => void;
  (server.registerTool as unknown as RegisterRpc)(
    'jaw_rpc',
    {
      description:
        'Execute any JAW.id wallet RPC method. ' +
        'Supports transactions, signing, permissions, and queries. ' +
        'By default, any method that uses the account opens the browser for passkey authentication. ' +
        'Pass session: true to send transactions autonomously with the local session key instead ' +
        '(requires a session created via `jaw session setup` — check jaw_session_status). ' +
        'Session mode sends, it does not sign: personal_sign and eth_signTypedData_v4 always open ' +
        'the browser, and asking for either with session: true is refused rather than routed. ' +
        'IMPORTANT: Read the jaw://api-reference resource for the full list of methods, ' +
        'and jaw://api-reference/{method} for detailed parameter formats and examples.',
      inputSchema: rpcMethodSchema,
    },
    async (params) => {
      try {
        const config = loadConfig();
        const apiKey = resolveApiKey(config);
        const useSession = params.session ?? envSessionEnabled();
        // In session mode the session's own chain is the only one that can
        // work: `SessionBridge` refuses any other, and an agent that never
        // asked for a chain would otherwise be told its session was made for
        // the wrong one. An explicit `chainId` still wins, so asking for a
        // different chain on purpose still gets that refusal.
        const chainId =
          useSession && params.chainId === undefined
            ? (tryLoadSessionConfig()?.chainId ?? resolveChainId(undefined, config))
            : resolveChainId(params.chainId, config);

        let bridge: { request(method: string, params?: unknown): Promise<unknown>; close(): void };

        if (useSession) {
          if (!supportsSessionMode(params.method)) {
            throw new Error(
              `Method ${params.method} is not supported in session mode. ` +
                'Call again with session: false to route through the browser bridge.'
            );
          }
          if (RATE_LIMITED_SESSION_METHODS.includes(params.method)) {
            assertUnderSendLimit();
          }
          bridge = new SessionBridge({ apiKey, chainId });
        } else {
          bridge = await getBridge({
            keysUrl: config.keysUrl,
            apiKey,
            chainId,
            ens: config.ens,
          });
        }

        try {
          const result = await bridge.request(params.method, params.params);
          return mcpResult(result);
        } finally {
          bridge.close();
        }
      } catch (err) {
        return mcpError(err);
      }
    }
  );
}
