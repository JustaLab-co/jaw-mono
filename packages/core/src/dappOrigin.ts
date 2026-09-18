import { store } from './store/index.js';

/**
 * Tells this core instance which dApp it is acting for.
 *
 * Calls made from the keys origin all carry the same `Origin`, so the caller
 * they act on behalf of is not visible to the backend. Only keys sets this, and
 * only from the origin the browser handed it.
 *
 * A dApp's own page must never call it: the browser already puts the right
 * `Origin` on its requests, and a value set here would be a claim the browser
 * did not make.
 */
export function setDappOrigin(origin: string | undefined): void {
    store.config.set({ dappOrigin: origin });
}
