import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import type { AppMetadata, JawProviderPreference } from '../provider/interface.js';
import { SDK_VERSION } from '../sdk-info.js';
import type { Message, MessageID } from '../messages/message.js';
import { PopupTransport } from './popup-transport.js';
import { JAW_KEYS_URL } from '../constants.js';

// Set up jsdom environment
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost:3000/',
});
global.window = dom.window as unknown as Window & typeof globalThis;
global.document = dom.window.document;
global.MessageEvent = dom.window.MessageEvent;

// Dispatches a message event to simulate postMessage calls from the popup
function dispatchMessageEvent({ data, origin }: { data: unknown; origin: string }) {
    const messageEvent = new MessageEvent('message', {
        data,
        origin,
    });
    window.dispatchEvent(messageEvent);
}

const popupLoadedMessage = {
    data: { event: 'PopupLoaded', id: 'popup-loaded-id' },
};

const popupReadyMessage = {
    // requestId echoes the PopupLoaded id — the SDK binds PopupReady to the handshake.
    data: { event: 'PopupReady', requestId: 'popup-loaded-id' },
};

/**
 * Queues a message event to be dispatched after a delay, simulating
 * messages sent by the popup (see communicator.test.ts).
 */
function queueMessageEvent({
    data,
    origin = new URL(JAW_KEYS_URL).origin,
}: {
    data: Record<string, unknown>;
    origin?: string;
}) {
    setTimeout(() => dispatchMessageEvent({ data, origin }), 200);
}

const appMetadata: AppMetadata = {
    appName: 'Test App',
    appLogoUrl: null,
    defaultChainId: 1,
};

const preference: JawProviderPreference = { keysUrl: JAW_KEYS_URL };

function createTransport(): PopupTransport {
    return new PopupTransport({
        url: new URL(JAW_KEYS_URL),
        metadata: appMetadata,
        preference,
    });
}

