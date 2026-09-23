/**
 * Generated tool calls through a real MCP client, sent the way a careless or
 * hostile client would: any tool, any arguments, including ones the schema
 * never mentions.
 *
 * Every effect the server can have is a trap here: the browser bridge, the
 * session-key bridge, `fetch`, and the config file on disk. The properties are
 * about those effects, not about the replies: whatever arrives, the server
 * answers and stays up, the session key is reached only for the four methods
 * it may run, nothing is fetched outside http(s), the spending caps and the
 * paymaster in the config never move, and no reply carries a terminal escape
 * or a bidi control back to whoever renders it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fc from 'fast-check';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

fc.configureGlobal({ seed: 0xf022, numRuns: 1000 });

const ROOT = path.join(os.tmpdir(), 'jaw-mcp-fuzz');

vi.mock('../lib/paths.js', () => {
  const p = require('node:path');
  const o = require('node:os');
  const root = p.join(o.tmpdir(), 'jaw-mcp-fuzz');
  return {
    PATHS: {
      root,
      config: p.join(root, 'config.json'),
      session: p.join(root, 'session.json'),
      relay: p.join(root, 'relay.json'),
      keystore: p.join(root, 'keystore.json'),
      sessionConfig: p.join(root, 'session-config.json'),
      x402Log: p.join(root, 'x402-log.jsonl'),
      paymentLock: p.join(root, 'x402-payment.lock'),
    },
  };
});

const browserRequests: string[] = [];
vi.mock('../lib/bridge-singleton.js', () => ({
  getBridge: async () => ({
    request: async (method: string) => {
      browserRequests.push(method);
      return '0xbrowser';
    },
    close: () => undefined,
  }),
  shutdownDaemon: async () => undefined,
}));

const sessionRequests: string[] = [];
vi.mock('../lib/session-bridge.js', () => ({
  SessionBridge: class {
    request(method: string) {
      sessionRequests.push(method);
      return Promise.resolve('0xsession');
    }
    close() {
      return undefined;
    }
  },
}));

vi.mock('../x402/balance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../x402/balance.js')>()),
  usdcBalance: async () => ({ raw: '0', formatted: '0' }),
  publicClientFor: () => ({ getCode: async () => undefined }),
}));

const { createMcpServer } = await import('./server.js');
const { saveConfig, loadConfig } = await import('../lib/config.js');
const { saveKeystore } = await import('../lib/keystore.js');
const { supportsSessionMode } = await import('../lib/rpc-classifier.js');
const { isValidKeysUrl, isValidRelayUrl } = await import('../lib/validation.js');

const X402 = { maxAmountPerPayment: '1000', maxTotalPerSession: '5000', allowedPayTo: ['0x' + '11'.repeat(20)] };
const PAYMASTERS = { 84532: { url: 'https://pm.example/rpc', context: { policy: 'p' } } };

const fetched: string[] = [];
let client: Client;

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.env['JAW_API_KEY'] = 'fuzz-key';
  saveConfig({ x402: X402, paymasters: PAYMASTERS } as Parameters<typeof saveConfig>[0]);
  // A session key, so the payment path gets as far as fetching.
  saveKeystore('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', '0xSessionAddr');
  vi.stubGlobal('fetch', async (url: unknown) => {
    fetched.push(String(url));
    return { status: 200, url: String(url), headers: { get: () => null }, text: async () => '{}' };
  });

  const server = createMcpServer('fuzz');
  client = new Client({ name: 'fuzz', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env['JAW_API_KEY'];
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const TOOLS = [
  'jaw_rpc',
  'jaw_config_show',
  'jaw_config_set',
  'jaw_status',
  'jaw_disconnect',
  'jaw_session_status',
  'jaw_pay_and_fetch',
  'jaw_x402_log',
  'jaw_x402_balance',
  'jaw_discover',
];

const hostileText = fc.constantFrom(
  '\u001b[2J\u001b[31mapproved',
  'pay\u202eevil',
  'zero\u200bwidth',
  'x402.maxTotalPerSession',
  'paymasters',
  '__proto__',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'data:text/plain,hi',
  'https://evil.example/pay',
  'http://127.0.0.1:1/x',
  'wss://evil.example',
  'https://keys.evil.example',
  'personal_sign',
  'eth_signTypedData_v4',
  'wallet_sendCalls',
  'wallet_grantPermissions'
);
const value = fc.oneof(
  { weight: 3, arbitrary: hostileText },
  { weight: 2, arbitrary: fc.anything() },
  { weight: 1, arbitrary: fc.string() },
  { weight: 1, arbitrary: fc.constantFrom(true, false, 0, -1, 84532, 1e308, Number.NaN) }
);
const KEYS = [
  'method',
  'params',
  'chainId',
  'session',
  'key',
  'value',
  'url',
  'headers',
  'body',
  'maxAmount',
  'asset',
  'network',
  'query',
  'limit',
  'payTo',
  'curatedOnly',
  'maxUsdPrice',
  'x402',
  'constructor',
];
const args = fc.oneof(
  { weight: 4, arbitrary: fc.dictionary(fc.constantFrom(...KEYS), value, { maxKeys: 5 }) },
  { weight: 1, arbitrary: fc.anything() }
);
const anyCall = fc.record({
  name: fc.oneof({ weight: 9, arbitrary: fc.constantFrom(...TOOLS) }, { weight: 1, arbitrary: fc.string() }),
  arguments: args,
});

// Shaped close enough to the schema to get past it, so the handlers see them.
const shapedCall = fc.oneof(
  fc.record({
    name: fc.constant('jaw_rpc'),
    arguments: fc.record(
      {
        method: fc.oneof(hostileText, fc.constantFrom('eth_accounts', 'wallet_getCallsStatus'), fc.string()),
        session: fc.boolean(),
        params: fc.anything(),
      },
      { requiredKeys: ['method', 'session'] }
    ),
  }),
  fc.record({
    name: fc.constant('jaw_config_set'),
    arguments: fc.record({
      key: fc.constantFrom('apiKey', 'defaultChain', 'keysUrl', 'ens', 'relayUrl', 'sessionExpiry'),
      value: fc.oneof(hostileText, fc.string()),
    }),
  }),
  fc.record({
    name: fc.constant('jaw_pay_and_fetch'),
    arguments: fc.record(
      { url: fc.oneof(hostileText, fc.webUrl(), fc.string()), maxAmount: fc.oneof(hostileText, fc.string()) },
      { requiredKeys: ['url'] }
    ),
  })
);
const call = fc.oneof(anyCall, shapedCall);

// Matching control characters is the point of this pattern.
// eslint-disable-next-line no-control-regex
const DISARMED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

function textsOf(result: unknown): string[] {
  const content = (result as { content?: Array<{ text?: unknown }> }).content ?? [];
  return content.map((block) => String(block.text ?? ''));
}

describe('generated MCP tool calls', () => {
  it('fail closed: no effect outside what each tool is allowed, and the server keeps answering', async () => {
    await fc.assert(
      fc.asyncProperty(call, async (c) => {
        sessionRequests.length = 0;
        fetched.length = 0;

        let reply: unknown;
        try {
          reply = await client.callTool(c as Parameters<Client['callTool']>[0]);
        } catch (err) {
          reply = { content: [{ text: err instanceof Error ? err.message : String(err) }] };
        }

        // The SDK's own schema refusals are the known gap pinned below.
        for (const text of textsOf(reply)) {
          if (!text.startsWith('MCP error -32602: Input validation error')) expect(text).not.toMatch(DISARMED);
        }
        for (const method of sessionRequests) expect(supportsSessionMode(method), method).toBe(true);
        for (const url of fetched) expect(url, url).toMatch(/^https?:\/\//);

        const config = loadConfig();
        expect(config.x402).toEqual(X402);
        expect(config.paymasters).toEqual(PAYMASTERS);
        if (config.keysUrl !== undefined) expect(isValidKeysUrl(config.keysUrl)).toBe(true);
        if (config.relayUrl !== undefined) expect(isValidRelayUrl(config.relayUrl)).toBe(true);
      })
    );

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
  });

  // Known gap, pinned so it flips when fixed. Arguments that fail the schema
  // never reach a handler: the SDK answers itself, and its message dumps the
  // zod issues, `received` value included, without passing through `mcpError`.
  // An enum is the one issue that echoes the input, so `jaw_config_set.key`
  // carries a bidi override straight back.
  it.fails('disarms what the SDK echoes when arguments fail the schema', async () => {
    const reply = await client.callTool({ name: 'jaw_config_set', arguments: { key: 'pay‮evil', value: 'x' } });
    for (const text of textsOf(reply)) expect(text).not.toMatch(DISARMED);
  });

  it('reaches the effects it guards, so the property above is not vacuous', async () => {
    browserRequests.length = 0;
    sessionRequests.length = 0;
    fetched.length = 0;
    await client.callTool({ name: 'jaw_rpc', arguments: { method: 'eth_accounts', session: true } });
    await client.callTool({ name: 'jaw_rpc', arguments: { method: 'personal_sign', params: ['0x1'] } });
    await client.callTool({ name: 'jaw_pay_and_fetch', arguments: { url: 'https://api.example.com/x' } });

    expect(sessionRequests).toEqual(['eth_accounts']);
    expect(browserRequests).toEqual(['personal_sign']);
    expect(fetched).toEqual(['https://api.example.com/x']);
  });
});
