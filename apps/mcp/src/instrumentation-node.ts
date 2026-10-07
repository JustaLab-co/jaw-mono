import { runMigrations } from './db/migrate';
import { log } from './lib/edge';

export async function prepare() {
  const url = process.env.DATABASE_URL;
  try {
    if (!url) throw new Error('DATABASE_URL is not set');
    await runMigrations(url);
    log('info', { msg: 'migrations applied' });
    if (!process.env.JAW_MCP_TRUSTED_PROXY_HOPS) {
      log('warn', {
        msg: 'JAW_MCP_TRUSTED_PROXY_HOPS is not set: unauthenticated routes are limited per IP only where the platform sets x-real-ip',
      });
    }
  } catch (err) {
    // A server on an unmigrated schema would fail every request; stop instead.
    log('error', { msg: 'migrations failed', error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}
