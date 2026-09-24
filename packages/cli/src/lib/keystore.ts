import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { PATHS } from './paths.js';
import { writeJsonAtomic } from './config.js';

interface KeystoreFile {
  version: 2;
  privateKey: string;
  address: string;
  createdAt: string;
}

/**
 * Generate a random secp256k1 private key as 0x-prefixed hex.
 */
export function generateSessionKey(): `0x${string}` {
  const bytes = crypto.randomBytes(32);
  return `0x${bytes.toString('hex')}` as `0x${string}`;
}

/**
 * Save private key to keystore.json.
 * On-chain PermissionManager is the real security boundary — the session key
 * can only act within its granted permission scope regardless of local access.
 * Written atomically: a torn keystore strands the session until the next
 * `jaw session setup`.
 */
export function saveKeystore(privateKeyHex: string, address: string): void {
  const keystore: KeystoreFile = {
    version: 2,
    privateKey: privateKeyHex,
    address,
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(PATHS.keystore, keystore);
}

/**
 * Load private key hex from keystore.json.
 */
export function loadSessionKey(): string {
  if (!fs.existsSync(PATHS.keystore)) {
    throw new Error('No session configured. Run `jaw session setup` first.');
  }

  const contents = fs.readFileSync(PATHS.keystore, 'utf-8');
  let parsed: KeystoreFile;
  try {
    parsed = JSON.parse(contents) as KeystoreFile;
  } catch {
    throw new Error(`Keystore at ${PATHS.keystore} is corrupted. Run \`jaw session setup\` to recreate it.`);
  }
  return parsed.privateKey;
}

/**
 * Load the session address from keystore.json, or null if it cannot be read.
 * Used to name the key in messages, so a corrupt keystore degrades the message
 * rather than the command.
 */
export function tryLoadKeystoreAddress(): string | null {
  try {
    if (!fs.existsSync(PATHS.keystore)) return null;
    const parsed = JSON.parse(fs.readFileSync(PATHS.keystore, 'utf-8')) as KeystoreFile;
    return parsed.address ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete keystore.json.
 */
export function deleteKeystore(): void {
  if (fs.existsSync(PATHS.keystore)) {
    fs.unlinkSync(PATHS.keystore);
  }
}

/**
 * Check if keystore.json exists.
 */
export function keystoreExists(): boolean {
  return fs.existsSync(PATHS.keystore);
}
