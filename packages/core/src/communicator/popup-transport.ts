import { SDK_VERSION } from '../sdk-info.js';
import { Message, MessageID } from '../messages/message.js';
import { ConfigMessage } from '../messages/configMessage.js';
import { standardErrors } from '../errors/errors.js';
import { isMobile } from '../utils/user-agent.js';
import { Transport, TransportOptions } from './transport.js';
import type { JawTheme } from '../ui/theme.js';

const POPUP_WIDTH = 420;
const POPUP_HEIGHT = 730;
const HANDSHAKE_TIMEOUT = 60_000;
const OPENER_PING_INTERVAL_MS = 500;

/**
 * Popup transport: window.open to the keys URL.
 *
 * Extracted from Communicator with behavior intentionally identical:
 * same window features, same handshake (PopupLoaded -> config -> PopupReady),
 * same teardown semantics. The Communicator facade delegates here.
 */
export class PopupTransport implements Transport {
    readonly kind = 'popup' as const;

    private readonly url: URL;
    private readonly options: TransportOptions;
    private popup: Window | null = null;
    private openerPing: ReturnType<typeof setInterval> | undefined;
    private listeners = new Map<(_: MessageEvent) => void, { reject: (_: Error) => void }>();

    constructor(options: TransportOptions) {
        this.url = options.url;
        this.options = options;
    }

    /**
     * Open the popup (if needed) and complete the handshake.
     */
    async ensureReady(): Promise<Window> {
        // If popup exists and is not closed, return it
        if (this.popup && !this.popup.closed) {
            this.popup.focus();
            return this.popup;
        }

        this.popup = this.openPopup();

        this.onMessage<ConfigMessage>(({ event }) => event === 'PopupUnload')
            .then(() => {
                // The user closed the popup window — reject the in-flight dApp
                // request (which waits on the facade, not this transport) before
                // tearing the popup down. destroy() stays pure teardown so the
                // normal disconnect() path doesn't double-fire onDismiss.
                this.options.onDismiss?.();
                this.destroy();
            })
            .catch(() => {
                /* empty */
            });

        // Keys takes the dApp origin from document.referrer, and a dApp served
        // with `Referrer-Policy: no-referrer` or `same-origin` leaves it empty.
        // The popup then holds PopupLoaded until a message from this window
        // gives it the origin, while the config below waits on PopupLoaded, so
        // neither side would ever speak. Ping until it loads: the ping carries
        // nothing, and the browser, not the ping, supplies the origin it reads.
        this.startOpenerPing();
        const loaded = this.onMessage<ConfigMessage>(({ event }) => event === 'PopupLoaded', {
            timeout: HANDSHAKE_TIMEOUT,
        });
        loaded.then(
            () => this.stopOpenerPing(),
            () => this.stopOpenerPing()
        );

        return loaded
            .then((message) => {
                this.postToTarget({
                    requestId: message.id,
                    data: {
                        version: SDK_VERSION,
                        metadata: this.options.metadata,
                        preference: this.options.preference,
                        theme: this.options.theme,
                        location: window.location.toString(),
                        lastAccount: this.options.getLastAccount?.(),
                        apiKey: this.options.getApiKey?.(),
                    },
                });
                return message.id;
            })
            .then((handshakeId) => {
                // Bind PopupReady to this handshake's id so a stale one can't resolve it.
                return this.onMessage<ConfigMessage>(
                    ({ event, requestId }) => event === 'PopupReady' && requestId === handshakeId,
                    { timeout: HANDSHAKE_TIMEOUT }
                );
            })
            .then(() => {
                if (!this.popup) throw standardErrors.rpc.internal();
                return this.popup;
            });
    }

    /**
     * Posts a message to the popup window, opening it first if necessary.
     */
    postMessage = async (message: Message): Promise<void> => {
        const popup = await this.ensureReady();
        popup.postMessage(message, this.url.origin);
    };

    isAlive(): boolean {
        return this.popup !== null && !this.popup.closed;
    }

