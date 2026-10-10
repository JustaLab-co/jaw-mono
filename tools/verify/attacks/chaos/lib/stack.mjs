// Two apps/mcp replicas behind one round-robin proxy, one Postgres, one anvil
// fork of Base Sepolia. Every name carries the lane, so nothing else is touched.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';

const run = promisify(execFile);
export const IMAGE = process.env.CHAOS_IMAGE ?? 'jaw-mcp:integration-cfebc45f';
export const FAKETIME_IMAGE = process.env.CHAOS_FAKETIME_IMAGE ?? 'jaw-mcp:chaos-faketime';
const LANE = process.env.CHAOS_LANE ?? 'lane-chaos';
const BASE = Number(process.env.CHAOS_PORT ?? 13900);
const NET = `${LANE}-net`;
const PG = `${LANE}-pg`;
const PORTS = { proxy: BASE, mcp1: BASE + 1, mcp2: BASE + 2, pg: BASE + 32, anvil: BASE + 45 };
export const PUBLIC_URL = `http://localhost:${PORTS.proxy}`;
export const PG_URL = `postgres://postgres:pg@127.0.0.1:${PORTS.pg}/mcp`;
const FORK_URL = process.env.CHAOS_FORK_URL ?? 'https://sepolia.base.org';
export const EVIDENCE =
  process.env.CHAOS_EVIDENCE ?? join(fileURLToPath(new URL('../../../../..', import.meta.url)), '.verify-cache/chaos');

const docker = async (...args) => (await run('docker', args, { maxBuffer: 64 << 20 })).stdout.trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(what, check, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** Postgres alone, for the tests that run the app in process. Returns its admin URL. */
export async function postgresOnly() {
  const name = `${LANE}-pg-doubles`;
  await docker('rm', '-f', '-v', name).catch(() => {});
  await docker('run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=pg', '-p', `127.0.0.1:${BASE + 34}:5432`, 'postgres:17');
  const url = `postgres://postgres:pg@127.0.0.1:${BASE + 34}/postgres`;
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 2 });
  await waitFor('postgres', async () => (await sql`select 1 as ok`)[0].ok === 1, 180_000);
  await sql.end();
  return { url, stop: () => docker('rm', '-f', '-v', name) };
}

/** Replica container names, by replica id. */
export const container = (id) => `${LANE}-${id}`;

/**
 * `replicas` maps a replica id (mcp1, mcp2) to { skew: '+90' | '-30' | undefined, env }.
 * A skewed replica runs the faketime image with LD_PRELOAD; the others run IMAGE.
 */
export async function up({ replicas = { mcp1: {}, mcp2: {} }, label = 'stack' } = {}) {
  await down();
  const secret = randomBytes(24).toString('base64url');
  const sealing = randomBytes(32).toString('base64url');
  await docker('network', 'create', NET);
  await docker(
    'run',
    '-d',
    '--name',
    PG,
    '--network',
    NET,
    '--network-alias',
    'pg',
    '-e',
    'POSTGRES_PASSWORD=pg',
    '-e',
    'POSTGRES_DB=mcp',
    '-p',
    `127.0.0.1:${PORTS.pg}:5432`,
    'postgres:17',
    '-c',
    'max_connections=200'
  );
  const anvil = spawn(
    'anvil',
    ['--fork-url', FORK_URL, '--chain-id', '84532', '--port', String(PORTS.anvil), '--host', '0.0.0.0', '--silent'],
    { stdio: 'ignore' }
  );
  writePid('anvil', anvil.pid);
  const sql = postgres(PG_URL.replace('/mcp', '/postgres'), { max: 1, onnotice: () => {}, connect_timeout: 2 });
  await waitFor('postgres', async () => (await sql`select 1 as ok`)[0].ok === 1, 180_000);
  await sql.end();
  await waitFor('anvil', async () => (await rpc('eth_chainId')) === '0x14a34');

  const env = (id, extra = {}) => ({
    DATABASE_URL: 'postgres://postgres:pg@pg:5432/mcp',
    JAW_MCP_PUBLIC_URL: PUBLIC_URL,
    JAW_KEYS_URL: 'http://keys.chaos.test',
    JAW_MCP_SEALING_KEYS: sealing,
    JAW_MCP_RPC_URL: `http://host.docker.internal:${PORTS.anvil}`,
    JAW_MCP_CRON_SECRET: secret,
    JAW_MCP_TRUSTED_PROXY_HOPS: '1',
    ...extra,
  });
  const specs = Object.entries(replicas).map(([id, r]) => ({ id, ...r, env: env(id, r.env) }));
  if (specs.some((s) => s.skew) && !(await docker('images', '-q', FAKETIME_IMAGE))) {
    const dockerfile = fileURLToPath(new URL('../faketime.Dockerfile', import.meta.url));
    await docker(
      'build',
      '-q',
      '--build-arg',
      `BASE=${IMAGE}`,
      '-f',
      dockerfile,
      '-t',
      FAKETIME_IMAGE,
      dirname(dockerfile)
    );
  }
  await Promise.all(specs.map(startReplica));
  const proxy = await startProxy(specs.map((s) => s.id));
  const db = postgres(PG_URL, { max: 5, onnotice: () => {} });
  const stack = { label, secret, db, proxy, specs, anvil };
  current = stack;
  return stack;
}

