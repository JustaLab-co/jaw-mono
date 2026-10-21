// Usage: node tools/verify/bridge-replay.mjs <relay ws url> <keys origin>
// Plays the server side of a relay session against the real cli-bridge page:
// asks, leaves before the answer, rejoins, and asks again under the same id.
import { randomUUID, webcrypto } from 'node:crypto';
import { chromium } from 'playwright';

const [relay, keys] = process.argv.slice(2);
if (!relay || !keys) {
  console.error('usage: node tools/verify/bridge-replay.mjs <relay ws url> <keys origin>');
  process.exit(2);
}
const { subtle } = webcrypto;
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
const session = randomUUID();
let secret;

function join() {
  const ws = new WebSocket(`${relay}?session=${session}&role=cli`);
  const frames = [];
  let wake;
  ws.addEventListener('message', async (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'encrypted' && secret) {
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: Buffer.from(m.iv, 'base64') },
        secret,
        Buffer.from(m.ciphertext, 'base64')
      );
      frames.push({ encrypted: true, ...JSON.parse(new TextDecoder().decode(plain)) });
    } else frames.push(m);
    wake?.();
  });
  const opened = new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const next = async (want, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const at = frames.findIndex(want);
      if (at !== -1) return frames.splice(at, 1)[0];
      if (Date.now() > end) return undefined;
      await new Promise((r) => ((wake = r), setTimeout(r, 200)));
    }
  };
  const send = async (payload) => {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const c = await subtle.encrypt({ name: 'AES-GCM', iv }, secret, body);
    ws.send(
      JSON.stringify({
        type: 'encrypted',
        iv: Buffer.from(iv).toString('base64'),
        ciphertext: Buffer.from(c).toString('base64'),
      })
    );
  };
  return { ws, opened, next, send };
}

const first = join();
await first.opened;
log('server joined session', session);

const browser = await chromium.launch();
const page = await browser.newPage();
const pk = Buffer.from(await subtle.exportKey('spki', pair.publicKey)).toString('hex');
await page.goto(`${keys}/cli-bridge?session=${session}&relay=${encodeURIComponent(relay)}#pk=${pk}`);
log('page opened');

const kx = await first.next((m) => m.type === 'key_exchange', 90000);
if (!kx) throw new Error('the page never sent key_exchange; is the relay origin allowed by its connect-src?');
const peer = await subtle.importKey(
  'spki',
  Buffer.from(kx.publicKey, 'hex'),
  { name: 'ECDH', namedCurve: 'P-256' },
  true,
  []
);
secret = await subtle.deriveKey(
  { name: 'ECDH', public: peer },
  pair.privateKey,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt']
);
log('key exchange done');

await first.send({ type: 'init', chainId: 84532, apiKey: 'drive-key', appName: 'Replay drive' });
log('ready:', JSON.stringify(await first.next((m) => m.type === 'ready')));

const request = { type: 'rpc_request', id: 'req-1', method: 'eth_chainId', params: [] };
await first.send(request);
first.ws.close();
log('sent', request.id, 'and closed the server socket at once');
await sleep(3000);

const second = join();
await second.opened;
log('server rejoined the same session');
log('relay status on rejoin:', JSON.stringify(await second.next((m) => m.type === 'status')));
const early = await second.next((m) => m.type === 'encrypted', 3000);
log('answer delivered on rejoin without asking again:', early ? JSON.stringify(early) : 'none (the relay dropped it)');

const reply = () => second.next((m) => m.type === 'rpc_response' && m.id === request.id);
await second.send(request);
log('re-sent', request.id, 'with the same method and params');
log('answer:', JSON.stringify((await reply()) ?? 'none'));

await second.send({ ...request, params: ['tampered'] });
log('re-sent', request.id, 'with other params');
log('answer:', JSON.stringify((await reply()) ?? 'none'));

await browser.close();
second.ws.close();
