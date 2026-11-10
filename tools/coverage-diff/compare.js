#!/usr/bin/env node
'use strict';

// Compares the coverage-summary.json files of a PR against the main
// baseline and prints a markdown table. A drop is reported as dropped=true in
// $GITHUB_OUTPUT, so a non-zero exit always means the script itself broke.
// Usage: node compare.js <head-coverage-dir> <baseline-coverage-dir>

const fs = require('node:fs');
const path = require('node:path');

const METRICS = ['lines', 'branches', 'functions', 'statements'];
// Drops of this many points or fewer are treated as noise.
const TOLERANCE = 0.1;
// Lets the CI step find and edit its own comment instead of adding one per push.
const MARKER = '<!-- coverage-diff -->';

function readSummaries(dir) {
  const byProject = {};
  if (!fs.existsSync(dir)) return byProject;
  for (const file of fs.readdirSync(dir, { recursive: true })) {
    if (path.basename(file) !== 'coverage-summary.json') continue;
    const { total } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    byProject[path.dirname(file)] = total;
  }
  return byProject;
}

// Rounded to the two decimals istanbul reports, so a drop of exactly the
// tolerance is not flagged by floating-point error.
function diff(now, before) {
  return Math.round((now - before) * 100) / 100;
}

// Istanbul reports pct as the string "Unknown" for a metric with nothing to count.
function cell(now, before) {
  if (typeof now.pct !== 'number') return 'n/a';
  if (typeof before?.pct !== 'number') return `${now.pct}% (new)`;
  const delta = diff(now.pct, before.pct);
  return `${now.pct}% (${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`;
}

const [headDir, baseDir] = process.argv.slice(2);
const head = readSummaries(headDir);
const base = readSummaries(baseDir);
const dropped = [];
const rows = [];

for (const project of Object.keys(head).sort()) {
  const cells = METRICS.map((m) => {
    const now = head[project][m];
    const before = base[project]?.[m];
    const comparable = typeof now.pct === 'number' && typeof before?.pct === 'number';
    if (comparable && diff(now.pct, before.pct) < -TOLERANCE) dropped.push(`\`${project}\` ${m}`);
    return cell(now, before);
  });
  rows.push(`| ${project} | ${cells.join(' | ')} |`);
}

// No affected project means nothing to report, so the PR gets no comment.
if (rows.length === 0) process.exit(0);

const header = `| Project | ${METRICS.join(' | ')} |\n|---|${METRICS.map(() => '---').join('|')}|`;
const out = [MARKER, '### Coverage vs main', [header, ...rows].join('\n')];
if (dropped.length > 0) {
  out.push(
    `Coverage dropped more than ${TOLERANCE} points in: ${dropped.join(', ')}.`,
    'If the drop is intended, add the `coverage-drop-ok` label and re-run the job.'
  );
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'dropped=true\n');
}
console.log(out.join('\n\n'));
