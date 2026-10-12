/**
 * E2E encryption primitives for CLI ↔ browser communication.
 *
 * Uses ECDH P-256 for key exchange and AES-256-GCM for message encryption.
 * Mirrors the same crypto operations in @jaw.id/core but uses only
 * Node.js built-in crypto.subtle — no external dependencies.
 */

import type { webcrypto } from 'node:crypto';

type CKey = webcrypto.CryptoKey;
type CKeyPair = webcrypto.CryptoKeyPair;

const subtle = globalThis.crypto.subtle;

// ── Key generation ───────────────────────────────────────────────

export async function generateKeyPair(): Promise<CKeyPair> {
  return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']) as Promise<CKeyPair>;
}

export async function deriveSharedSecret(privateKey: CKey, peerPublicKey: CKey): Promise<CKey> {
  return subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ── Encrypt / Decrypt ────────────────────────────────────────────

export interface EncryptedEnvelope {
  iv: string; // base64
  ciphertext: string; // base64
}

export async function encryptMessage(sharedSecret: CKey, payload: Record<string, unknown>): Promise<EncryptedEnvelope> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, sharedSecret, plaintext);
  return {
    iv: bufferToBase64(iv),
    ciphertext: bufferToBase64(new Uint8Array(cipherBuf)),
  };
}

export async function decryptMessage(
  sharedSecret: CKey,
  envelope: EncryptedEnvelope
): Promise<Record<string, unknown>> {
  const iv = Buffer.from(envelope.iv, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, sharedSecret, ciphertext);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

// ── Key import / export (hex) ────────────────────────────────────

export async function exportKeyToHex(type: 'private' | 'public', key: CKey): Promise<string> {
  const format = type === 'private' ? 'pkcs8' : 'spki';
  const buf = await subtle.exportKey(format, key);
  return bytesToHex(new Uint8Array(buf));
}

export async function importKeyFromHex(type: 'private' | 'public', hex: string): Promise<CKey> {
  const format = type === 'private' ? 'pkcs8' : 'spki';
  return subtle.importKey(
    format,
    Buffer.from(hexToBytes(hex)),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    type === 'private' ? ['deriveKey'] : []
  );
}

// ── Encoding helpers ─────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex: odd length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bufferToBase64(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64');
}
