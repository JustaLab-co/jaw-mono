/**
 * Bound a promise, whatever it is waiting on.
 *
 * A transport timeout caps one attempt; this caps the whole read, retries
 * included. The number stays with the caller, which is the part that has a
 * reason for it; only the mechanism lives here.
 *
 * `permission-onchain.ts` keeps its own copy. It reads with a default bound
 * rather than a per-call one, and pulling it in here would churn a file this
 * change has no other business in.
 */
export function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
