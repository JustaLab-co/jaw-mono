'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'compare.js');

function writeSummary(root, project, pct) {
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const total = Object.fromEntries(Object.entries(pct).map(([m, v]) => [m, { pct: v }]));
  fs.writeFileSync(path.join(dir, 'coverage-summary.json'), JSON.stringify({ total }));
}

function full(pct) {
  return { lines: pct, branches: pct, functions: pct, statements: pct };
}

function run(setup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-diff-'));
  const head = path.join(root, 'head');
  const base = path.join(root, 'base');
  const output = path.join(root, 'output');
  fs.writeFileSync(output, '');
  setup(head, base);
  const result = spawnSync('node', [SCRIPT, head, base], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  return { ...result, output: fs.readFileSync(output, 'utf8') };
}

test('flags a drop beyond the tolerance', () => {
  const r = run((head, base) => {
    writeSummary(base, 'apps/proxy', full(92));
    writeSummary(head, 'apps/proxy', { ...full(92), statements: 91.5 });
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.output, 'dropped=true\n');
  assert.match(r.stdout, /91\.5% \(-0\.50\)/);
  assert.match(r.stdout, /`apps\/proxy` statements/);
});

test('ignores a drop within the tolerance', () => {
  const r = run((head, base) => {
    writeSummary(base, 'apps/proxy', full(92));
    writeSummary(head, 'apps/proxy', { ...full(92), branches: 91.95 });
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.output, '');
});

test('ignores a drop of exactly the tolerance', () => {
  const r = run((head, base) => {
    writeSummary(base, 'apps/proxy', full(80.01));
    writeSummary(head, 'apps/proxy', full(79.91));
  });
  assert.strictEqual(r.output, '');
  assert.match(r.stdout, /79\.91% \(-0\.10\)/);
});

test('marks projects missing from the baseline as new', () => {
  const r = run((head) => writeSummary(head, 'libs/cls', full(100)));
  assert.strictEqual(r.output, '');
  assert.match(r.stdout, /100% \(new\)/);
});

test('prints nothing when no project has a report', () => {
  const r = run((head, base) => writeSummary(base, 'apps/proxy', full(92)));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.output, '');
});

test('shows n/a for a metric with nothing to measure', () => {
  const r = run((head, base) => {
    writeSummary(base, 'libs/cls', full(100));
    writeSummary(head, 'libs/cls', { ...full(100), functions: 'Unknown' });
  });
  assert.strictEqual(r.output, '');
  assert.match(r.stdout, /\| n\/a \|/);
});

test('exits non-zero on a corrupt summary instead of reporting a drop', () => {
  const r = run((head) => {
    fs.mkdirSync(path.join(head, 'apps/proxy'), { recursive: true });
    fs.writeFileSync(path.join(head, 'apps/proxy/coverage-summary.json'), '{');
  });
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(r.output, '');
});
