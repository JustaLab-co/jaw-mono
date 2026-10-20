// Drives the hosted server's rejoin against the real relay and the real cli-bridge page. No passkey is needed:
// eth_chainId is answered by the page without a dialog.
//
//   JAW_LIVE_RELAY_URL=wss://relay.jaw.id JAW_LIVE_KEYS_URL=https://keys.jaw.id \
//     bunx tsx --tsconfig apps/mcp/tsconfig.json tools/verify/rejoin-drive/drive.mts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decryptMessage, deriveSharedSecret, importKeyFromHex, type EncryptedEnvelope } from '@jaw.id/agent';
import { chromium } from 'playwright';

const relayUrl = process.env.JAW_LIVE_RELAY_URL;
const keysUrl = process.env.JAW_LIVE_KEYS_URL;
if (!relayUrl || !keysUrl) {
  console.error('set JAW_LIVE_RELAY_URL and JAW_LIVE_KEYS_URL');
  process.exit(2);
}
process.env.JAW_RELAY_URL = relayUrl;
process.env.JAW_KEYS_URL = keysUrl;
process.env.JAW_MCP_PUBLIC_URL = 'http://mcp.test';
process.env.JAW_MCP_SEALING_KEYS = Buffer.alloc(32, 7).toString('base64url');

const { ownerRelay, resumeWallet } = await import('../../../apps/mcp/src/connections/relay');
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sent: string[] = [];
let dropAfterNextSend = false;
const wsSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (data: Parameters<typeof wsSend>[0]) {
  sent.push(String(data));
  wsSend.call(this, data);
  // The server goes away right after its request leaves, with no shutdown, as a restart does.
  if (dropAfterNextSend) {
    dropAfterNextSend = false;
    this.close();
  }
};

const browser = await chromium.launch();
try {
  const until = new Date(Date.now() + 5 * 60_000);
  const wallet = await ownerRelay(84532, until);
  say('link', wallet.url.replace(/#.*/, '#pk=...'));
  await (await browser.newPage()).goto(wallet.url);

  type Resume = Parameters<NonNullable<Parameters<typeof wallet.run>[1]>>[0];
  const joined = new Promise<Resume>((resolve) => {
    wallet
      .run(
        (ask) => ask('eth_chainId', []),
        (resume) => {
          dropAfterNextSend = true;
          resolve(resume);
        }
      )
      .then(
        (v) => say('first run answered before the drop, rerun the drive:', v),
        (e: Error) => say('first run ended without an answer:', e.message)
      );
  });
  const resume = await joined;
  say('joined, session', resume.session);
  await sleep(3000);

  const resumed = await resumeWallet(resume, until);
  assert(resumed, 'the page is still open, so the server can resume');
  const answer = await resumed.run((ask) => ask('eth_chainId', []));
  say('answer after the restart', answer);
  assert.equal(answer, '0x14a34', 'the page answered eth_chainId for Base Sepolia');

  const secret = await deriveSharedSecret(
    await importKeyFromHex('private', resume.key),
    await importKeyFromHex('public', resume.peer)
  );
  const ids: string[] = [];
  for (const raw of sent) {
    const m = JSON.parse(raw) as { type: string };
    if (m.type !== 'encrypted') continue;
    const inner = await decryptMessage(secret, m as unknown as EncryptedEnvelope).catch(() => undefined);
    if (inner?.type === 'rpc_request') ids.push(String(inner.id));
  }
  say('rpc_request ids sent', ids);
  assert.deepEqual(ids, [`${resume.session}:0`, `${resume.session}:0`], 'the repeated ask used the same id');

  const replaced = new Promise<number>((resolve) => {
    const url = `${relayUrl}?session=${randomUUID()}&role=cli`;
    const first = new WebSocket(url);
    first.addEventListener('close', (e) => resolve(e.code), { once: true });
    first.addEventListener('open', () => new WebSocket(url), { once: true });
  });
  const code = await Promise.race([replaced, sleep(15_000).then(() => undefined)]);
  say('first role=cli closed with', code);
  assert.equal(code, 4003, 'a second role=cli replaces the first');
  say('ok');
} finally {
  await browser.close();
}
process.exit(0);