    /**
     * Listen for messages from the keys origin matching a predicate.
     */
    async onMessage<M extends Message>(
        predicate: (msg: Partial<M>) => boolean,
        { timeout }: { timeout?: number } = {}
    ): Promise<M> {
        return new Promise<M>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;

            // Remove the listener and clear the timeout on any settle path.
            const cleanup = () => {
                window.removeEventListener('message', listener);
                this.listeners.delete(listener);
                if (timer !== undefined) clearTimeout(timer);
            };

            const listener = (event: MessageEvent) => {
                // Validate origin and source (the popup we opened)
                if (event.origin !== this.url.origin) return;
                if (!this.matchesSource(event.source)) return;

                const message = event.data;
                if (predicate(message)) {
                    cleanup();
                    resolve(message);
                }
            };

            window.addEventListener('message', listener);
            this.listeners.set(listener, {
                reject: (error: Error) => {
                    cleanup();
                    reject(error);
                },
            });

            if (timeout !== undefined && timeout !== Infinity) {
                timer = setTimeout(() => {
                    this.listeners
                        .get(listener)
                        ?.reject(standardErrors.rpc.internal('Timed out waiting for popup message'));
                }, timeout);
            }
        });
    }

    matchesSource(source: MessageEventSource | null): boolean {
        // Tolerant of a null source (synthetic events): enforce only when present.
        return !source || source === this.popup;
    }

    /**
     * Post request and wait for the matching response.
     */
    async postRequestAndWaitForResponse<M extends Message>(request: Message & { id: MessageID }): Promise<M> {
        const responsePromise = this.onMessage<M>(({ requestId }) => requestId === request.id);
        await this.postMessage(request);
        return await responsePromise;
    }

    /**
     * Push a new dApp theme to the live popup and onto future handshakes. The
     * popup is transient (re-handshaken per flow), so this mainly keeps a long-
     * lived popup in sync; the updated theme also rides the next handshake.
     */
    setTheme(theme: JawTheme | undefined): void {
        this.options.theme = theme;
        if (!this.popup || this.popup.closed) return;
        try {
            this.popup.postMessage({ event: 'SetTheme', data: { theme } }, this.url.origin);
        } catch {
            /* window gone; the updated theme rides the next handshake */
        }
    }

    /**
     * Close the popup, reject all pending listeners, release resources.
     */
    destroy(): void {
        this.stopOpenerPing();
        if (this.popup && !this.popup.closed) {
            this.popup.close();
        }
        this.popup = null;

        // Reject all pending listeners; each reject() cleans up via cleanup().
        this.listeners.forEach(({ reject }) => {
            reject(standardErrors.provider.userRejectedRequest('Request rejected'));
        });
        this.listeners.clear();
    }

    /**
     * Posts directly to the already-open popup (handshake internals).
     */
    private postToTarget(message: Message): void {
        if (!this.popup) throw standardErrors.rpc.internal();
        this.popup.postMessage(message, this.url.origin);
    }

    private startOpenerPing(): void {
        this.stopOpenerPing();
        this.openerPing = setInterval(() => {
            if (!this.popup || this.popup.closed) {
                this.stopOpenerPing();
                return;
            }
            // Dropped by the browser while the popup is still on about:blank,
            // since the target origin does not match yet.
            const ping: ConfigMessage = { event: 'OpenerPing' };
            this.popup.postMessage(ping, this.url.origin);
        }, OPENER_PING_INTERVAL_MS);
    }

    private stopOpenerPing(): void {
        clearInterval(this.openerPing);
        this.openerPing = undefined;
    }

    private openPopup(): Window {
        const popupId = `jaw_${crypto.randomUUID()}`;

        // Carry the escape reason on the URL: a fresh window has no other way
        // to know why it was opened (keys reads it back at boot, e.g. to open
        // on its create view after a Safari webauthn-unsupported escape).
        const url = new URL(this.url.toString());
        const switchReason = this.options.consumeSwitchReason?.();
        if (switchReason) url.searchParams.set('switch-reason', switchReason);

        // On mobile, a sized popup window is hostile (tiny, often blocked or
        // backgrounded) — open as a full tab instead by omitting the window
        // features. Desktop keeps the centered popup.
        let popup: Window | null;
        if (isMobile()) {
            popup = window.open(url.toString(), popupId);
        } else {
            const left = Math.max(0, (window.screen.width - POPUP_WIDTH) / 2);
            const top = Math.max(0, (window.screen.height - POPUP_HEIGHT) / 2);
            popup = window.open(
                url.toString(),
                popupId,
                `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`
            );
        }

        if (!popup) {
            throw standardErrors.provider.userRejectedRequest(
                'Failed to open popup. Please allow popups for this site.'
            );
        }

        popup.focus();
        return popup;
    }
}
