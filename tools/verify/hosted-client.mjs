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
const SCOPE = process.argv[3] ?? 'wallet:read x402:pay wallet:send';
const RESOURCE = `${BASE}/mcp`;

async function authorize() {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(8).toString('hex');
  let redirect;
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, redirect);
      if (url.pathname !== '/callback') return void res.writeHead(404).end();
      const error = url.searchParams.get('error');
      res.end(error ? `Not connected: ${error}. You can close this tab.` : 'Connected. You can close this tab.');
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
  status                         jaw_status
  connections                    jaw_connections
  history                        jaw_history
  funds                          jaw_add_funds
  quote <url>                    jaw_quote
  pay <url> [maxAmount]          jaw_pay_and_fetch (maxAmount in base units)
  budget <perDay> [<0xcontract>:<signature> ...]
                                 jaw_request_budget, e.g. budget 2 0x036C...:approve(address,uint256)
  transfer <to> <amount>         jaw_transfer, amount in USDC
  calls '<json array>'           jaw_send_calls, e.g. calls '[{"to":"0x...","data":"0x..."}]'
  revoke <connection id>         jaw_revoke_connection
  disconnect                     jaw_disconnect
  call <tool> '<json>'           any tool with raw arguments
  quit`;

const commands = {
  tools: async () => console.log((await rpc('tools/list', {})).tools.map((t) => t.name).join('\n')),
  status: () => call('jaw_status', {}),
  connections: () => call('jaw_connections', {}),
  history: () => call('jaw_history', {}),
  funds: () => call('jaw_add_funds', {}),
  quote: (url) => call('jaw_quote', { url }),
  pay: (url, maxAmount) => call('jaw_pay_and_fetch', { url, ...(maxAmount && { maxAmount }) }),
  budget: (perDay, ...calls) =>
    call('jaw_request_budget', {
      perDay,
      ...(calls.length && {
        calls: calls.map((c) => {
          const at = c.indexOf(':');
          return { to: c.slice(0, at), functionSignature: c.slice(at + 1) };
        }),
      }),
    }),
  transfer: (to, amount) => call('jaw_transfer', { to, amount }),
  calls: (...json) => call('jaw_send_calls', { calls: JSON.parse(json.join(' ')) }),
  revoke: (connection) => call('jaw_revoke_connection', { id: connection }),
  disconnect: () => call('jaw_disconnect', {}),
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
