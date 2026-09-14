/**
 * Bridge lifecycle management — relay edition.
 *
 * - Generates a session token + ECDH keypair for new sessions
 * - Opens the browser to keys.jaw.id/cli-bridge
 * - Saves relay state to ~/.jaw/relay.json
 * - Creates a WSBridge client connected to the relay
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { PATHS } from './paths.js';
import { loadConfig } from './config.js';
import { WSBridge } from './ws-bridge.js';
import { isValidKeysUrl, isValidRelayUrl } from './validation.js';
import { generateKeyPair, exportKeyToHex } from './crypto.js';
import { type RelaySession, loadRelaySession, saveRelaySession, deleteRelaySession } from './relay-session.js';

const DEFAULT_KEYS_URL = 'https://keys.jaw.id';
const DEFAULT_RELAY_URL = 'wss://relay.jaw.id';

export interface BridgeOptions {
  keysUrl?: string;
  relayUrl?: string;
  apiKey: string;
  chainId?: number;
  ens?: string;
  timeout?: number;
  connectTimeout?: number;
}

/**
 * Get or create a relay bridge connection.
 */
export async function getBridge(options: BridgeOptions): Promise<WSBridge> {
  const config = loadConfig();
  // Both waits on a person: thirty seconds for the browser to reach the relay,
  // two minutes to approve once it is there. Those suit a browser this process
  // opened itself and nothing else. A first passkey, a URL carried to a phone,
  // or a machine with no browser to open takes longer than either before
  // anyone has done anything wrong, so one knob raises both.
  const envTimeout = Number(process.env['JAW_BRIDGE_TIMEOUT_MS']);
  const fromEnv = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : undefined;
  const timeout = options.timeout ?? fromEnv;
  // Resolved on its own, never from the caller's request timeout. Deriving it
  // meant `jaw rpc call --timeout 300` silently gave the browser five minutes
  // to connect, and then dropping that flag's default cut the same wait to
  // thirty seconds. Neither followed from anything the caller asked for.
  const connectTimeout = options.connectTimeout ?? fromEnv;
  const keysUrl = options.keysUrl ?? config.keysUrl ?? DEFAULT_KEYS_URL;
  const relayUrl = options.relayUrl ?? config.relayUrl ?? DEFAULT_RELAY_URL;
  const chainId = options.chainId ?? config.defaultChain ?? 1;
  if (!isValidKeysUrl(keysUrl)) {
    throw new Error(`Untrusted keysUrl: ${keysUrl}. Must be a *.jaw.id domain (HTTPS) or localhost.`);
  }
  if (!isValidRelayUrl(relayUrl)) {
    throw new Error(`Untrusted relayUrl: ${relayUrl}. Must be wss://*.jaw.id or ws://localhost.`);
  }

  // Try existing session first — but never open a browser for a stale session.
  // If the browser is already connected, reuse it. If not, fall through to a new session.
  let relaySession = loadRelaySession();
  if (relaySession && relaySession.relayUrl === relayUrl && relaySession.peerPublicKey) {
    try {
      // Deliberately not the long wait: nothing is opened here, so this only
      // asks whether the browser from an earlier command is still connected.
      // When it is not, the answer is to give up quickly and fall through to a
      // fresh session that does open one. Waiting the human-sized wait to find
      // that out leaves the command silent for as long as someone will stare at
      // it, having just told them a browser was opening.
      return await connectBridge({ ...options, timeout }, relaySession, chainId, keysUrl, relayUrl, false);
    } catch {
      // Connection failed — stale session or relay restarted.
      // Delete and fall through to create a new one.
      deleteRelaySession();
      relaySession = null;
    }
  } else if (relaySession) {
    // Incomplete session (no peer key) — discard
    deleteRelaySession();
  }

  // New session — this is the only path that opens a browser
  const session = await createNewSession(relayUrl);
  saveRelaySession(session);
  return await connectBridge({ ...options, timeout, connectTimeout }, session, chainId, keysUrl, relayUrl, true);
}

