'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'badge.js');

function writeLines(root, project, covered, total) {
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const lines = { covered, total, pct: total === 0 ? 'Unknown' : (covered / total) * 100 };
  fs.writeFileSync(path.join(dir, 'coverage-summary.json'), JSON.stringify({ total: { lines } }));
}

function run(setup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-badge-'));
  setup(root);
  return spawnSync('node', [SCRIPT, root], { encoding: 'utf8' });
}

test('weighs every project by its lines', () => {
  const r = run((root) => {
    writeLines(root, 'packages/a', 90, 100);
    writeLines(root, 'packages/b', 10, 100);
  });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^<svg /);
  assert.match(r.stdout, />50%</);
  assert.match(r.stdout, /#fe7d37/);
});

test('rounds down, so the badge never shows more than was measured', () => {
  const r = run((root) => writeLines(root, 'apps/mcp', 2999, 3000));
  assert.match(r.stdout, />99\.9%</);
  assert.match(r.stdout, /#4c1/);
});

test('skips a project with no lines', () => {
  const r = run((root) => {
    writeLines(root, 'packages/a', 80, 100);
    writeLines(root, 'packages/empty', 0, 0);
  });
  assert.match(r.stdout, />80%</);
});

test('exits non-zero when there is no summary', () => {
  const r = run(() => {});
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});
