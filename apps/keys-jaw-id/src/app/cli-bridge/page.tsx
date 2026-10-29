'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState, Suspense, useRef, useCallback } from 'react';
import { JAW, Mode, getSupportedChains } from '@jaw.id/core';
import { ReactUIHandler } from '@jaw.id/ui';
import { MAX_FRAME_BYTES, parseInit, parseRequest } from '../../lib/bridge-frames';
import { keyProof, readLink, type BridgeLink } from '../../lib/bridge-proof';
import { resolveBridgeApiKey } from '../../lib/cli-api-key';
import { DEFAULT_BRIDGE_APP_NAME, resolveBridgeAppName } from '../../lib/bridge-app-name';
import {
  generateKeyPair,
  deriveSharedSecret,
  encrypt,
  decrypt,
  exportKeyToHexString,
  importKeyFromHexString,
} from '@jaw.id/core';

/**
 * CLI Bridge Page — Relay Mode
 *
 * Connects to the cloud relay (wss://relay.jaw.id) instead of a local daemon.
 * All messages are E2E encrypted via ECDH + AES-256-GCM.
 *
 * Flow:
 * 1. CLI generates ECDH keypair, opens this page with session + relay in query, CLI public key in fragment
 * 2. Page generates its own ECDH keypair
 * 3. Page connects to relay, sends key_exchange with its public key
 * 4. Both sides derive shared secret
 * 5. CLI sends encrypted init (apiKey, chainId, etc.)
 * 6. Page initializes JAW SDK, sends encrypted ready
 * 7. CLI sends encrypted RPC requests, page executes and sends encrypted responses
 * 8. A request repeated under the same id gets the answer already given
 */

type BridgeState = 'connecting' | 'connected' | 'disconnected' | 'error';

