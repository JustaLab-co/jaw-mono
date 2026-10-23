import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '@/db/test-db';
import { callTool, connect, mcp, setTestEnv } from '@/connections/testkit';
import { FOR_AGENT } from '@/tools/reply';

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

/** Each line once: the summary is usually also the first text block. */
const prose = (r: Result) => [
  ...new Set(
    [...(r.content ?? []).map((c) => c.text ?? '').filter((t) => !isJson(t)), r.structuredContent?.summary ?? '']
      .join('\n')
      .split('\n')
  ),
];

/**
 * What an agent would read out to the owner: the prose it was handed and any summary, less the lines
 * marked for the agent. The structured result is also sent as a JSON text block; its field names are the API.
 */
const spoken = (r: Result) =>
  prose(r)
    .filter((l) => !l.startsWith(FOR_AGENT))
    .join('\n');

const toAgent = (r: Result) => prose(r).filter((l) => l.startsWith(FOR_AGENT));

/** Words that only make sense inside the server. None of them should reach the owner. */
const INTERNAL = [
  /\bjaw_[a-z_]+/,
  /eip155:/,
  /x402/i,
  /\bfloat\b/i,
  /paymaster/i,
  /\bproxy\b/i,
  /idempotency/i,
  /calldata/i,
];

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
    expect(instructions).toContain(`"${FOR_AGENT}" is for you alone`);
  });
});

describe('what a tool says about the account', () => {
  it('given a connection with no budget, then the status names no tool and no internals, and tells the agent how to ask for one', async () => {
    const c = await connect();

    const r = await callTool(c.access_token, 'jaw_session_status', {});

    expect(leaks(spoken(r))).toEqual([]);
    expect(spoken(r)).toContain('on Base Sepolia');
    expect(toAgent(r)).toEqual([`${FOR_AGENT} Ask for one with jaw_grant_permissions and x402Budget.`]);
  });

  // Records text that still names tools and internals. Flips to `it` with the change that rewords it.

  it.fails('given a connection with no budget, then a refused payment names no tool and no internals', async () => {
    const c = await connect();

    const r = await callTool(c.access_token, 'jaw_session_x402_pay', {
      url: 'https://seller.test/paid',
      idempotencyKey: 'no-budget-1',
    });

    expect(leaks(spoken(r))).toEqual([]);
  });

  it('given a connection without the pay scope, then the status names no tool and no internals, and tells the agent to reconnect', async () => {
    const c = await connect(undefined, { scope: 'wallet:read' });

    const r = await callTool(c.access_token, 'jaw_session_status', {});

    expect(leaks(spoken(r))).toEqual([]);
    expect(toAgent(r)).toEqual([`${FOR_AGENT} Reconnect and ask for the x402:pay scope.`]);
  });
});