async function createNewSession(relayUrl: string): Promise<RelaySession> {
  const kp = await generateKeyPair();
  const privateKey = await exportKeyToHex('private', kp.privateKey);
  const publicKey = await exportKeyToHex('public', kp.publicKey);

  return {
    session: crypto.randomUUID(),
    relayUrl,
    privateKey,
    publicKey,
    peerPublicKey: null,
    startedAt: new Date().toISOString(),
  };
}

async function connectBridge(
  options: BridgeOptions,
  relaySession: RelaySession,
  chainId: number,
  keysUrl: string,
  relayUrl: string,
  openBrowser: boolean
): Promise<WSBridge> {
  const config = loadConfig();
  // Read as one entry, so the url and the context cannot come from different
  // paymasters. Looking it up per caller and forwarding the url alone loses a
  // configured `context` before it reaches the browser.
  const paymaster = config.paymasters?.[chainId];
  const bridge = new WSBridge({
    relayUrl,
    session: relaySession.session,
    timeout: options.timeout,
    connectTimeout: options.connectTimeout,
    config: {
      apiKey: options.apiKey,
      chainId,
      ens: options.ens ?? config.ens,
      paymasterUrl: paymaster?.url,
      paymasterContext: paymaster?.context,
    },
    privateKeyHex: relaySession.privateKey,
    publicKeyHex: relaySession.publicKey,
    peerPublicKeyHex: relaySession.peerPublicKey,
  });

  await bridge.connect(
    // onBrowserNeeded — only open a browser for new sessions
    openBrowser
      ? async () => {
          const bridgeUrl = buildBridgeUrl(keysUrl, relaySession.session, relayUrl, relaySession.publicKey);
          // Over SSH, in a container, or under a test driver, there is no
          // browser worth opening and `open` either does nothing or opens one on
          // the wrong machine, leaving the command waiting on an approval nobody
          // was told how to give. Printing the URL is the way out, and it goes
          // to stderr so it cannot land in the middle of `--output json`.
          if (process.env['JAW_NO_BROWSER']) {
            process.stderr.write(`Open this URL to approve:\n${bridgeUrl}\n`);
            return;
          }
          const { default: open } = await import('open');
          await open(bridgeUrl);
        }
      : undefined,
    // onPeerKeyChanged
    (newPeerKey) => {
      relaySession.peerPublicKey = newPeerKey;
      saveRelaySession(relaySession);
    }
  );

  return bridge;
}

function buildBridgeUrl(keysUrl: string, session: string, relayUrl: string, cliPublicKeyHex: string): string {
  const url = new URL('/cli-bridge', keysUrl);
  url.searchParams.set('session', session);
  url.searchParams.set('relay', relayUrl);
  // CLI public key in fragment — not sent to server
  url.hash = `pk=${cliPublicKeyHex}`;
  return url.toString();
}

/**
 * Shutdown: close the relay session and clean up.
 */
export async function shutdownDaemon(): Promise<void> {
  const session = loadRelaySession();
  if (!session) return;

  // Send shutdown directly — no init/ready handshake needed
  try {
    const bridge = new WSBridge({
      relayUrl: session.relayUrl,
      session: session.session,
      timeout: 5000,
      config: { apiKey: '', chainId: 1 },
      privateKeyHex: session.privateKey,
      publicKeyHex: session.publicKey,
      peerPublicKeyHex: session.peerPublicKey,
    });
    await bridge.connectAndShutdown();
  } catch {
    // Best effort — relay or browser may already be gone
  }

  deleteRelaySession();

  // Legacy cleanup: kill old daemon process and remove files
  const legacyBridge = PATHS.root + '/bridge.json';
  const legacyLog = PATHS.root + '/daemon.log';
  const legacyLock = PATHS.root + '/daemon.lock';
  try {
    if (fs.existsSync(legacyBridge)) {
      const info = JSON.parse(fs.readFileSync(legacyBridge, 'utf-8'));
      if (info.pid && Number.isInteger(info.pid) && info.pid > 0) {
        try {
          process.kill(info.pid, 'SIGTERM');
        } catch {
          /* already dead */
        }
      }
    }
  } catch {
    /* ignore */
  }
  for (const f of [legacyBridge, legacyLog, legacyLock]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}
