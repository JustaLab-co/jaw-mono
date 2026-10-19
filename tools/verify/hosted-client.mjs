// An interactive MCP client of the hosted server, for trying it by hand. It runs
// the OAuth flow as the first-party jaw-cli client, opening the browser on the
// server's connect page, then reads commands until `quit`. Tokens refresh on
// their own; nothing is written to disk.
// Usage: node hosted-client.mjs <public url> [scope]
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';

const BASE = new URL(process.argv[2] ?? '').origin;
const SCOPE = process.argv[3] ?? 'wallet:read x402:pay';
const RESOURCE = `${BASE}/mcp`;

// The page the browser lands on after the wallet, in the look of the connect page.
const STYLE = `
:root{--bg:#f8fafc;--card:#fff;--fg:#020817;--muted:#64748b;--border:#e2e8f0;--ok:#16a34a;--bad:#dc2626;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#020817;--card:#0b1222;--fg:#f8fafc;--muted:#94a3b8;--border:#1e293b;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:100%;max-width:26rem;background:var(--card);border:1px solid var(--border);border-radius:.75rem;padding:2rem;box-shadow:0 1px 3px rgb(0 0 0/.06),0 8px 24px rgb(0 0 0/.04)}
.brand{display:flex;align-items:center;gap:.5rem;margin-bottom:1.5rem;color:var(--muted);font-size:.8rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.brand img{width:28px;height:28px}
@media (prefers-color-scheme:dark){.brand img{filter:invert(1)}}
h1{margin:0 0 .35rem;font-size:1.35rem;line-height:1.3;font-weight:650}
h1.ok{color:var(--ok)}h1.bad{color:var(--bad)}
p{margin:0;color:var(--muted);font-size:.9rem}
`;
const escape = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const done = (error) => {
  const body = error
    ? `<h1 class="bad">Not connected</h1><p>${escape(error)}. You can close this tab.</p>`
    : '<h1 class="ok">Connected</h1><p>You can close this tab and go back to the terminal.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JAW</title><style>${STYLE}</style></head><body><main class="card"><div class="brand"><img src="https://keys.jaw.id/jaw-logo.png" alt="">JAW</div>${body}</main></body></html>`;
};

async function authorize() {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(8).toString('hex');
  let redirect;
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, redirect);
      if (url.pathname !== '/callback') return void res.writeHead(404).end();
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(done(error));
      server.close();
      if (error) reject(new Error(`${error}: ${url.searchParams.get('error_description') ?? ''}`));
      else if (url.searchParams.get('state') !== state) reject(new Error('state mismatch'));
      else resolve(url.searchParams.get('code'));
    });
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}/callback`;
      const params = new URLSearchParams({
        client_id: 'jaw-cli',
        redirect_uri: redirect,
        response_type: 'code',
        scope: SCOPE,
        state,
        resource: RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
      const url = `${BASE}/oauth/authorize?${params}`;
      console.log(`Opening the connect page. If no browser opens, visit:\n${url}\n`);
      execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
    });
  });
  return token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
    client_id: 'jaw-cli',
    code_verifier: verifier,
    resource: RESOURCE,
  });
}

async function token(body) {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${json.error} ${json.error_description ?? ''}`);
  return json;
}

let tokens;
let id = 0;
async function rpc(method, params, retried = false) {
  const res = await fetch(RESOURCE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  if (res.status === 401 && !retried) {
    tokens = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: 'jaw-cli',
      resource: RESOURCE,
    });
    return rpc(method, params, true);
  }
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (!line) throw new Error(`/mcp ${res.status}: ${text.slice(0, 300)}`);
  const msg = JSON.parse(line.slice(6));
  if (msg.error) throw new Error(msg.error.message);
  return msg.result;
}

async function call(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  console.log(result.isError ? `\x1b[31m${result.content[0].text}\x1b[0m` : result.content[0].text);
  if (result.structuredContent) console.log(JSON.stringify(result.structuredContent, null, 2));
}

