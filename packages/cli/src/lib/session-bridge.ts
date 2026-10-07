import { SessionBridge as AgentSessionBridge, type SessionBridgeOptions, type SessionHost } from '@jaw.id/agent';
import { loadSessionKey } from './keystore.js';
import { loadSessionConfig } from './session-config.js';
import { loadConfig } from './config.js';
import { isRejectedApiKey } from './api-key.js';
import { stderrLogger } from './stderr-logger.js';

// Each read goes through at call time, not at import, so a module standing in
// for the session files is the one that answers.
const cliSessionHost: SessionHost = {
  loadSession: () => loadSessionConfig(),
  loadSessionKey: () => loadSessionKey(),
  configuredPaymaster: (chainId) => loadConfig().paymasters?.[chainId],
  /**
   * Only the key the browser handed us is refreshed. The deployment rotates it,
   * and every install keeps sending the old one until told otherwise, so a
   * refusal is how an install learns. A key the user set is theirs, and a
   * refusal of it surfaces as is.
   */
  async freshApiKey(err, refused) {
    if (!isRejectedApiKey(err) || refused !== loadConfig().workspaceApiKey) return undefined;
    // Lazy for the same reason core is: the browser bridge pulls in the
    // websocket client, and a payment that never needs it should not load it.
    const { refreshWorkspaceApiKey } = await import('./bridge-singleton.js');
    try {
      return await refreshWorkspaceApiKey();
    } catch {
      // No browser paired, or it did not answer. The proxy's own refusal is
      // the useful error here, not ours about the browser we went looking for.
      return undefined;
    }
  },
};

/** The session bridge on the session kept under ~/.jaw. */
export class SessionBridge extends AgentSessionBridge {
  constructor(options: Omit<SessionBridgeOptions, 'host' | 'logger'>) {
    super({ ...options, host: cliSessionHost, logger: stderrLogger });
  }
}
