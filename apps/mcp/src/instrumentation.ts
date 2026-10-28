export async function register() {
  // The condition is replaced at build time, so the edge bundle never sees the import.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { prepare } = await import('./instrumentation-node');
    await prepare();
  }
}