/** Base64 encode a Uint8Array or ArrayBuffer */
function toBase64(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Base64 decode to Uint8Array */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function encryptAndSerialize(
  sharedSecret: CryptoKey,
  payload: Record<string, unknown>
): Promise<{ type: 'encrypted'; iv: string; ciphertext: string }> {
  const { iv, cipherText } = await encrypt(sharedSecret, JSON.stringify(payload));
  return {
    type: 'encrypted',
    iv: toBase64(iv),
    ciphertext: toBase64(cipherText),
  };
}

async function deserializeAndDecrypt(
  sharedSecret: CryptoKey,
  msg: { iv: string; ciphertext: string }
): Promise<Record<string, unknown>> {
  const iv = fromBase64(msg.iv);
  const cipherText = fromBase64(msg.ciphertext);
  const plaintext = await decrypt(sharedSecret, { iv, cipherText: cipherText.buffer as ArrayBuffer });
  return JSON.parse(plaintext);
}

function CLIBridgeContent() {
  const searchParams = useSearchParams();
  const [state, setState] = useState<BridgeState>('connecting');
  const [error, setError] = useState('');
  const [lastMethod, setLastMethod] = useState<string | null>(null);
  const [appName, setAppName] = useState(DEFAULT_BRIDGE_APP_NAME);
  const sdkRef = useRef<ReturnType<typeof JAW.create> | null>(null);
  /** What `sdkRef` was built from, so a second init can tell whether it still fits. */
  const sdkSignatureRef = useRef<string | null>(null);
  /** The first name a client gave. A dialog may be open under it, so a later init cannot rename the page. */
  const appNameRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sharedSecretRef = useRef<CryptoKey | null>(null);
  /**
   * Every answer given in this relay session, by request id. An id is final,
   * refusals and errors included: a client that wants to try again sends a new id.
   */
  const answersRef = useRef(new Map<string, { request: string; reply: Promise<RpcResponse> }>());

  // A tab another tab replaced connects to nothing, even if its address still names a session.
  const replaced = searchParams.get('replaced') === '1';
  const sessionId = replaced ? null : searchParams.get('session');
  const relayUrl = replaced ? null : searchParams.get('relay');

  // The fragment is read once and stripped, so the first read lives in a ref to survive Strict Mode's second effect run.
  const linkRef = useRef<BridgeLink | null>(null);
  const [cliPublicKeyHex, setCliPublicKeyHex] = useState<string | null>(null);

  useEffect(() => {
    const link = (linkRef.current ??= readLink(window.location.hash.slice(1)));
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (link.kind === 'ok') {
      setCliPublicKeyHex(link.pk);
    } else {
      setState('error');
      setError(link.kind === 'damaged' ? LINK_DAMAGED : LINK_GONE);
    }
  }, []);

  // A client that lost its connection asks again under the same id, so it
  // gets the answer already given instead of a second dialog.
  const handleRpcRequest = useCallback(async (id: string, method: string, rawParams: unknown) => {
    const sdk = sdkRef.current;
    const secret = sharedSecretRef.current;
    const ws = wsRef.current;
    if (!sdk || !secret || !ws) return;

    const params = Array.isArray(rawParams) ? rawParams : rawParams !== undefined ? [rawParams] : [];
    const request = canonical({ method, params });
    let given = answersRef.current.get(id);
    if (!given) {
      given = { request, reply: ask(sdk, id, method, params) };
      answersRef.current.set(id, given);
      if (answersRef.current.size > ANSWERS_KEPT) answersRef.current.delete(answersRef.current.keys().next().value!);
      setLastMethod(method);
    }
    const reply = given.request === request ? await given.reply : idReused(id);
    ws.send(JSON.stringify(await encryptAndSerialize(secret, reply)));
  }, []);

  useEffect(() => {
    if (!sessionId || !relayUrl || !cliPublicKeyHex) return;

    let ws: WebSocket | null = null;
    let beforeUnloadHandler: (() => void) | null = null;
    let cancelled = false;
    let unanswered: ReturnType<typeof setTimeout> | undefined;
    answersRef.current = new Map();
    let clientPosted: string | undefined;

    (async () => {
      try {
        // Generate browser ECDH keypair
        const browserKeyPair = await generateKeyPair();
        const browserPublicKeyHex = await exportKeyToHexString('public', browserKeyPair.publicKey);

        // Derive shared secret using CLI's public key
        const cliPublicKey = await importKeyFromHexString('public', cliPublicKeyHex);
        const sharedSecret = await deriveSharedSecret(browserKeyPair.privateKey, cliPublicKey);

        if (cancelled) return;

        sharedSecretRef.current = sharedSecret;

        const linkSecret = linkRef.current?.kind === 'ok' ? linkRef.current.secret : undefined;
        const proof = linkSecret && (await keyProof(linkSecret, sessionId, cliPublicKeyHex, browserPublicKeyHex));
        if (cancelled) return;

        // Connect to relay
        const wsUrl = `${relayUrl}?session=${encodeURIComponent(sessionId)}&role=browser`;
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) return;
          setState('connected');
          // Send key_exchange (unencrypted — contains only our public key)
          ws!.send(
            JSON.stringify({
              type: 'key_exchange',
              publicKey: browserPublicKeyHex,
              ...(proof && { proof }),
            })
          );
          // The relay keeps no queue: when the server that made this link is
          // gone, the key exchange reaches nobody and nothing ever comes back.
          unanswered = setTimeout(() => {
            setState('error');
            setError(LINK_GONE);
          }, SERVER_WAIT_MS);
        };

        ws.onmessage = async (event) => {
          if (cancelled) return;
          if (typeof event.data === 'string' && event.data.length > MAX_FRAME_BYTES) {
            console.error('[cli-bridge] Dropped an oversized frame');
            return;
          }
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(event.data as string) as Record<string, unknown>;
          } catch {
            return;
          }

          const secret = sharedSecretRef.current;
          if (msg.type === 'encrypted' && secret) {
            const reply = async (frame: Record<string, unknown>) =>
              ws?.send(JSON.stringify(await encryptAndSerialize(secret, frame)));
            try {
              const inner = await deserializeAndDecrypt(secret, msg as { iv: string; ciphertext: string });

              switch (inner.type) {
                case 'init': {
                  clearTimeout(unanswered);
                  const parsed = parseInit(
                    inner,
                    getSupportedChains(true).map((c) => c.id)
                  );
                  if ('refused' in parsed) {
                    setState('error');
                    setError(parsed.refused);
                    await reply({ type: 'error', reason: parsed.refused });
                    return;
                  }
                  setState('connected');
                  const { chainId, ens, paymaster, client } = parsed;
                  if (client && client !== clientPosted) {
                    clientPosted = client;
                    reportBridgeClient(client);
                  }
                  const name = (appNameRef.current ??= resolveBridgeAppName(parsed.appName));
                  setAppName(name);

                  // A CLI that brought its own key keeps it, so anyone who wants
                  // their own attribution or their own limits sets one and
                  // nothing about their setup changes. Only the empty case is
                  // filled in, and it is filled in from the CLI's own workspace
                  // rather than this app's, which bills something else.
                  const sentApiKey = parsed.apiKey ?? '';
                  const apiKey = await resolveBridgeApiKey(sentApiKey);
                  if (!apiKey) {
                    const reason = `No API key: ${name} sent none and this deployment has none configured for it.`;
                    setState('error');
                    setError(reason);
                    // Said across the channel as well, because this page is not
                    // where the person is looking. Without it the CLI learns
                    // nothing for fifteen seconds and then reports a slow SDK,
                    // which names neither the missing key nor this deployment.
                    const failure = await encryptAndSerialize(sharedSecretRef.current!, {
                      type: 'error',
                      reason,
                    });
                    ws!.send(JSON.stringify(failure));
                    return;
                  }

                  // Rebuilt when the init it was built from changed, not only
                  // when there is none. A CLI re-sends init on reconnect, and
                  // the page it reconnects to is the one still open: keeping the
                  // first SDK meant the browser kept signing under the key, the
                  // chain and the paymaster of the previous run while the CLI
                  // recorded the new ones, and neither side could see the gap.
                  const signature = JSON.stringify({ chainId, ens, paymaster, apiKey, name });
                  if (!sdkRef.current || sdkSignatureRef.current !== signature) {
                    sdkSignatureRef.current = signature;
                    sdkRef.current = JAW.create({
                      appName: name,
                      defaultChainId: chainId,
                      preference: {
                        mode: Mode.AppSpecific,
                        uiHandler: new ReactUIHandler({ originLabel: 'via JAW bridge' }),
                        showTestnets: true,
                      },
                      apiKey,
                      ...(ens ? { ens } : {}),
                      ...(paymaster ? { paymasters: { [chainId]: paymaster } } : {}),
                    });
                  }

                  // Send encrypted ready, carrying the key back only when we
                  // are the ones who supplied it. Echoing a key the CLI already
                  // has would hand it something to store that it did not need,
                  // and this way it only ever persists what it lacked.
                  const readyEnvelope = await encryptAndSerialize(sharedSecretRef.current!, {
                    type: 'ready',
                    chainId,
                    replays: true,
                    ...(sentApiKey ? {} : { apiKey }),
                  });
                  ws!.send(JSON.stringify(readyEnvelope));
                  break;
                }

                case 'rpc_request': {
                  const request = parseRequest(inner);
                  if (request === 'no-id') {
                    console.error('[cli-bridge] Dropped a request with no string id');
                    break;
                  }
                  if ('refused' in request) {
                    await reply({
                      type: 'rpc_response',
                      id: request.id,
                      success: false,
                      error: { code: request.code, message: request.refused },
                    });
                    break;
                  }
                  handleRpcRequest(request.id, request.method, request.params).catch((err) =>
                    console.error('[cli-bridge] Failed to answer request:', err)
                  );
                  break;
                }

                case 'shutdown':
                  // Direct close is intentional: /cli-bridge is never embedded
                  // (its route keeps frame-ancestors 'none' / X-Frame-Options DENY).
                  // eslint-disable-next-line no-restricted-properties
                  window.close();
                  break;

                default:
                  await reply({ type: 'error', reason: `Unsupported message: ${String(inner.type)}` });
              }
            } catch (err) {
              console.error('[cli-bridge] Failed to decrypt/process message:', err);
            }
          }

          if (msg.type === 'ping') {
            ws!.send(JSON.stringify({ type: 'pong' }));
          }

          if (msg.type === 'error' && msg.code === 'session_expired') {
            setState('error');
            setError('Session expired. Start a new session to reconnect.');
          }
        };

        ws.onclose = (event) => {
          clearTimeout(unanswered);
          if (cancelled) return;
          if (event.code === REPLACED_BY_ANOTHER_TAB) {
            // The other tab is asked the same requests, so a dialog left open
            // here could approve one twice. Direct close is intentional:
            // /cli-bridge is never embedded (its route keeps
            // frame-ancestors 'none' / X-Frame-Options DENY).
            // eslint-disable-next-line no-restricted-properties
            window.close();
            // A browser may refuse to close a tab it did not open, so leave
            // the page too: the SDK and its dialog go with it.
            window.location.replace(REPLACED_URL);
            return;
          }
          setState('disconnected');
        };

        ws.onerror = () => {
          clearTimeout(unanswered);
          if (!cancelled) {
            setState('error');
            setError('Relay connection failed');
          }
        };

        beforeUnloadHandler = () => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.close(1000, 'Browser tab closed');
          }
        };
        window.addEventListener('beforeunload', beforeUnloadHandler);
      } catch (err) {
        console.error('[cli-bridge] Setup failed:', err);
        if (!cancelled) {
          setState('error');
          setError(err instanceof Error ? err.message : 'Failed to initialize encryption');
        }
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(unanswered);
      appNameRef.current = null;
      setAppName(DEFAULT_BRIDGE_APP_NAME);
      if (beforeUnloadHandler) {
        window.removeEventListener('beforeunload', beforeUnloadHandler);
      }
      if (ws) {
        ws.close();
      }
    };
  }, [sessionId, relayUrl, cliPublicKeyHex, handleRpcRequest]);

  if (replaced) {
    return (
      <div className="flex min-h-screen items-center justify-center font-sans">
        <div className="max-w-md p-12 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/jaw-logo.png" alt="JAW" className="mx-auto mb-4 block h-12 w-12 opacity-80" />
          <h1 className="text-foreground mb-4 text-xl font-semibold">Continued in another tab</h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            This link is open in another tab. You can close this one.
          </p>
        </div>
      </div>
    );
  }

  // Validation
  if (!sessionId || !relayUrl) {
    return (
      <div className="flex min-h-screen items-center justify-center font-sans">
        <div className="max-w-md p-12 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/jaw-logo.png" alt="JAW" className="mx-auto mb-4 block h-12 w-12 opacity-80" />
          <h1 className="text-foreground mb-4 text-xl font-semibold">{DEFAULT_BRIDGE_APP_NAME}</h1>
          <p className="text-destructive text-base font-semibold">Error</p>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            Missing required parameters: session, relay
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center font-sans">
      <div className="max-w-md p-12 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/jaw-logo.png" alt="JAW" className="mx-auto mb-4 block h-12 w-12 opacity-80" />
        <h1 className="text-foreground mb-4 text-xl font-semibold">{appName}</h1>

        {state === 'connecting' && (
          <p className="text-muted-foreground mb-4 text-sm leading-relaxed">Connecting to relay...</p>
        )}

        {state === 'connected' && (
          <>
            <p className="text-success text-base font-semibold">Connected</p>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
              This tab is the signing backend for {appName}.
              <br />
              Keep it open while it is in use.
            </p>
            {lastMethod && (
              <p className="text-muted-foreground bg-muted mt-4 rounded p-2 font-mono text-xs">
                Last request: {lastMethod}
              </p>
            )}
          </>
        )}

        {state === 'disconnected' && (
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            {appName} disconnected. You can close this tab.
          </p>
        )}

        {state === 'error' && (
          <>
            <p className="text-destructive text-base font-semibold">Error</p>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{error}</p>
          </>
        )}
      </div>
    </div>
  );
}

