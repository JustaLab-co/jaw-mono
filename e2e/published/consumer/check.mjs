import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { registerHooks, createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// @jaw.id/ui imports its stylesheet, which a bundler handles and Node cannot.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context),
});

const core = await import('@jaw.id/core');
assert.equal(typeof core.create, 'function');
assert.equal(core.SDK_VERSION, require('@jaw.id/core/package.json').version);

const wagmi = await import('@jaw.id/wagmi');
assert.equal(typeof wagmi.jaw, 'function');

const ui = await import('@jaw.id/ui');
assert.equal(typeof ui.ReactUIHandler, 'function');

const cliVersion = require('@jaw.id/cli/package.json').version;
// Through the link the package manager made, so a bin entry lost at publish fails here.
const jaw = (args) => execFileSync('node_modules/.bin/jaw', args, { encoding: 'utf8' });
assert.match(jaw(['--version']), new RegExp(`@jaw.id/cli/${cliVersion} `));
const help = jaw(['--help']);
for (const topic of ['session', 'mcp', 'rpc']) assert.match(help, new RegExp(`\\b${topic}\\b`));

console.log('esm ok');
