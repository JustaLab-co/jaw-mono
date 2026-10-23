import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { callTool, connect, mcp, setTestEnv } from '@/connections/testkit';

setTestEnv();
beforeAll(useTestDb);

type Result = { content?: { type: string; text?: string }[]; structuredContent?: { summary?: string } };

const isJson = (text: string) => {
  try {
    return typeof JSON.parse(text) === 'object';
  } catch {
    return false;
  }
};

/**
 * What an agent would read out to the owner: the prose it was handed and any summary.
 * The structured result is also sent as a JSON text block; its field names are the API, not prose.
 */
const spoken = (r: Result) =>
  [...(r.content ?? []).map((c) => c.text ?? '').filter((t) => !isJson(t)), r.structuredContent?.summary ?? ''].join(
    '\n'
  );

/** Words that only make sense inside the server. None of them should reach the owner. */
const INTERNAL = [/\bjaw_[a-z_]+/, /x402/i, /\bfloat\b/i, /paymaster/i, /\bproxy\b/i, /idempotency/i, /calldata/i];

const leaks = (text: string) => INTERNAL.filter((w) => w.test(text)).map(String);

describe('the server instructions', () => {
  it('given an initialize, then the client is told to speak to the owner without naming tools or internals', async () => {
    const c = await connect();

    const r = await mcp(c.access_token, {
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });

    const instructions: string = r.json.result.instructions;
    expect(instructions).toMatch(/owner/);
    expect(instructions).toMatch(/Do not name these tools/);
  });
});

// These record text that still names tools and internals. Each flips to `it` with the change that rewords it.
describe('what a tool says about the account', () => {
  it.fails('given a connection with no budget, then the status names no tool and no internals', async () => {
    const c = await connect();

    const r = await callTool(c.access_token, 'jaw_session_status', {});

    expect(leaks(spoken(r))).toEqual([]);
  });

  it.fails('given a connection with no budget, then a refused payment names no tool and no internals', async () => {
    const c = await connect();

    const r = await callTool(c.access_token, 'jaw_session_x402_pay', {
      url: 'https://seller.test/paid',
      idempotencyKey: 'no-budget-1',
    });

    expect(leaks(spoken(r))).toEqual([]);
  });

  it.fails('given a connection without the pay scope, then the status names no tool and no internals', async () => {
    const c = await connect(undefined, { scope: 'wallet:read' });

    const r = await callTool(c.access_token, 'jaw_session_status', {});

    expect(leaks(spoken(r))).toEqual([]);
  });
});
