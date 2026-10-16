import type { Logger } from '@jaw.id/agent';

/** stderr, never stdout: `jaw mcp` speaks its protocol on stdout. */
export const stderrLogger: Logger = {
  warn(message) {
    process.stderr.write(`${message}\n`);
  },
};
