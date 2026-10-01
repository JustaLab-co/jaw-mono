/**
 * Relay session persistence (~/.jaw/relay.json).
 * Shared by the bridge lifecycle (bridge-singleton) and status reporting (MCP jaw_status).
 */

import * as fs from 'node:fs';
import { PATHS } from './paths.js';
import { writeJsonAtomic } from './config.js';

export interface RelaySession {
  session: string;
  relayUrl: string;
  privateKey: string;
  publicKey: string;
  peerPublicKey: string | null;
  startedAt: string;
}

export function loadRelaySession(): RelaySession | null {
  try {
    if (!fs.existsSync(PATHS.relay)) return null;
    const raw = fs.readFileSync(PATHS.relay, 'utf-8');
    const parsed = JSON.parse(raw) as RelaySession;
    // Basic validation
    if (!parsed.session || !parsed.relayUrl || !parsed.privateKey || !parsed.publicKey) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveRelaySession(info: RelaySession): void {
  writeJsonAtomic(PATHS.relay, info);
}

export function deleteRelaySession(): void {
  try {
    if (fs.existsSync(PATHS.relay)) fs.unlinkSync(PATHS.relay);
  } catch {
    // ignore
  }
}
