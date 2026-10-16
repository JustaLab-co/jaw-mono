import { sweepWraps } from './connections/adapter';
import { config } from './connections/config';
import { runMigrations } from './db/migrate';
import { log } from './lib/edge';
import { purge, reconcile } from './reconciler/run';

/** Every minute unless set, 0 turns it off. A value that is not seconds keeps the default. */
export function reconcileSeconds(value: string | undefined): number {
  if (!value) return 60;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  log('warn', { msg: `JAW_MCP_RECONCILE_EVERY=${value} is not a number of seconds, reconciling every 60` });
  return 60;
}

function reconcileEvery(seconds: number) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepWraps();
      await reconcile();
      await purge();
    } catch (err) {
      log('error', { msg: 'reconcile run failed', error: err instanceof Error ? err.name : 'unknown' });
    } finally {
      running = false;
    }
  }, seconds * 1000).unref();
}

export async function prepare() {
  try {
    config();
  } catch (err) {
    // Read once at boot so a missing or invalid variable stops the server, not every request.
    log('error', { msg: 'invalid config', error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  try {
    if (!url) throw new Error('DATABASE_URL is not set');
    await runMigrations(url);
    log('info', { msg: 'migrations applied' });
    const every = reconcileSeconds(process.env.JAW_MCP_RECONCILE_EVERY);
    if (every > 0) reconcileEvery(every);
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
