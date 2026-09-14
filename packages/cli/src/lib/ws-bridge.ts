/**
 * WSBridge — CLI-side relay client
 *
 * Connects to the cloud relay (wss://relay.jaw.id) instead of a local daemon.
 * All messages (except key_exchange) are E2E encrypted via ECDH + AES-256-GCM.
 */

import * as crypto from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import WebSocket from 'ws';
import {
  deriveSharedSecret,
  encryptMessage,
  decryptMessage,
  importKeyFromHex,
  type EncryptedEnvelope,
} from './crypto.js';

type CKey = webcrypto.CryptoKey;

export interface WSBridgeConfig {
  /** Absent on a first connect from a machine that has none. */
  apiKey?: string;
  chainId: number;
  ens?: string;
  paymasterUrl?: string;
  paymasterContext?: Record<string, unknown>;
}

export interface WSBridgeOptions {
  relayUrl: string;
  session: string;
  timeout?: number;
  /** How long to wait for the browser to connect. See DEFAULT_CONNECT_TIMEOUT_MS. */
  connectTimeout?: number;
  config: WSBridgeConfig;
  /** CLI's ECDH private key (hex). Loaded from relay.json for existing sessions. */
  privateKeyHex: string;
  /** CLI's ECDH public key (hex). Sent to browser for key derivation. */
  publicKeyHex: string;
  /** Browser's ECDH public key (hex). Null if new session (key exchange needed). */
  peerPublicKeyHex: string | null;
}

/**
 * The `init` payload the CLI hands the browser once the shared secret exists.
 *
 * A function rather than an object literal inside the handshake so what crosses
 * the bridge can be asserted without standing up a relay and a socket.
 *
 * `paymasterContext` travels with its url or not at all. The two name one
 * paymaster between them, and the browser resolves a url of its own when none
 * arrives — a context sent alone would be applied to whichever paymaster that
 * turns out to be, which is the divergence the SDK-side resolution just closed.
 */
export function buildInitPayload(config: WSBridgeConfig): Record<string, unknown> {
  return {
    type: 'init',
    // Omitted rather than empty when there is none: the browser reads the
    // field's absence as "fill one in", and an empty string would have to mean
    // the same thing in a second place.
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    chainId: config.chainId,
    ens: config.ens,
    paymasterUrl: config.paymasterUrl,
    ...(config.paymasterUrl && config.paymasterContext ? { paymasterContext: config.paymasterContext } : {}),
  };
}

/**
 * The api key the browser filled in, off the `ready` it answers with.
 *
 * A function rather than a read inside the socket handler, for the same reason
 * `buildInitPayload` is one: what crosses the bridge can then be asserted
 * without standing up a relay.
 *
 * Null covers both absences, and neither is an error. An older browser does not
 * send the field at all, and a current one omits it whenever the CLI arrived
 * with a key of its own, since echoing that back would hand the CLI something
 * to store that it already had.
 */
