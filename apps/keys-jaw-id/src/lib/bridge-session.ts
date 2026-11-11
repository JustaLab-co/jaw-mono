// Names @jaw.id/core uses for the SDK session it restores without a dialog.
const STORE_KEY = 'jawsdk.store';
const SIGNER_KEY = 'JAWSDK:SignerConfig:SignerType';

export const sameAccount = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function heldAccount(): string | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    const account = saved?.state?.account?.accounts?.[0];
    return typeof account === 'string' ? account : undefined;
  } catch {
    return undefined;
  }
}

export function releaseHeldSession(): void {
  try {
    localStorage.removeItem(SIGNER_KEY);
  } catch {
    return;
  }
}