const LINK_GONE = 'This link is no longer active. Ask the agent for a new one.';
const LINK_DAMAGED = 'This link is damaged. Ask the agent for a new one.';

// The relay keeps one browser per session and closes the older socket with
// this code when the link is opened in another tab.
const REPLACED_BY_ANOTHER_TAB = 4003;

// Where a replaced tab goes: no session, relay or key, so it connects to nothing.
const REPLACED_URL = '/cli-bridge?replaced=1';

// A live server sends init as soon as the key exchange reaches it.
const SERVER_WAIT_MS = 20_000;

// A server re-asks within the 30 minute approval window, so the oldest answers
// can go once a long session of reads would otherwise keep them all.
const ANSWERS_KEPT = 500;

/** JSON with object keys sorted, so a request rebuilt from storage in another key order is still the same request. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Fire and forget: the bridge never waits on this and never shows a failure of it. */
function reportBridgeClient(client: string) {
  fetch('/api/bridge-client', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client }),
  }).catch(() => undefined);
}

type RpcResponse = Record<string, unknown> & { type: 'rpc_response'; id: string };

async function ask(
  sdk: ReturnType<typeof JAW.create>,
  id: string,
  method: string,
  params: unknown[]
): Promise<RpcResponse> {
  try {
    const result = await sdk.provider.request({ method, params });
    const address = extractAddress(method, result);
    return { type: 'rpc_response', id, success: true, data: result, ...(address ? { address } : {}) };
  } catch (err) {
    const errObj = err as { code?: number; message?: string };
    const code = errObj?.code ?? -32000;
    const message = errObj?.message ?? (err instanceof Error ? err.message : String(err));
    return { type: 'rpc_response', id, success: false, error: { code, message } };
  }
}

/** An id already answered for another request is refused, so an answer never covers a request it was not given for. */
const idReused = (id: string): RpcResponse => ({
  type: 'rpc_response',
  id,
  success: false,
  error: { code: -32600, message: 'this request id was already used for a different request' },
});

function extractAddress(method: string, result: unknown): string | undefined {
  if (method !== 'wallet_connect' && method !== 'eth_requestAccounts') return;

  if (Array.isArray(result) && typeof result[0] === 'string') {
    return result[0];
  }
  if (result && typeof result === 'object' && 'accounts' in result) {
    const accounts = (result as Record<string, unknown>).accounts;
    if (Array.isArray(accounts) && accounts.length > 0) {
      const first = accounts[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object' && 'address' in first) {
        return (first as Record<string, unknown>).address as string;
      }
    }
  }
  return undefined;
}

export default function CLIBridgePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center font-sans">
          <div className="max-w-md p-12 text-center">
            <p className="text-muted-foreground mb-4 text-sm leading-relaxed">Loading...</p>
          </div>
        </div>
      }
    >
      <CLIBridgeContent />
    </Suspense>
  );
}
