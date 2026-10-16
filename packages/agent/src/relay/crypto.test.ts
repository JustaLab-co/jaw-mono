import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  deriveSharedSecret,
  encryptMessage,
  decryptMessage,
  exportKeyToHex,
  importKeyFromHex,
} from './crypto.js';

describe('crypto', () => {
  it('generates an ECDH P-256 key pair', async () => {
    const kp = await generateKeyPair();
    expect(kp.publicKey).toBeDefined();
    expect(kp.privateKey).toBeDefined();
  });

  it('exports and imports public key as hex round-trip', async () => {
    const kp = await generateKeyPair();
    const hex = await exportKeyToHex('public', kp.publicKey);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    const imported = await importKeyFromHex('public', hex);
    expect(imported).toBeDefined();
  });

  it('exports and imports private key as hex round-trip', async () => {
    const kp = await generateKeyPair();
    const hex = await exportKeyToHex('private', kp.privateKey);
    const imported = await importKeyFromHex('private', hex);
    expect(imported).toBeDefined();
  });

  it('derives the same shared secret from both sides', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();

    const secretA = await deriveSharedSecret(alice.privateKey, bob.publicKey);
    const secretB = await deriveSharedSecret(bob.privateKey, alice.publicKey);

    // Encrypt with one, decrypt with the other
    const encrypted = await encryptMessage(secretA, { type: 'test', data: 'hello' });
    const decrypted = await decryptMessage(secretB, encrypted);
    expect(decrypted).toEqual({ type: 'test', data: 'hello' });
  });

  it('encrypt then decrypt round-trips a message', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const secret = await deriveSharedSecret(alice.privateKey, bob.publicKey);

    const original = {
      type: 'rpc_request',
      id: 'abc-123',
      method: 'personal_sign',
      params: ['0xdeadbeef', '0x1234'],
    };

    const encrypted = await encryptMessage(secret, original);
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.ciphertext).toBeDefined();
    expect(typeof encrypted.iv).toBe('string');
    expect(typeof encrypted.ciphertext).toBe('string');

    const decrypted = await decryptMessage(secret, encrypted);
    expect(decrypted).toEqual(original);
  });

  it('fails to decrypt with wrong key', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const eve = await generateKeyPair();

    const secret = await deriveSharedSecret(alice.privateKey, bob.publicKey);
    const wrongSecret = await deriveSharedSecret(eve.privateKey, bob.publicKey);

    const encrypted = await encryptMessage(secret, { type: 'test' });
    await expect(decryptMessage(wrongSecret, encrypted)).rejects.toThrow();
  });

  it('fails to decrypt tampered ciphertext', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const secret = await deriveSharedSecret(alice.privateKey, bob.publicKey);

    const encrypted = await encryptMessage(secret, { type: 'test' });
    // Flip bits in the middle of the ciphertext to corrupt the GCM auth tag
    const raw = Buffer.from(encrypted.ciphertext, 'base64');
    raw[Math.floor(raw.length / 2)] ^= 0xff;
    const tampered = { ...encrypted, ciphertext: raw.toString('base64') };
    await expect(decryptMessage(secret, tampered)).rejects.toThrow();
  });
});
