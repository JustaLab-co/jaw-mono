// tsc runs with skipLibCheck, which also skips our own declarations, and
// turning it off overflows tsc's stack on the dependencies' types. So check
// directly that every relative path our .d.ts files point at was published.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SPECIFIER = /(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g;

function declarations(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return declarations(path);
    return entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

function resolves(from, specifier) {
  const base = join(dirname(from), specifier);
  const stem = base.replace(/\.js$/, '');
  return [base, `${stem}.d.ts`, join(base, 'index.d.ts')].some(existsSync);
}

// Known and not yet fixed: ui's declarations import its source stylesheet,
// which the build ships as dist/index.css. Remove the entry with the fix; the
// assertion below fails if the list and reality drift in either direction.
const KNOWN = ['node_modules/@jaw.id/ui/dist/index.d.ts: ./styles.css'];

const missing = [];
for (const name of ['core', 'wagmi', 'ui']) {
  for (const file of declarations(`node_modules/@jaw.id/${name}/dist`)) {
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      if (!resolves(file, specifier)) missing.push(`${file}: ${specifier}`);
    }
  }
}
assert.deepEqual(missing, KNOWN, 'declarations point at files that were not published');
console.log('dts ok');