export function readInjectedApiKey(inner: Record<string, unknown>): string | null {
  const apiKey = inner['apiKey'];
  return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : null;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * How long to wait for the browser to reach the relay, which is a different
 * wait from `DEFAULT_TIMEOUT_MS`: that one covers approving a request once the
 * page is there, this one covers the page arriving at all. Thirty seconds fits
 * a browser this process opened itself and nothing else. A URL carried to a
 * phone, a first passkey enrolment, or a machine with no browser to open takes
 * longer than that before anyone has done anything wrong.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Maximum outbound message size (5 MB).
 *
 * wallet_sendCalls with large batches (50+ calls, complex calldata) can reach
 * hundreds of KB. Base64 encoding of the AES-GCM ciphertext adds ~33% overhead.
 * 5 MB is generous enough for any realistic batch while still preventing
 * accidental memory issues.
 */
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

/** Minimum time between browser reopen attempts (ms). */
const BROWSER_REOPEN_COOLDOWN_MS = 5_000;

/** Maximum reconnection attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

/** Base delay for exponential backoff (ms). */
const RECONNECT_BASE_DELAY_MS = 1_000;

export class WSBridge {
  private readonly relayUrl: string;
  private readonly session: string;
  private readonly timeout: number;
  private readonly connectTimeout: number;
  private readonly config: WSBridgeConfig;
  private readonly privateKeyHex: string;
  readonly publicKeyHex: string;
  /**
   * The api key the browser supplied on `ready`, present only when it filled in
   * one the CLI did not have. Read after `connect` resolves; the caller owns
   * whether to keep it, because this class does not touch the config file.
   */
  injectedApiKey: string | null = null;
  private peerPublicKeyHex: string | null;
  private sharedSecret: CKey | null = null;
  private ws: WebSocket | null = null;
  private disposed = false;

  // Auto-reopen browser state
  private onBrowserNeeded: (() => Promise<void>) | undefined;
  private onPeerKeyChanged: ((key: string) => void) | undefined;
  private lastBrowserOpenTime = 0;

  // Reconnection state
  private reconnectAttempts = 0;

  /** Updated after key exchange — caller should persist this. */
  get peerPublicKey(): string | null {
    return this.peerPublicKeyHex;
  }

  constructor(options: WSBridgeOptions) {
    this.relayUrl = options.relayUrl;
    this.session = options.session;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.config = options.config;
    this.privateKeyHex = options.privateKeyHex;
    this.publicKeyHex = options.publicKeyHex;
    this.peerPublicKeyHex = options.peerPublicKeyHex;
  }

  /**
   * Connect to the relay and wait for the browser to be ready.
   *
   * @param onBrowserNeeded — called when the relay reports no browser connected.
   * @param onPeerKeyChanged — called when a key_exchange updates the peer key.
   */
  async connect(
    onBrowserNeeded?: () => Promise<void>,
    onPeerKeyChanged?: (newPeerPublicKeyHex: string) => void
  ): Promise<void> {
    // Store callbacks for auto-reopen on browser disconnect
    this.onBrowserNeeded = onBrowserNeeded;
    this.onPeerKeyChanged = onPeerKeyChanged;

    // Pre-derive shared secret if we already have the peer key
    if (this.peerPublicKeyHex) {
      await this.deriveSecret();
    }

    return this.connectInternal(onBrowserNeeded, onPeerKeyChanged);
  }

  private async connectInternal(
    onBrowserNeeded?: () => Promise<void>,
    onPeerKeyChanged?: (newPeerPublicKeyHex: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.relayUrl}?session=${encodeURIComponent(this.session)}&role=cli`;
      const ws = new WebSocket(url);

      let browserOpened = false;
      let resolved = false;
      let expectingKeyExchange = !this.peerPublicKeyHex;

      const timer = setTimeout(() => {
        ws.close();
        reject(
          new Error(
            `Browser did not connect within ${Math.round(this.connectTimeout / 1000)}s.\n` +
              'Run `jaw disconnect` then try again, or raise JAW_BRIDGE_TIMEOUT_MS.'
          )
        );
      }, this.connectTimeout);

      const sendEncryptedInit = async () => {
        if (!this.sharedSecret) return;
        const envelope = await encryptMessage(this.sharedSecret, buildInitPayload(this.config));
        this.sendRaw(ws, JSON.stringify({ type: 'encrypted', ...envelope }));
      };

      const waitForReady = () => {
        const readyTimer = setTimeout(() => {
          ws.close();
          reject(new Error('Browser SDK did not become ready in time.'));
        }, 15_000);

        const onMsg = async (data: WebSocket.Data) => {
          const msg = safeParse(data);
          if (!msg) return;

          if (msg.type === 'encrypted' && this.sharedSecret) {
            try {
              const inner = await decryptMessage(this.sharedSecret, msg as unknown as EncryptedEnvelope);
              if (inner.type === 'ready') {
                clearTimeout(readyTimer);
                ws.off('message', onMsg);
                this.reconnectAttempts = 0; // Reset on successful connect
                const injected = readInjectedApiKey(inner as Record<string, unknown>);
                if (injected) this.injectedApiKey = injected;
                resolve();
              }
            } catch {
              // Not a valid encrypted message for us, ignore
            }
          }
        };
        ws.on('message', onMsg);
      };

      const onBrowserReady = async () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        // Set up listener BEFORE sending init to avoid missing the ready response
        waitForReady();
        await sendEncryptedInit();
      };

      ws.on('open', () => {
        this.ws = ws;
      });

      ws.on('message', async (data) => {
        const msg = safeParse(data);
        if (!msg) return;

        if (msg.type === 'status') {
          if (msg.browserConnected) {
            if (this.sharedSecret) {
              // Already have shared secret — skip key exchange
              await onBrowserReady();
            } else {
              // Browser is connected but we don't have its key yet.
              expectingKeyExchange = true;
            }
          } else if (!browserOpened && onBrowserNeeded) {
            browserOpened = true;
            expectingKeyExchange = true;
            onBrowserNeeded().catch(() => {
              /* best effort */
            });
          } else if (!onBrowserNeeded) {
            // Reuse path (bridge-singleton.ts called connectBridge with
            // openBrowser=false): the relay reports no browser connected and
            // we have no callback to open one. Bail immediately so the
            // caller can fall through to a fresh session, instead of waiting
            // out the 30s connect-timer.
            clearTimeout(timer);
            ws.close();
            reject(new Error('Browser not connected — relay session is stale.'));
          }
        } else if (msg.type === 'browser_connected') {
          expectingKeyExchange = true;
          // Wait for key_exchange from browser
        } else if (msg.type === 'browser_disconnected') {
          // Browser tab closed — attempt to reopen after cooldown
          this.handleBrowserDisconnect();
        } else if (msg.type === 'key_exchange' && expectingKeyExchange) {
          expectingKeyExchange = false;
          const peerKey = msg.publicKey as string;
          this.peerPublicKeyHex = peerKey;
          await this.deriveSecret();
          onPeerKeyChanged?.(peerKey);
          await onBrowserReady();
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.on('close', () => {
        clearTimeout(timer);
        if (!this.disposed) {
          this.handleRelayDisconnect();
        }
      });
    });
  }

  /**
   * Send an encrypted RPC request through the relay to the browser SDK.
   */
  async request(method: string, params?: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to relay');
    }
    if (!this.sharedSecret) {
      throw new Error('No shared secret — key exchange not completed');
    }

    const id = crypto.randomUUID();

    const envelope = await encryptMessage(this.sharedSecret, {
      type: 'rpc_request',
      id,
      method,
      params,
    });

    const serialized = JSON.stringify({ type: 'encrypted', ...envelope });
    assertMessageSize(serialized, method);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`Request timed out after ${this.timeout / 1000}s. ` + 'Did you complete the action in the browser?')
        );
        this.close();
      }, this.timeout);

      const onMessage = async (data: WebSocket.Data) => {
        const msg = safeParse(data);
        if (!msg || msg.type !== 'encrypted' || !this.sharedSecret) return;

        try {
          const inner = await decryptMessage(this.sharedSecret, msg as unknown as EncryptedEnvelope);
          if (inner.type === 'rpc_response' && inner.id === id) {
            clearTimeout(timer);
            ws.off('message', onMessage);

            if (inner.success) {
              resolve(inner.data);
            } else {
              const err = inner.error as { code: number; message: string } | undefined;
              reject(new Error(err ? `[${err.code}] ${err.message}` : 'Request failed'));
            }
          }
        } catch {
          // Decryption failed — not our message or tampered, ignore
        }
      };

      ws.on('message', onMessage);
      this.sendRaw(ws, serialized);
    });
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    if (this.ws?.readyState === WebSocket.OPEN && this.sharedSecret) {
      try {
        const envelope = await encryptMessage(this.sharedSecret, {
          type: 'shutdown',
        });
        this.sendRaw(this.ws, JSON.stringify({ type: 'encrypted', ...envelope }));
      } catch {
        // Best effort
      }
    }
    this.close();
  }

  /**
   * Connect to relay and send shutdown directly — no init/ready handshake.
   * Used by `jaw disconnect` when we just need to tell the browser to close.
   */
  async connectAndShutdown(): Promise<void> {
    if (!this.peerPublicKeyHex) {
      // No peer key means browser never connected — nothing to shut down
      return;
    }

    this.disposed = true;
    await this.deriveSecret();

    return new Promise<void>((resolve) => {
      const url = `${this.relayUrl}?session=${encodeURIComponent(this.session)}&role=cli`;
      const ws = new WebSocket(url);

      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);

      ws.on('open', async () => {
        this.ws = ws;
        try {
          await this.shutdown();
        } catch {
          // Best effort
        }
        clearTimeout(timer);
        resolve();
      });

      ws.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    this.disposed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  /**
   * Auto-reopen browser when browser_disconnected is received from relay.
   * Respects a cooldown to prevent rapid re-opening.
   */
  private handleBrowserDisconnect(): void {
    if (this.disposed || !this.onBrowserNeeded) return;

    const now = Date.now();
    if (now - this.lastBrowserOpenTime < BROWSER_REOPEN_COOLDOWN_MS) {
      return; // Too soon — skip this reopen
    }

    this.lastBrowserOpenTime = now;

    // Reset shared secret — the new browser tab will do a fresh key exchange
    this.sharedSecret = null;
    this.peerPublicKeyHex = null;

    this.onBrowserNeeded().catch(() => {
      // Best effort — if browser open fails, the next request will error
    });
  }

  /**
   * Attempt to reconnect to the relay with exponential backoff
   * when the WebSocket connection drops unexpectedly.
   */
  private handleRelayDisconnect(): void {
    if (this.disposed) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;

    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    setTimeout(() => {
      if (this.disposed) return;
      this.connectInternal(this.onBrowserNeeded, this.onPeerKeyChanged).catch(() => {
        // Reconnection failed — will retry if attempts remain
      });
    }, delay);
  }

  /** Send a raw string over the WebSocket, enforcing message size limits. */
  private sendRaw(ws: WebSocket, data: string): void {
    ws.send(data);
  }

  private async deriveSecret(): Promise<void> {
    if (!this.peerPublicKeyHex) return;
    const privateKey = await importKeyFromHex('private', this.privateKeyHex);
    const peerPublicKey = await importKeyFromHex('public', this.peerPublicKeyHex);
    this.sharedSecret = await deriveSharedSecret(privateKey, peerPublicKey);
  }
}

/**
 * Validate message size before sending to the relay.
 * Throws with a descriptive error if the message is too large.
 */
function assertMessageSize(serialized: string, method: string): void {
  const byteLength = Buffer.byteLength(serialized, 'utf-8');
  if (byteLength > MAX_MESSAGE_BYTES) {
    const sizeMB = (byteLength / (1024 * 1024)).toFixed(2);
    throw new Error(
      `Message for ${method} is too large (${sizeMB} MB, limit ${MAX_MESSAGE_BYTES / (1024 * 1024)} MB). ` +
        'Try reducing the number of calls in your batch.'
    );
  }
}

function safeParse(data: WebSocket.Data): Record<string, unknown> | null {
  try {
    return JSON.parse(data.toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