describe('PopupTransport', () => {
    let urlOrigin: string;
    let transport: PopupTransport;
    let mockPopup: Pick<Window, 'postMessage' | 'close' | 'closed' | 'focus'>;
    let originalWindowOpen: typeof window.open;
    let originalAddEventListener: typeof window.addEventListener;
    let originalRemoveEventListener: typeof window.removeEventListener;
    let addEventListenerCallCount: number;
    let removeEventListenerCallCount: number;

    beforeEach(() => {
        addEventListenerCallCount = 0;
        removeEventListenerCallCount = 0;

        originalWindowOpen = window.open;
        originalAddEventListener = window.addEventListener;
        originalRemoveEventListener = window.removeEventListener;

        window.addEventListener = ((event: string, listener: EventListener) => {
            addEventListenerCallCount++;
            return originalAddEventListener.call(window, event, listener);
        }) as typeof window.addEventListener;

        window.removeEventListener = ((event: string, listener: EventListener) => {
            removeEventListenerCallCount++;
            return originalRemoveEventListener.call(window, event, listener);
        }) as typeof window.removeEventListener;

        transport = createTransport();
        urlOrigin = new URL(JAW_KEYS_URL).origin;

        mockPopup = {
            postMessage: vi.fn(() => {
                // Mock implementation
            }),
            close: vi.fn(() => {
                // Mock implementation
            }),
            closed: false,
            focus: vi.fn(() => {
                // Mock implementation
            }),
        };

        window.open = vi.fn(() => mockPopup as Window);
    });

    afterEach(() => {
        window.open = originalWindowOpen;
        window.addEventListener = originalAddEventListener;
        window.removeEventListener = originalRemoveEventListener;
    });

    describe('kind', () => {
        it('is "popup"', () => {
            expect(transport.kind).toBe('popup');
        });
    });

    describe('onMessage', () => {
        it('should add and remove event listener', async () => {
            const mockRequest: Message = {
                requestId: 'mock-request-id-1-2',
                data: 'test',
            };

            queueMessageEvent({ data: mockRequest as unknown as Record<string, unknown> });

            const promise = transport.onMessage(() => true);

            expect(addEventListenerCallCount).toBe(1);
            expect(await promise).toEqual(mockRequest);
            expect(removeEventListenerCallCount).toBe(1);
        });

        it('should ignore messages from other origins', async () => {
            queueMessageEvent({
                data: { requestId: 'spoofed' },
                origin: 'https://evil.example.com',
            });
            queueMessageEvent({ data: { requestId: 'legit' } });

            const message = await transport.onMessage(() => true);

            expect(message).toEqual({ requestId: 'legit' });
        });

        it('should ignore messages whose source is not the popup window', async () => {
            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            await transport.ensureReady();

            const received = transport.onMessage(() => true);

            // Right origin, wrong source (a different window) -> ignored
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: { requestId: 'spoofed-source' },
                    origin: urlOrigin,
                    source: { other: true } as unknown as Window,
                })
            );
            // Right origin, source matching the popup -> accepted
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: { requestId: 'from-popup' },
                    origin: urlOrigin,
                    source: mockPopup as unknown as Window,
                })
            );

            expect(await received).toEqual({ requestId: 'from-popup' });
        });
    });

    describe('postRequestAndWaitForResponse', () => {
        it('should post a message to the popup window and wait for response', async () => {
            const mockRequest: Message & { id: MessageID } = { id: 'mock-request-id-1-2', data: {} };

            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            queueMessageEvent({
                data: {
                    requestId: mockRequest.id,
                },
            });

            const response = await transport.postRequestAndWaitForResponse(mockRequest);

            expect((mockPopup.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
                {
                    requestId: 'popup-loaded-id',
                    data: {
                        version: SDK_VERSION,
                        metadata: appMetadata,
                        preference,
                        location: 'http://localhost:3000/',
                    },
                },
                urlOrigin,
            ]);
            expect((mockPopup.postMessage as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([mockRequest, urlOrigin]);

            expect(response).toEqual({
                requestId: mockRequest.id,
            });
        });
    });

    describe('postMessage', () => {
        it('should post a response to the popup window', async () => {
            const mockResponse: Message = { requestId: 'mock-request-id-1-2', data: {} };

            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);

            await transport.postMessage(mockResponse);

            expect((mockPopup.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
                {
                    requestId: 'popup-loaded-id',
                    data: {
                        version: SDK_VERSION,
                        metadata: appMetadata,
                        preference,
                        location: 'http://localhost:3000/',
                    },
                },
                urlOrigin,
            ]);
            expect((mockPopup.postMessage as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([
                mockResponse,
                urlOrigin,
            ]);
        });
    });

    describe('setTheme', () => {
        it('posts a SetTheme message to a live popup', async () => {
            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            await transport.ensureReady();
            const before = (mockPopup.postMessage as ReturnType<typeof vi.fn>).mock.calls.length;

            transport.setTheme({ mode: 'dark' });

            expect((mockPopup.postMessage as ReturnType<typeof vi.fn>).mock.calls[before]).toEqual([
                { event: 'SetTheme', data: { theme: { mode: 'dark' } } },
                urlOrigin,
            ]);
        });

        it('does not throw when no popup is open', () => {
            expect(() => transport.setTheme({ mode: 'light' })).not.toThrow();
        });
    });

    describe('ensureReady', () => {
        it('should open a popup window and finish handshake', async () => {
            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);

            const popup = await transport.ensureReady();

            expect(window.open).toHaveBeenCalled();
            const openCall = (window.open as ReturnType<typeof vi.fn>).mock.calls[0];
            // URL might have a trailing slash when converted to string
            expect(openCall[0]).toMatch(/^https:\/\/keys\.jaw\.id\/?$/);

            expect((mockPopup.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
                {
                    requestId: 'popup-loaded-id',
                    data: {
                        version: SDK_VERSION,
                        metadata: appMetadata,
                        preference,
                        location: 'http://localhost:3000/',
                    },
                },
                urlOrigin,
            ]);
            expect(popup).toBeTruthy();
        });

        it('carries the lastAccount hint on the handshake config when provided', async () => {
            const lastAccount = { credentialId: 'A1b2-C3d4_E5f6' };
            transport = new PopupTransport({
                url: new URL(JAW_KEYS_URL),
                metadata: appMetadata,
                preference,
                // Read at handshake time (not construction) so a hint stored
                // during this session rides the next handshake.
                getLastAccount: () => lastAccount,
            });
            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            await transport.ensureReady();

            const posted = (mockPopup.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(posted.data.lastAccount).toEqual(lastAccount);
        });

        it('carries the dApp API key on the handshake config so keys can bootstrap the account screen', async () => {
            transport = new PopupTransport({
                url: new URL(JAW_KEYS_URL),
                metadata: appMetadata,
                preference,
                // Read at handshake time from the SDK store — always the dApp's
                // own key, never a keys-app fallback.
                getApiKey: () => 'dapp-api-key-123',
            });
            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            await transport.ensureReady();

            const posted = (mockPopup.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(posted.data.apiKey).toBe('dapp-api-key-123');
        });

        it('opens with centered window features on desktop', async () => {
            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            await transport.ensureReady();

            const openCall = (window.open as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(openCall[2]).toMatch(/width=\d+,height=\d+/);
        });

        it('opens as a full tab (no window features) on mobile', async () => {
            const originalUA = navigator.userAgent;
            Object.defineProperty(navigator, 'userAgent', {
                value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
                configurable: true,
            });
            try {
                transport = createTransport();
                queueMessageEvent(popupLoadedMessage);
                queueMessageEvent(popupReadyMessage);
                await transport.ensureReady();

                const openCall = (window.open as ReturnType<typeof vi.fn>).mock.calls[0];
                // URL + name only, no feature string → full tab
                expect(openCall.length).toBe(2);
                expect(openCall[2]).toBeUndefined();
            } finally {
                Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true });
            }
        });

        it('should re-focus and return the existing popup window if one is already open', async () => {
            let callCount = 0;
            window.open = vi.fn(() => {
                callCount++;
                return mockPopup as Window;
            });

            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            await transport.ensureReady();

            // Call again - should reuse existing popup
            await transport.ensureReady();

            expect((mockPopup.focus as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
            expect(callCount).toBe(1);
        });

        it('should open a popup window if an existing one is defined but closed', async () => {
            let callCount = 0;
            let currentPopup = mockPopup;

            window.open = vi.fn(() => {
                callCount++;
                const newPopup = {
                    postMessage: vi.fn(() => {
                        // Mock implementation
                    }),
                    close: vi.fn(() => {
                        // Mock implementation
                    }),
                    closed: false,
                    focus: vi.fn(() => {
                        // Mock implementation
                    }),
                };
                currentPopup = newPopup;
                return newPopup as unknown as Window;
            });

            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            await transport.ensureReady();

            (currentPopup as { closed: boolean }).closed = true;

            transport = createTransport();

            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            await transport.ensureReady();

            expect(callCount).toBe(2);
        });

        it('should reject when the popup is blocked (window.open returns null)', async () => {
            window.open = vi.fn(() => null);

            await expect(transport.ensureReady()).rejects.toThrow(/allow popups/i);
        });
    });

    describe('isAlive', () => {
        it('is false before opening, true after handshake, false after destroy', async () => {
            expect(transport.isAlive()).toBe(false);

            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            await transport.ensureReady();

            expect(transport.isAlive()).toBe(true);

            transport.destroy();

            expect(transport.isAlive()).toBe(false);
        });
    });

    describe('destroy', () => {
        it('should close the popup window and clear all listeners', async () => {
            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            await transport.ensureReady();

            const messagePromise = transport.onMessage(() => false);

            transport.destroy();

            expect((mockPopup.close as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

            try {
                await messagePromise;
                expect(true).toBe(false); // Should not reach here
            } catch (error) {
                expect((error as Error).message).toContain('Request rejected');
            }

            expect(removeEventListenerCallCount).toBeGreaterThan(0);
        });

        it('should handle destroy when no popup was opened', () => {
            expect(() => transport.destroy()).not.toThrow();
        });

        it('should reject all pending listeners on destroy', async () => {
            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            await transport.ensureReady();

            const messagePromise1 = transport.onMessage(() => false);
            const messagePromise2 = transport.onMessage(() => false);
            const messagePromise3 = transport.onMessage(() => false);

            transport.destroy();

            const results = await Promise.allSettled([messagePromise1, messagePromise2, messagePromise3]);

            results.forEach((result) => {
                expect(result.status).toBe('rejected');
                if (result.status === 'rejected') {
                    expect(result.reason.message).toContain('Request rejected');
                }
            });
        });
    });

    // A dApp page served with `Referrer-Policy: no-referrer` (or `same-origin`)
    // opens the popup with an empty document.referrer. The keys popup then has
    // no origin to answer to and holds PopupLoaded until the dApp's window
    // sends it something it can take the origin from.
    describe('popup that cannot see the dApp origin', () => {
        let posted: Message[];

        beforeEach(() => {
            vi.useFakeTimers();
            posted = [];
            let originKnown = false;
            // Replies land on a later task, as they do from a real window.
            const reply = (data: Record<string, unknown>) =>
                setTimeout(() => dispatchMessageEvent({ ...data, origin: urlOrigin } as never), 10);
            mockPopup.postMessage = vi.fn((message: Message) => {
                posted.push(message);
                if (!originKnown) {
                    originKnown = true;
                    reply(popupLoadedMessage);
                    return;
                }
                if ((message.data as { version?: string } | undefined)?.version) {
                    reply(popupReadyMessage);
                }
            }) as Window['postMessage'];
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('completes the handshake', async () => {
            let settled = false;
            const ready = transport.ensureReady().finally(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(5_000);

            expect(settled).toBe(true);
            await expect(ready).resolves.toBe(mockPopup);
        });

        it('sends nothing but the config after the popup loads, and no data before it', async () => {
            const ready = transport.ensureReady();
            await vi.advanceTimersByTimeAsync(5_000);
            await ready;

            const configIndex = posted.findIndex((m) => (m.data as { version?: string } | undefined)?.version);
            expect(configIndex).toBeGreaterThan(-1);
            expect(posted.slice(0, configIndex).every((m) => m.data === undefined)).toBe(true);

            const afterHandshake = posted.length;
            await vi.advanceTimersByTimeAsync(10_000);
            expect(posted.length).toBe(afterHandshake);
        });

        it('stops reaching out once the transport is destroyed', async () => {
            mockPopup.postMessage = vi.fn() as Window['postMessage'];
            transport.ensureReady().catch(() => undefined);
            await vi.advanceTimersByTimeAsync(2_000);

            transport.destroy();
            const afterDestroy = (mockPopup.postMessage as ReturnType<typeof vi.fn>).mock.calls.length;
            await vi.advanceTimersByTimeAsync(10_000);

            expect((mockPopup.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterDestroy);
        });
    });

    describe('PopupUnload event', () => {
        it('should destroy the transport when PopupUnload is received', async () => {
            queueMessageEvent(popupLoadedMessage);
            queueMessageEvent(popupReadyMessage);
            queueMessageEvent({
                data: { event: 'PopupUnload', id: 'unload-id' },
            });

            await transport.ensureReady();

            // Wait a bit for the PopupUnload event to be processed
            await new Promise((resolve) => setTimeout(resolve, 300));

            expect((mockPopup.close as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
            expect(transport.isAlive()).toBe(false);
        });
    });
});
