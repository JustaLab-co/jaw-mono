import { spawn, execFile } from 'node:child_process';
import { createHmac, randomBytes, randomUUID, timingSafeEqual, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { chromium } from 'playwright';

const { subtle } = webcrypto;
const exec = promisify(execFile);
const { values } = parseArgs({
  options: { keys: { type: 'string' }, relay: { type: 'string' }, clients: { type: 'string', default: '3' } },
});

const usage = (reason) => {
  console.error(
    `${reason}\nusage: node tools/bridge-probe/probe.mjs --keys <origin> --relay <ws url> [--clients 3|0.6,0.7]`
  );
  process.exit(2);
};
if (!values.keys || !values.relay) usage('--keys and --relay are required');
const clients = values.clients.trim();
const clientsIsCount = /^\d+$/.test(clients);
if (clientsIsCount ? Number(clients) < 1 : !clients.split(',').every((m) => /^\d+\.\d+$/.test(m))) {
  usage(`--clients takes a count of 1 or more or a list of minors such as 0.6,0.7, got "${clients}"`);
}

const keys = new URL(values.keys).origin;
const relay = values.relay;

const OVERALL_MS = 5 * 60_000;
const CLIENT_MS = 150_000;
const STEP_MS = 60_000;
const CHAIN_ID = 84532;
const CHAIN_HEX = '0x14a34';
const PRODUCTION_KEYS = 'https://keys.jaw.id';

// An outage of something the probe depends on, not a verdict on the bridge.
class InfraError extends Error {}

let failed = false;
let infraFailed = false;
const children = new Set();

const redact = (text) => text.replace(/([#&?])(pk|s)=[^\s&#"']*/g, '$1$2=<redacted>');
const log = (line) => console.log(redact(line));
const oneLine = (reason) => String(reason instanceof Error ? reason.message : reason).replace(/\s+/g, ' ');
const pass = (name) => log(`ok: ${name}`);
const report = (name, err) => {
  if (err instanceof InfraError) {
    infraFailed = true;
    log(`infra: ${name}: ${oneLine(err)}`);
  } else {
    failed = true;
    log(`fail: ${name}: ${oneLine(err)}`);
  }
};
const check = async (name, work) => {
  try {
    await work();
    pass(name);
  } catch (err) {
    report(name, err);
  }
};

const killChildren = () => children.forEach((c) => c.kill('SIGKILL'));
const overall = setTimeout(() => {
  report('probe', `did not finish within ${OVERALL_MS / 60_000} minutes`);
  killChildren();
  process.exit(1);
}, OVERALL_MS);

async function openSession(browser) {
  const session = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const clientPk = Buffer.from(await subtle.exportKey('spki', pair.publicKey)).toString('hex');

  const frames = [];
  let key;
  let wake;
  let broken;
  let page;
  const ws = new WebSocket(`${relay}?session=${session}&role=cli`);
  const close = async () => {
    ws.close();
    await page?.close().catch(() => {});
  };
  ws.addEventListener('message', async (e) => {
    try {
      const m = JSON.parse(String(e.data));
      if (m.type === 'encrypted' && key) {
        const plain = await subtle.decrypt(
          { name: 'AES-GCM', iv: Buffer.from(m.iv, 'base64') },
          key,
          Buffer.from(m.ciphertext, 'base64')
        );
        frames.push(JSON.parse(new TextDecoder().decode(plain)));
      } else frames.push(m);
    } catch (err) {
      broken = new Error(`could not read a relay frame: ${oneLine(err)}`);
    }
    wake?.();
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new InfraError(`relay ${relay} did not connect`)), 15_000);
      ws.addEventListener('open', () => (clearTimeout(timer), resolve()), { once: true });
      ws.addEventListener(
        'error',
        () => (clearTimeout(timer), reject(new InfraError(`relay ${relay} refused the connection`))),
        { once: true }
      );
    });

    const next = async (want, what, ms = STEP_MS) => {
      const end = Date.now() + ms;
      for (;;) {
        if (broken) throw broken;
        const at = frames.findIndex(want);
        if (at !== -1) return frames.splice(at, 1)[0];
        if (Date.now() > end) throw new Error(`no ${what} within ${ms / 1000}s`);
        await new Promise((r) => ((wake = r), setTimeout(r, 200)));
      }
    };
    const send = async (payload) => {
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const body = await subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(JSON.stringify(payload))
      );
      ws.send(
        JSON.stringify({
          type: 'encrypted',
          iv: Buffer.from(iv).toString('base64'),
          ciphertext: Buffer.from(body).toString('base64'),
        })
      );
    };

    page = await browser.newPage();
    const link = `${keys}/cli-bridge?session=${session}&relay=${encodeURIComponent(relay)}#pk=${clientPk}&s=${secret}`;
    const res = await page.goto(link, { waitUntil: 'commit' });
    if (!res.ok()) throw new Error(`${keys}/cli-bridge answered ${res.status()}`);

    const kx = await next((m) => m.type === 'key_exchange', 'key_exchange from the page');
    const expected = createHmac('sha256', Buffer.from(secret, 'base64url'))
      .update(`jaw-bridge-key/1\n${session}\n${clientPk}\n${kx.publicKey}`)
      .digest();
    const proven =
      typeof kx.proof === 'string' &&
      /^[0-9a-f]{64}$/.test(kx.proof) &&
      timingSafeEqual(Buffer.from(kx.proof, 'hex'), expected);

    const peer = await subtle.importKey(
      'spki',
      Buffer.from(kx.publicKey, 'hex'),
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
    key = await subtle.deriveKey(
      { name: 'ECDH', public: peer },
      pair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return { proven, send, next, close };
  } catch (err) {
    await close();
    throw err;
  }
}

const withSession = async (browser, work) => {
  const session = await openSession(browser);
  try {
    await work(session);
  } finally {
    await session.close();
  }
};

function checkPage(browser) {
  return Promise.all([
    check('page proves the link', () =>
      withSession(browser, (s) => {
        if (!s.proven) throw new Error('the key exchange carries no valid proof for the link secret');
      })
    ),
    check('page answers eth_chainId', () =>
      withSession(browser, async (s) => {
        await s.send({ type: 'init', chainId: CHAIN_ID, apiKey: 'probe', appName: 'JAW bridge probe' });
        await s.next((m) => m.type === 'ready', 'ready after init');
        await s.send({ type: 'rpc_request', id: 'probe-1', method: 'eth_chainId', params: [] });
        const reply = await s.next((m) => m.type === 'rpc_response' && m.id === 'probe-1', 'rpc_response');
        if (!reply.success || reply.data !== CHAIN_HEX) throw new Error(`got ${JSON.stringify(reply)}`);
      })
    ),
    check('page refuses an init without chainId', () =>
      withSession(browser, async (s) => {
        await s.send({ type: 'init', apiKey: 'probe', appName: 'JAW bridge probe' });
        const reply = await s.next((m) => m.type === 'error' || m.type === 'ready', 'error or ready');
        if (reply.type !== 'error' || !String(reply.reason).startsWith('Unsupported chainId')) {
          throw new Error(`got ${JSON.stringify(reply)}`);
        }
      })
    ),
  ]);
}

async function resolveVersions(spec) {
  let stdout;
  try {
    ({ stdout } = await exec('npm', ['view', '@jaw.id/cli', 'versions', '--json'], { timeout: 60_000 }));
  } catch (err) {
    throw new InfraError(`npm view @jaw.id/cli failed: ${oneLine(err)}`);
  }
  const stable = JSON.parse(stdout).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  const numeric = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const minors = [...new Set(stable.map((v) => v.split('.').slice(0, 2).join('.')))].sort(numeric);
  const wanted = /^\d+$/.test(spec) ? minors.slice(-Number(spec)) : spec.split(',');
  if (wanted.length === 0) throw new Error('no @jaw.id/cli minors to probe');
  return wanted.map((minor) => {
    const latest = stable
      .filter((v) => v.startsWith(`${minor}.`))
      .sort(numeric)
      .at(-1);
    if (!latest) throw new Error(`no published @jaw.id/cli ${minor}.x`);
    return latest;
  });
}

function run(cmd, args, env, ms, onStderr) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env });
    children.add(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(
      () => (child.kill('SIGKILL'), reject(new Error(`${cmd} still running after ${ms / 1000}s`))),
      ms
    );
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => ((stderr += d), onStderr?.(stderr)));
    child.on('error', (err) => (clearTimeout(timer), children.delete(child), reject(err)));
    child.on('close', (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

const answeredChainId = (stdout) => {
  const last = stdout.trim().split('\n').at(-1);
  try {
    const out = JSON.parse(last);
    const value = out && typeof out === 'object' ? out.result : out;
    return value === CHAIN_HEX || value === CHAIN_ID;
  } catch {
    return false;
  }
};

async function runClient(browser, version) {
  const name = `${version} answered eth_chainId`;
  const root = await mkdtemp(join(tmpdir(), 'bridge-probe-'));
  let page;
  try {
    const home = join(root, 'home');
    await mkdir(join(home, '.jaw'), { recursive: true });
    await writeFile(join(home, '.jaw', 'config.json'), JSON.stringify({ keysUrl: PRODUCTION_KEYS, relayUrl: relay }));
    try {
      await exec(
        'npm',
        [
          'install',
          '--prefix',
          root,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--silent',
          `@jaw.id/cli@${version}`,
        ],
        { timeout: 120_000 }
      );
    } catch (err) {
      throw new InfraError(`npm install @jaw.id/cli@${version} failed: ${oneLine(err)}`);
    }

    const env = { ...process.env, HOME: home, JAW_NO_BROWSER: '1' };
    let opened;
    const onStderr = (text) => {
      const link = text.match(/https?:\/\/\S+\/cli-bridge\?\S+/)?.[0];
      if (!link || opened) return;
      const url = new URL(link);
      opened = browser.newPage().then((p) => {
        page = p;
        return p.goto(`${keys}${url.pathname}${url.search}${url.hash}`, { waitUntil: 'commit' });
      });
      opened.catch(() => {});
    };
    const result = await run(
      join(root, 'node_modules', '.bin', 'jaw'),
      ['rpc', 'call', 'eth_chainId', '--chain', String(CHAIN_ID), '-o', 'json'],
      env,
      CLIENT_MS,
      onStderr
    );
    if (!opened)
      throw new InfraError(`the CLI printed no bridge link (exit ${result.code}): ${result.stderr.trim().slice(-300)}`);
    const res = await opened;
    if (!res.ok()) throw new Error(`${keys}/cli-bridge answered ${res.status()}`);
    if (result.code !== 0 || !answeredChainId(result.stdout)) {
      throw new Error(
        `exit ${result.code}, stdout ${result.stdout.trim().slice(-200)}, stderr ${result.stderr.trim().slice(-300)}`
      );
    }
    pass(name);
  } catch (err) {
    report(name, err);
  } finally {
    await page?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function checkClients(browser) {
  let versions;
  try {
    versions = await resolveVersions(clients);
  } catch (err) {
    report('resolve @jaw.id/cli versions', err);
    return;
  }
  log(`clients: ${versions.join(' ')}`);
  await Promise.all(versions.map((v) => runClient(browser, v)));
}

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  report('chromium launch', new InfraError(oneLine(err)));
}
if (browser) {
  await Promise.all([checkPage(browser), checkClients(browser)]);
  killChildren();
  await browser.close();
}
clearTimeout(overall);
process.exit(failed ? 1 : infraFailed ? 3 : 0);
