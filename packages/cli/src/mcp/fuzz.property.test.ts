/**
 * Generated tool calls through a real MCP client, sent the way a careless or
 * hostile client would: any tool, any arguments, including ones the schema
 * never mentions.
 *
 * Every effect the server can have is a trap here: the browser bridge, the
 * session-key bridge, `fetch` (which answers some runs with a generated 402
 * challenge, so the policy, the top-up and the signer run too), and the config
 * file on disk. The properties are about those effects, not about the replies:
 * whatever arrives, the server answers and stays up, the session key is reached
 * only for the four methods it may run, nothing is fetched outside http(s), the
 * caps and the paymaster in the config never move, nothing is signed past those
 * caps, and no reply carries a terminal escape or a bidi control back to
 * whoever renders it.
 */
import * as fs from 'node:fs';
import fc from 'fast-check';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

fc.configureGlobal({ seed: 0xf022, numRuns: 500 });

// Hoisted with the mocks, so the paths mock can read it. A fresh directory per
// run keeps parallel runs on a shared tmpdir from writing into each other.
const PATHS = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'jaw-mcp-fuzz-'));
  return {
    root,
    config: join(root, 'config.json'),
    session: join(root, 'session.json'),
    relay: join(root, 'relay.json'),
    keystore: join(root, 'keystore.json'),
    sessionConfig: join(root, 'session-config.json'),
    x402Log: join(root, 'x402-log.jsonl'),
    paymentLock: join(root, 'x402-payment.lock'),
  };
});
const ROOT = PATHS.root;

vi.mock('../lib/paths.js', () => ({ PATHS }));

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
      // Shaped like a confirmed send, so a top-up runs through to the payment.
      if (method === 'wallet_sendCalls') return Promise.resolve({ id: '0xbatch', chainId: 84532 });
      if (method === 'wallet_getCallsStatus') return Promise.resolve({ status: 200 });
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
const { saveSessionConfig } = await import('../lib/session-config.js');
const { supportsSessionMode } = await import('../lib/rpc-classifier.js');
const { isValidKeysUrl, isValidRelayUrl } = await import('../lib/validation.js');

const PAY_TO = '0x' + '11'.repeat(20);
const X402 = { maxAmountPerPayment: '200000', maxTotalPerSession: '1000000', allowedPayTo: [PAY_TO] };
const PAYMASTERS = { 84532: { url: 'https://pm.example/rpc', context: { policy: 'p' } } };
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const fetched: string[] = [];
/** What the server signed, read off the proof it sent back with the retry. */
const signed: Array<{ amount: string; payTo: string; asset: string; network: string }> = [];
/** The PAYMENT-REQUIRED header the next unsigned fetch answers with, if any. */
let challenge: string | null = null;
let client: Client;

const response = (status: number, headers: Record<string, string>) => ({
  status,
  headers: { get: (k: string) => headers[k] ?? null },
  text: async () => '{}',
});

