/**
 * What an MCP client is allowed to ask this server for, written out by hand.
 *
 * The tool list is the server's whole authority surface: a new argument, a
 * widened enum, or a dropped `readOnlyHint` changes what an unattended client
 * may request, and none of it shows up as a type error. So the contract lives
 * here as a table, compared against what the running server advertises over
 * the protocol. A change to the surface has to change a line below, in the same
 * diff, where a reviewer sees it.
 *
 * Descriptions are left out on purpose: they change often and do not widen
 * what a client can request. `tools.test.ts` covers the parts of them that
 * steer a client.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect } from 'vitest';

import { createMcpServer } from './server.js';

type Arg = { type?: string; enum?: string[] };
type ToolContract = { args: Record<string, Arg>; required: string[]; readOnly: boolean };

const CONTRACT: Record<string, ToolContract> = {
  jaw_rpc: {
    // `params` is untyped on purpose: the method decides its shape, and what
    // may run without a browser is decided by `supportsSessionMode`, not here.
    args: { method: { type: 'string' }, params: {}, chainId: { type: 'integer' }, session: { type: 'boolean' } },
    required: ['method'],
    readOnly: false,
  },
  jaw_config_show: { args: {}, required: [], readOnly: true },
  jaw_config_set: {
    // No `x402.*` and no `paymasters`: a client must not be able to raise its
    // own spending caps or pick who sponsors its sends.
    args: {
      key: { type: 'string', enum: ['apiKey', 'defaultChain', 'keysUrl', 'ens', 'relayUrl', 'sessionExpiry'] },
      value: { type: 'string' },
    },
    required: ['key', 'value'],
    readOnly: false,
  },
  jaw_status: { args: {}, required: [], readOnly: true },
  jaw_disconnect: { args: {}, required: [], readOnly: false },
  jaw_session_status: { args: {}, required: [], readOnly: true },
  jaw_pay_and_fetch: {
    args: {
      url: { type: 'string' },
      method: { type: 'string' },
      headers: { type: 'object' },
      body: { type: 'string' },
      maxAmount: { type: 'string' },
      asset: { type: 'string' },
      network: { type: 'string' },
    },
    required: ['url'],
    readOnly: false,
  },
  jaw_x402_log: { args: { limit: { type: 'number' } }, required: [], readOnly: true },
  jaw_x402_balance: { args: { network: { type: 'string' } }, required: [], readOnly: true },
  jaw_discover: {
    args: {
      query: { type: 'string' },
      network: { type: 'string' },
      maxUsdPrice: { type: 'string' },
      curatedOnly: { type: 'boolean' },
      limit: { type: 'integer' },
      payTo: { type: 'string' },
    },
    required: [],
    readOnly: true,
  },
};

const RESOURCES = ['jaw://api-reference', 'jaw://x402'];
const RESOURCE_TEMPLATES = ['jaw://api-reference/{method}'];

async function connect() {
  const server = createMcpServer('test');
  const client = new Client({ name: 'conformance', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

type Advertised = {
  inputSchema: { properties?: Record<string, { type?: string; enum?: string[] }>; required?: string[] };
  annotations?: { readOnlyHint?: boolean };
};

function contractOf(tool: Advertised): ToolContract {
  const args = Object.fromEntries(
    Object.entries(tool.inputSchema.properties ?? {}).map(([name, schema]) => [
      name,
      { ...(schema.type ? { type: schema.type } : {}), ...(schema.enum ? { enum: schema.enum } : {}) },
    ])
  );
  return {
    args,
    required: [...(tool.inputSchema.required ?? [])].sort(),
    readOnly: tool.annotations?.readOnlyHint === true,
  };
}

describe('the MCP surface', () => {
  it('advertises exactly the tools in the contract, each with the arguments written there', async () => {
    const { tools } = await (await connect()).listTools();

    const advertised = Object.fromEntries(tools.map((tool) => [tool.name, contractOf(tool as Advertised)]));
    const expected = Object.fromEntries(
      Object.entries(CONTRACT).map(([name, c]) => [name, { ...c, required: [...c.required].sort() }])
    );
    expect(advertised).toEqual(expected);
  });

  it('advertises no open-ended argument object', async () => {
    const { tools } = await (await connect()).listTools();
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).not.toHaveProperty('additionalProperties', true);
    }
  });

  it('serves exactly the resources in the contract', async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();

    expect(resources.map((r) => r.uri).sort()).toEqual(RESOURCES);
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(RESOURCE_TEMPLATES);
  });
});
