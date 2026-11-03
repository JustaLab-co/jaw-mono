#!/usr/bin/env node
'use strict';

// Prints an SVG badge with the line coverage of every project together, each
// weighed by its number of lines, from the coverage-summary.json files in a
// directory. The Coverage workflow publishes it on the badges branch.
// Usage: node badge.js <coverage-dir> > coverage.svg

const fs = require('node:fs');
const path = require('node:path');

// shields.io's colors and steps, so it sits well beside the other badges.
const COLORS = [
  [90, '#4c1'],
  [80, '#97ca00'],
  [70, '#a4a61d'],
  [60, '#dfb317'],
  [50, '#fe7d37'],
  [0, '#e05d44'],
];

const dir = process.argv[2];
let covered = 0;
let total = 0;
for (const file of fs.readdirSync(dir, { recursive: true })) {
  if (path.basename(file) !== 'coverage-summary.json') continue;
  const { lines } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).total;
  covered += lines.covered;
  total += lines.total;
}
if (total === 0) {
  console.error(`No lines in any coverage-summary.json under ${dir}`);
  process.exit(1);
}

const pct = Math.floor((covered / total) * 1000) / 10;
const color = COLORS.find(([min]) => pct >= min)[1];
const value = `${pct}%`;
// Verdana 11px averages about 7px a character; 10px of padding each side.
const left = 61;
const right = value.length * 7 + 10;
const width = left + right;

console.log(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="coverage: ${value}">` +
    `<title>coverage: ${value}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${left}" height="20" fill="#555"/><rect x="${left}" width="${right}" height="20" fill="${color}"/><rect width="${width}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${left / 2}" y="14">coverage</text><text x="${left + right / 2}" y="14">${value}</text></g></svg>`
);