beforeAll(async () => {
  process.env['JAW_API_KEY'] = 'fuzz-key';
  saveConfig({ apiKey: 'fuzz-key', x402: X402, paymasters: PAYMASTERS } as Parameters<typeof saveConfig>[0]);
  // A session key and a session, so the payment path runs through the policy,
  // the top-up and the signature.
  saveKeystore('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', '0xSessionAddr');
  saveSessionConfig({
    mode: 'eip7702',
    ownerAddress: '0x' + '22'.repeat(20),
    sessionAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    permissionId: '0x' + '77'.repeat(32),
    chainId: 84532,
    expiry: Math.floor(Date.now() / 1000) + 86_400,
  });
  vi.stubGlobal('fetch', async (url: unknown, init?: { headers?: Record<string, string> }) => {
    fetched.push(String(url));
    const proof = init?.headers?.['PAYMENT-SIGNATURE'];
    if (proof) {
      signed.push(JSON.parse(Buffer.from(proof, 'base64').toString()).accepted);
      const receipt = Buffer.from(JSON.stringify({ success: true, transaction: '0x' + 'ab'.repeat(32) }));
      return response(200, { 'PAYMENT-RESPONSE': receipt.toString('base64') });
    }
    return challenge ? response(402, { 'PAYMENT-REQUIRED': challenge }) : response(200, {});
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
// A plain paid fetch, so the generated 402 challenges reach the policy, the
// top-up and the signer rather than stopping at the url schema.
const paidFetch = fc.record({
  name: fc.constant('jaw_pay_and_fetch'),
  arguments: fc.constant({ url: 'https://api.example.com/x' }),
});
const call = fc.oneof(anyCall, shapedCall, paidFetch);

// Matching control characters is the point of this pattern.
// eslint-disable-next-line no-control-regex
const DISARMED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

function textsOf(result: unknown): string[] {
  const content = (result as { content?: Array<{ text?: unknown }> }).content ?? [];
  return content.map((block) => String(block.text ?? ''));
}

const REGISTRY_USDC = [USDC_BASE_SEPOLIA, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'].map((a) => a.toLowerCase());

/** A 402 challenge some fetches answer with, so the policy, top-up and signer run too. */
const challengeHeader = fc
  .array(
    fc.record({
      scheme: fc.constantFrom('exact', 'exact', 'upto'),
      network: fc.constantFrom('eip155:84532', 'eip155:84532', 'eip155:8453', 'eip155:1'),
      amount: fc.constantFrom('0', '500', '200000', '200001', '300000'),
      asset: fc.constantFrom(USDC_BASE_SEPOLIA, USDC_BASE_SEPOLIA, '0x' + '33'.repeat(20)),
      payTo: fc.constantFrom(PAY_TO, PAY_TO, '0x' + '44'.repeat(20)),
      maxTimeoutSeconds: fc.constant(60),
    }),
    { minLength: 1, maxLength: 3 }
  )
  .map((accepts) =>
    Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: 'https://api.example.com/x' }, accepts })).toString(
      'base64'
    )
  );

describe('generated MCP tool calls', () => {
  it('fail closed: no effect outside what each tool is allowed, and the server keeps answering', async () => {
    let totalSigned = 0n;
    await fc.assert(
      fc.asyncProperty(call, fc.option(challengeHeader, { nil: null }), async (c, header) => {
        sessionRequests.length = 0;
        fetched.length = 0;
        signed.length = 0;
        challenge = header;

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

        // Whatever the challenge offered, only what the configured caps allow is signed.
        for (const payment of signed) {
          expect(BigInt(payment.amount)).toBeLessThanOrEqual(200_000n);
          expect(payment.payTo.toLowerCase()).toBe(PAY_TO);
          expect(REGISTRY_USDC).toContain(payment.asset.toLowerCase());
          totalSigned += BigInt(payment.amount);
        }
        expect(totalSigned).toBeLessThanOrEqual(1_000_000n);

        const config = loadConfig();
        expect(config.x402).toEqual(X402);
        expect(config.paymasters).toEqual(PAYMASTERS);
        if (config.keysUrl !== undefined) expect(isValidKeysUrl(config.keysUrl)).toBe(true);
        if (config.relayUrl !== undefined) expect(isValidRelayUrl(config.relayUrl)).toBe(true);
      })
    );
    challenge = null;

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
  }, 120_000);

  // Known gap, pinned so it flips when fixed. Arguments that fail the schema
  // never reach a handler: the SDK answers itself, and its message dumps the
  // zod issues, `received` value included, without passing through `mcpError`.
  // An enum is the one issue that echoes the input, so `jaw_config_set.key`
  // carries a bidi override straight back.
  it.fails('disarms what the SDK echoes when arguments fail the schema', async () => {
    const reply = await client.callTool({ name: 'jaw_config_set', arguments: { key: 'pay\u202eevil', value: 'x' } });
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

  it('reaches the paid path too: policy, top-up through the session, and a signature', async () => {
    // A fresh ledger, since the property above may have spent the session cap.
    fs.rmSync(PATHS.x402Log, { force: true });
    sessionRequests.length = 0;
    signed.length = 0;
    challenge = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: { url: 'https://api.example.com/x' },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:84532',
            amount: '500',
            asset: USDC_BASE_SEPOLIA,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
          },
        ],
      })
    ).toString('base64');

    await client.callTool({ name: 'jaw_pay_and_fetch', arguments: { url: 'https://api.example.com/x' } });
    challenge = null;

    expect(sessionRequests).toContain('wallet_sendCalls');
    expect(signed).toEqual([expect.objectContaining({ amount: '500', payTo: PAY_TO })]);
  });
});
