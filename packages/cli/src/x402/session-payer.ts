import { privateKeyToAccount } from 'viem/accounts';
import { Eip3009EoaPayer } from '@jaw.id/agent';
import { keystoreExists, loadSessionKey } from '../lib/keystore.js';
import { cliChainClients } from './balance.js';

/** Load the session key from the keystore and build a pull-mode payer. */
export function sessionPayer(): Eip3009EoaPayer {
  if (!keystoreExists()) {
    throw new Error('No session key. Run `jaw session setup` to enable autonomous payments.');
  }
  return Eip3009EoaPayer.fromAccount(privateKeyToAccount(loadSessionKey() as `0x${string}`), cliChainClients);
}

/**
 * The address pull-mode payments are made from, which is the session key's own
 * EOA and also the session address: the EOA is the session account, upgraded in
 * place. This is the address that must hold USDC for `jaw_pay_and_fetch` to
 * pay; expose it so a user/agent knows where the funds end up. Derives the
 * public address only (no signing, no key exposure). Throws if no session key
 * exists.
 */
export function sessionPayerAddress(): `0x${string}` {
  if (!keystoreExists()) {
    throw new Error('No session key. Run `jaw session setup` first.');
  }
  return privateKeyToAccount(loadSessionKey() as `0x${string}`).address;
}
