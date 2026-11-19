/**
 * Shared by every project whose tests touch `localStorage`: apps/keys-jaw-id
 * and @jaw.id/ui today.
 *
 * Node 25 exposes a `localStorage` global whose methods are absent unless the
 * process was started with `--localstorage-file`. The stub takes the global
 * slot before the jsdom environment installs its own, so `localStorage.clear()`
 * throws `is not a function` even in a `@vitest-environment jsdom` file. CI runs
 * Node 22, where the global does not exist and jsdom's Storage is used, so this
 * only ever fails on a developer machine and only on Node 25+.
 *
 * Probe the global the same way `packages/core/src/store/store.ts` does, and
 * install a working in-memory Storage when it turns out to be unusable.
 */
function isUsable(storage: unknown): boolean {
  try {
    const s = storage as Storage | undefined;
    if (!s || typeof s.setItem !== 'function' || typeof s.clear !== 'function') return false;
    const probeKey = '__keys_storage_probe__';
    s.setItem(probeKey, '1');
    s.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  } as Storage;
}

// Only in a jsdom file. A `environment: 'node'` test has no `window` and no
// working `localStorage` on purpose, and code under test branches on that
// (packages/core/src/store/store.ts falls back to a no-op storage). Installing
// the stub there would hand those tests a browser-like global that exists in no
// real environment, and would leak writes between `it` blocks.
if (typeof window !== 'undefined' && !isUsable(globalThis.localStorage)) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}

// jsdom ships its own AbortSignal, and Node 24+ refuses it as the `signal` of a Request.
// viem builds a Request around one on every RPC call, so in a jsdom file each call fails
// before it reaches `fetch`. Drop the signal there; the timeout it carried is not under test.
if (typeof window !== 'undefined') {
  const NodeRequest = globalThis.Request;
  globalThis.Request = class extends NodeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init && { ...init, signal: null });
    }
  };
}