let current;

async function startReplica(spec) {
  const args = ['run', '-d', '--name', container(spec.id), '--network', NET, '-p', `127.0.0.1:${PORTS[spec.id]}:3000`];
  args.push('--add-host', 'host.docker.internal:host-gateway');
  const env = { ...spec.env };
  if (spec.skew) {
    Object.assign(env, {
      LD_PRELOAD: '/usr/lib/faketime/libfaketime.so.1',
      FAKETIME: spec.skew,
      FAKETIME_DONT_FAKE_MONOTONIC: '1',
    });
  }
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(spec.skew ? FAKETIME_IMAGE : IMAGE);
  await docker(...args);
  await waitHealthy(spec.id);
}

export async function waitHealthy(id, ms = 180_000) {
  await waitFor(`${id} healthy`, async () => (await fetch(`${replicaUrl(id)}/api/health`)).status === 200, ms);
}

export const replicaUrl = (id) => `http://127.0.0.1:${PORTS[id]}`;

/** kill -9 of the replica's node process: the container's pid 1. */
export async function killReplica(id) {
  await docker('kill', '--signal', 'KILL', container(id));
}

export async function restartReplica(id) {
  await docker('start', container(id));
  await waitHealthy(id);
}

export async function restartPostgres() {
  await docker('restart', '--time', '0', PG);
}

export async function replicaState(id) {
  const [running, restarts, pid] = (
    await docker('inspect', '-f', '{{.State.Running}} {{.RestartCount}} {{.State.Pid}}', container(id))
  ).split(' ');
  return { running: running === 'true', restarts: Number(restarts), pid: Number(pid) };
}

export const logs = async (id) => {
  const { stdout, stderr } = await run('docker', ['logs', container(id)], { maxBuffer: 64 << 20 });
  return stdout + stderr;
};

export async function rpc(method, params = []) {
  const res = await fetch(`http://127.0.0.1:${PORTS.anvil}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/**
 * Round robin over the replicas. `x-chaos-replica: mcp2` pins one request.
 * Each response says which replica served it in `x-chaos-upstream`.
 */
async function startProxy(ids) {
  let next = 0;
  const served = Object.fromEntries(ids.map((id) => [id, 0]));
  const server = createServer((req, res) => {
    const pinned = req.headers['x-chaos-replica'];
    const id = ids.includes(pinned) ? pinned : ids[next++ % ids.length];
    served[id]++;
    const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress };
    delete headers['x-chaos-replica'];
    const upstream = request(
      { host: '127.0.0.1', port: PORTS[id], method: req.method, path: req.url, headers },
      (up) => {
        res.writeHead(up.statusCode, { ...up.headers, 'x-chaos-upstream': id });
        up.pipe(res);
      }
    );
    upstream.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'application/json', 'x-chaos-upstream': id });
      res.end(JSON.stringify({ error: 'proxy_upstream', detail: err.code }));
    });
    req.pipe(upstream);
  });
  server.keepAliveTimeout = 1_000;
  await new Promise((r) => server.listen(PORTS.proxy, '127.0.0.1', r));
  return { server, served };
}

function writePid(name, pid) {
  const dir = join(EVIDENCE, 'pids');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), String(pid));
}

/** Saves each replica's log to evidence, then removes everything this lane started. */
export async function down() {
  const stack = current;
  current = undefined;
  if (stack) {
    const dir = join(EVIDENCE, 'logs');
    mkdirSync(dir, { recursive: true });
    for (const s of stack.specs) {
      const text = await logs(s.id).catch(() => '');
      writeFileSync(join(dir, `${stack.label}-${s.id}.log`), text);
    }
    await stack.db.end({ timeout: 1 }).catch(() => {});
    stack.proxy.server.closeAllConnections();
    await new Promise((r) => stack.proxy.server.close(r));
  }
  // An anvil left by a run that died before its own down.
  const pidFile = join(EVIDENCE, 'pids', 'anvil');
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {}
    rmSync(pidFile);
  }
  for (const name of [container('mcp1'), container('mcp2'), container('mcp3'), PG]) {
    await docker('rm', '-f', '-v', name).catch(() => {});
  }
  await docker('network', 'rm', NET).catch(() => {});
}
