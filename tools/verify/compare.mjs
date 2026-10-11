// Diffs head against baseline evidence for one name, after blanking the values
// that differ on every run (nonces, deadlines, session expiry, timestamps, the payer address).
// Usage: node compare.mjs <run-dir> <name>   Exits 1 when they differ.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [run, name] = process.argv.slice(2);
const pick = (which) =>
  ['.out', '.code', '.mcp.json'].map((ext) => `${run}/evidence/${which}/${name}${ext}`).filter(existsSync);
const normalize = (text) =>
  text
    .replace(/(\\*"nonce\\*"\s*:\s*\\*")0x[0-9a-fA-F]{64}/g, '$1<nonce>')
    .replace(/(\\*"(deadline|validBefore)\\*"\s*:\s*\\*")\d+/g, '$1<deadline>')
    .replace(/("expiry"\s*:\s*)\d+/g, '$1<expiry>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<time>')
    .replace(/0x[0-9a-fA-F]{40}/g, (a) =>
      a.toLowerCase() === '0x2222222222222222222222222222222222222222' ? a : '<address>'
    );
const [head, base] = [pick('head'), pick('base')];
if (!head.length || head.length !== base.length) {
  console.log(`missing evidence for ${name}`);
  process.exit(1);
}
const report = [];
head.forEach((h, i) => {
  const [a, b] = [normalize(readFileSync(h, 'utf8')), normalize(readFileSync(base[i], 'utf8'))];
  report.push(a === b ? `same  ${h.split('/').pop()}` : `DIFF  ${h.split('/').pop()}\n--- base\n${b}\n+++ head\n${a}`);
});
writeFileSync(`${run}/evidence/compare-${name}.txt`, report.join('\n') + '\n');
console.log(report.map((r) => r.split('\n')[0]).join('\n'));
process.exit(report.some((r) => r.startsWith('DIFF')) ? 1 : 0);
