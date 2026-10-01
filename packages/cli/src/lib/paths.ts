import * as path from 'node:path';
import * as os from 'node:os';

const JAW_DIR = path.join(os.homedir(), '.jaw');

export const PATHS = {
  root: JAW_DIR,
  config: path.join(JAW_DIR, 'config.json'),
  session: path.join(JAW_DIR, 'session.json'),
  relay: path.join(JAW_DIR, 'relay.json'),
  keystore: path.join(JAW_DIR, 'keystore.json'),
  sessionConfig: path.join(JAW_DIR, 'session-config.json'),
  x402Log: path.join(JAW_DIR, 'x402-log.jsonl'),
  /** Where compaction moves the rows it folds away. Never read while paying. */
  x402LogArchive: path.join(JAW_DIR, 'x402-log.archive.jsonl'),
  paymentLock: path.join(JAW_DIR, 'x402-payment.lock'),
} as const;
