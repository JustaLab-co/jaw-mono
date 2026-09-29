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
 *
 * The table holds what JSON Schema can carry: types, enums, numeric and length
 * bounds, formats, and the value type of a record. A zod `refine` or
 * `transform` does not reach the advertised schema, so the http(s)-only rule on
 * `jaw_pay_and_fetch.url` is held by `tools.test.ts` and the fuzz test instead.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect } from 'vitest';

import { createMcpServer } from './server.js';

const BOUNDS = ['enum', 'minimum', 'maximum', 'exclusiveMinimum', 'maxLength', 'format'] as const;
type Arg = { type?: string; values?: string } & Partial<Record<(typeof BOUNDS)[number], unknown>>;
type ToolContract = { args: Record<string, Arg>; required: string[]; readOnly: boolean };

const CONTRACT: Record<string, ToolContract> = {
  jaw_rpc: {
    // `params` is untyped on purpose: the method decides its shape, and what
    // may run without a browser is decided by `supportsSessionMode`, not here.
    args: {
      method: { type: 'string' },
      params: {},
      chainId: { type: 'integer', exclusiveMinimum: 0 },
      session: { type: 'boolean' },
    },
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
      url: { type: 'string', format: 'uri' },
      method: { type: 'string' },
      headers: { type: 'object', values: 'string' },
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
      query: { type: 'string', maxLength: 400 },
      network: { type: 'string' },
      maxUsdPrice: { type: 'string' },
      curatedOnly: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
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

type AdvertisedArg = Record<string, unknown> & { type?: string; additionalProperties?: { type?: string } };

type Advertised = {
  inputSchema: { properties?: Record<string, AdvertisedArg>; required?: string[] };
  annotations?: { readOnlyHint?: boolean };
};

function argOf(schema: AdvertisedArg): Arg {
  const arg: Arg = {};
  if (schema.type) arg.type = schema.type;
  if (schema.additionalProperties?.type) arg.values = schema.additionalProperties.type;
  for (const bound of BOUNDS) if (schema[bound] !== undefined) arg[bound] = schema[bound];
  return arg;
}

function contractOf(tool: Advertised): ToolContract {
  const properties = Object.entries(tool.inputSchema.properties ?? {});
  const args = Object.fromEntries(properties.map(([name, schema]) => [name, argOf(schema)]));
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
