// Preloaded into the mcp container by compose.lose-send.yaml. While /tmp/lose-send
// exists there, the next eth_sendUserOperation reaches the bundler and its answer
// is then dropped, the way a lost connection drops it.
import { existsSync, rmSync } from 'node:fs';

const FLAG = '/tmp/lose-send';
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const body = typeof init?.body === 'string' ? init.body : '';
  if (!body.includes('"eth_sendUserOperation"') || !existsSync(FLAG)) return realFetch(input, init);
  rmSync(FLAG);
  const res = await realFetch(input, init);
  console.error(`lose-send: bundler answered ${res.status} ${await res.text()}, answer dropped`);
  throw new TypeError('fetch failed: answer dropped by lose-send');
};
