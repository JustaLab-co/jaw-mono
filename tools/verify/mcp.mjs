// Drives `jaw mcp` over stdio: initialize, then each tool call in order, waiting
// for every response by id. Saves the transcript as evidence.
// Usage: node mcp.mjs <run-dir> <head|base> <name> '<[{"name":"jaw_x402_log","arguments":{}}]>'
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const [run, which, name, callsJson] = process.argv.slice(2);
const env = Object.fromEntries(
  readFileSync(`${run}/run.env`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split(/=(.*)/s).slice(0, 2))
);
const calls = JSON.parse(callsJson.replaceAll('{SELLER}', env.SELLER));
const child = spawn(env[`BIN_${which}`], ['mcp'], { env: { ...process.env, HOME: `${run}/work/home-${which}` } });
const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
let id = 0;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
    pending.set(n, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
const transcript = [];
await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'verify', version: '0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
for (const call of calls) transcript.push({ call, response: (await rpc('tools/call', call)).result });
child.kill();
writeFileSync(`${run}/evidence/${which}/${name}.mcp.json`, JSON.stringify(transcript, null, 2));
console.log(`${which}/${name}: ${transcript.length} calls`);