const HELP = `Commands:
  tools                          list the server's tools
  status                         jaw_session_status
  connections                    jaw_connections
  history                        jaw_session_history
  funds                          jaw_add_funds
  assets [chainIds,comma]        jaw_get_assets, every mainnet when left out
  account-history                jaw_get_calls_history
  permissions                    jaw_get_permissions
  capabilities                   jaw_get_capabilities
  quote <url>                    jaw_session_x402_quote
  pay <url> [maxAmount]          jaw_session_x402_pay (maxAmount in base units)
  budget <perDay>                jaw_grant_permissions with the x402 budget preset, USDC per day
  grant '<json>'                 jaw_grant_permissions with calls, spends and expiresAt, e.g.
                                 grant '{"calls":[{"target":"0x...","functionSignature":"transfer(address,uint256)"}],"spends":[{"token":"0x...","allowance":"1000","unit":"week"}]}'
  swap <originChain> <originToken> <destChain> <destToken> <amount> [recipient|-] [key]
                                 jaw_swap, amount in base units of originToken, 0x000...0 for the native coin,
                                 e.g. swap 8453 0x8335...2913 42161 0xaf88...5831 1000000
  swap-status <quoteId>          jaw_swap_status, quoteId is aurora:<deposit address>
  calls '<json array>' [chainId] [key]
                                 jaw_send_calls, the owner approves in the wallet, e.g.
                                 calls '[{"to":"0x...","data":"0x..."}]' 8453 my-key
  calls-status <id>              jaw_get_calls_status, id is the oc_ id jaw_send_calls returned
  revoke <permission id> [chain] jaw_revoke_permission
  execute <permission id> '<json array>' [chainId] [key]
                                 jaw_session_execute, the session key sends within a custom grant, e.g.
                                 execute 0x... '[{"to":"0x...","data":"0x..."}]' '' my-key
  disconnect                     jaw_session_disconnect
  call <tool> '<json>'           any tool with raw arguments
  quit`;

const commands = {
  tools: async () => console.log((await rpc('tools/list', {})).tools.map((t) => t.name).join('\n')),
  status: () => call('jaw_session_status', {}),
  connections: () => call('jaw_connections', {}),
  history: () => call('jaw_session_history', {}),
  funds: () => call('jaw_add_funds', {}),
  assets: (chainIds) => call('jaw_get_assets', chainIds ? { chainIds: chainIds.split(',').map(Number) } : {}),
  'account-history': () => call('jaw_get_calls_history', {}),
  permissions: () => call('jaw_get_permissions', {}),
  capabilities: () => call('jaw_get_capabilities', {}),
  quote: (url) => call('jaw_session_x402_quote', { url }),
  pay: (url, maxAmount) => call('jaw_session_x402_pay', { url, ...(maxAmount && { maxAmount }) }),
  budget: (perDay) => call('jaw_grant_permissions', { x402Budget: { perDay } }),
  grant: (json) => call('jaw_grant_permissions', JSON.parse(json)),
  swap: (originChainId, originToken, destinationChainId, destinationToken, amount, recipient, idempotencyKey) =>
    call('jaw_swap', {
      originChainId: Number(originChainId),
      originToken,
      destinationChainId: Number(destinationChainId),
      destinationToken,
      amount,
      ...(recipient && recipient !== '-' && { recipient }),
      ...(idempotencyKey && { idempotencyKey }),
    }),
  'swap-status': (quoteId) => call('jaw_swap_status', { quoteId }),
  calls: (json, chainId, idempotencyKey) =>
    call('jaw_send_calls', {
      calls: JSON.parse(json),
      ...(chainId && { chainId: Number(chainId) }),
      ...(idempotencyKey && { idempotencyKey }),
    }),
  'calls-status': (id) => call('jaw_get_calls_status', { id }),
  revoke: (permissionId, chainId) =>
    call('jaw_revoke_permission', { permissionId, ...(chainId && { chainId: Number(chainId) }) }),
  execute: (permissionId, json, chainId, idempotencyKey) =>
    call('jaw_session_execute', {
      permissionId,
      calls: JSON.parse(json),
      ...(chainId && { chainId: Number(chainId) }),
      ...(idempotencyKey && { idempotencyKey }),
    }),
  disconnect: () => call('jaw_session_disconnect', {}),
  call: (name, ...json) => call(name, json.length ? JSON.parse(json.join(' ')) : {}),
};

tokens = await authorize();
console.log(`Connected with scope: ${tokens.scope}\n\n${HELP}\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const line = (await rl.question('jaw> ')).trim();
  if (!line) continue;
  if (line === 'quit' || line === 'exit') break;
  // Single quotes keep a JSON argument in one piece.
  const [command, ...args] = line.match(/'[^']*'|\S+/g).map((a) => a.replace(/^'|'$/g, ''));
  const run = commands[command];
  if (!run) {
    console.log(HELP);
    continue;
  }
  try {
    await run(...args);
  } catch (err) {
    console.log(`\x1b[31m${err.message}\x1b[0m`);
  }
}
rl.close();
