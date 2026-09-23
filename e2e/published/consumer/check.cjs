const assert = require('node:assert/strict');

async function main() {
  // core ships a CJS build next to the ESM one, and both have to export the same names.
  const cjs = require('@jaw.id/core');
  const esm = await import('@jaw.id/core');
  const esmNames = Object.keys(esm).filter((name) => name !== 'default');
  assert.deepEqual(Object.keys(cjs).sort(), esmNames.sort());

  // wagmi and ui are ESM-only and say so, instead of failing somewhere inside wagmi.
  for (const name of ['@jaw.id/wagmi', '@jaw.id/ui']) {
    assert.throws(() => require(name), /is ESM-only/);
  }

  console.log('cjs ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
