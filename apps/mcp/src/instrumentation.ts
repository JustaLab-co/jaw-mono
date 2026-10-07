export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runMigrations } = await import('./db/migrate');
  const { log } = await import('./lib/edge');
  const url = process.env.DATABASE_URL;
  try {
    if (!url) throw new Error('DATABASE_URL is not set');
    await runMigrations(url);
    log('info', { msg: 'migrations applied' });
  } catch (err) {
    // A server on an unmigrated schema would fail every request; stop instead.
    log('error', { msg: 'migrations failed', error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}
