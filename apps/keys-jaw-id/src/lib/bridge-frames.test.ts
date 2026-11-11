import { describe, expect, it } from 'vitest';
import { MAX_APP_LOGO_URL_LENGTH, parseInit, parseRequest } from './bridge-frames';

const chains = [1, 8453, 84532];

describe('parseInit accepts what real clients send', () => {
  it('the CLI init with only a chain', () => {
    expect(parseInit({ type: 'init', chainId: 8453 }, chains)).toEqual({ chainId: 8453 });
  });

  it('the CLI init with every field it can carry', () => {
    const init = {
      type: 'init',
      apiKey: 'k',
      chainId: 84532,
      ens: 'name.jaw.id',
      paymasterUrl: 'https://pm.example/rpc',
      paymasterContext: { token: '0xabc' },
    };
    expect(parseInit(init, chains)).toEqual({
      chainId: 84532,
      apiKey: 'k',
      ens: 'name.jaw.id',
      paymaster: { url: 'https://pm.example/rpc', context: { token: '0xabc' } },
    });
  });

  it('the MCP init with a chain and an app name', () => {
    expect(parseInit({ type: 'init', chainId: 1, appName: 'Claude' }, chains)).toEqual({
      chainId: 1,
      appName: 'Claude',
    });
  });

  it('optional fields a JSON round trip dropped stay absent', () => {
    const result = parseInit(
      JSON.parse(JSON.stringify({ chainId: 1, ens: undefined, paymasterUrl: undefined })),
      chains
    );
    expect(result).toEqual({ chainId: 1 });
    expect(Object.keys(result)).toEqual(['chainId']);
  });

  it('null optional fields, read as absent', () => {
    expect(
      parseInit(
        { chainId: 1, ens: null, appName: null, apiKey: null, paymasterUrl: null, paymasterContext: null },
        chains
      )
    ).toEqual({ chainId: 1 });
  });

  it('a paymaster url with no context', () => {
    expect(parseInit({ chainId: 1, paymasterUrl: 'https://pm.example' }, chains)).toEqual({
      chainId: 1,
      paymaster: { url: 'https://pm.example' },
    });
  });

  it.each(['http://localhost:3000/rpc', 'http://127.0.0.1:4337', 'http://[::1]:4337'])(
    'a local http paymaster during development: %s',
    (paymasterUrl) => {
      expect(parseInit({ chainId: 1, paymasterUrl }, chains)).toEqual({ chainId: 1, paymaster: { url: paymasterUrl } });
    }
  );
});

describe('parseInit refuses what no client sends', () => {
  it.each([
    ['a missing chainId', {}],
    ['a null chainId', { chainId: null }],
    ['a string chainId', { chainId: '1' }],
    ['a fractional chainId', { chainId: 1.5 }],
    ['an unsupported chainId', { chainId: 999999 }],
    ['a numeric ens', { chainId: 1, ens: 5 }],
    ['a numeric appName', { chainId: 1, appName: 5 }],
    ['an object apiKey', { chainId: 1, apiKey: {} }],
    ['a numeric paymasterUrl', { chainId: 1, paymasterUrl: 5 }],
    ['a non-url paymasterUrl', { chainId: 1, paymasterUrl: 'not a url' }],
    ['an http paymasterUrl on a public host', { chainId: 1, paymasterUrl: 'http://pm.example' }],
    ['an http host that only starts like localhost', { chainId: 1, paymasterUrl: 'http://localhost.evil.test' }],
    ['a javascript paymasterUrl', { chainId: 1, paymasterUrl: 'javascript:alert(1)' }],
    ['a paymasterContext with no paymasterUrl', { chainId: 1, paymasterContext: {} }],
    ['an array paymasterContext', { chainId: 1, paymasterUrl: 'https://pm.example', paymasterContext: [] }],
    ['a string paymasterContext', { chainId: 1, paymasterUrl: 'https://pm.example', paymasterContext: 'x' }],
  ])('%s', (_name, inner) => {
    const result = parseInit(inner, chains);
    expect(result).toEqual({ refused: expect.any(String) });
  });

  it('names an unsupported chain in the reason', () => {
    expect(parseInit({ chainId: 999999 }, chains)).toEqual({ refused: 'Unsupported chainId: 999999' });
  });
});

describe('parseRequest', () => {
  it('accepts a request with params', () => {
    expect(parseRequest({ id: 'r1', method: 'eth_chainId', params: [] })).toEqual({
      id: 'r1',
      method: 'eth_chainId',
      params: [],
    });
  });

  it('treats missing params as an empty list', () => {
    expect(parseRequest({ id: 'r1', method: 'eth_chainId' })).toEqual({ id: 'r1', method: 'eth_chainId', params: [] });
  });

  it.each([{}, { id: '' }, { id: 5 }])('a request with no usable id is no-id: %j', (inner) => {
    expect(parseRequest({ method: 'eth_chainId', ...inner })).toBe('no-id');
  });

  it.each([undefined, '', 5, null, {}])('refuses method %j with -32600', (method) => {
    expect(parseRequest({ id: 'r1', method })).toMatchObject({ id: 'r1', code: -32600 });
  });

  it.each([{ calls: [] }, 'x', 5])(
    'wraps a lone params value %j as the first param, as published CLIs send it',
    (params) => {
      expect(parseRequest({ id: 'r1', method: 'wallet_sendCalls', params })).toEqual({
        id: 'r1',
        method: 'wallet_sendCalls',
        params: [params],
      });
    }
  );

  it('treats null params as an empty list', () => {
    expect(parseRequest({ id: 'r1', method: 'eth_chainId', params: null })).toMatchObject({ params: [] });
  });
});

describe('parseInit client', () => {
  it.each(['jaw-cli/0.7.2', 'jaw-mcp/abc1234'])('keeps %s', (client) => {
    expect(parseInit({ type: 'init', chainId: 1, client }, chains)).toEqual({ chainId: 1, client });
  });

  it.each([
    ['a number', 7],
    ['an empty string', ''],
    ['a value too long', `${'a'.repeat(33)}/1.0`],
    ['a value with spaces', 'jaw cli/1.0'],
    ['a value with a newline', 'jaw-cli/1.0\nx'],
    ['no slash', 'jaw-cli'],
    ['null', null],
  ])('drops %s without refusing the init', (_, client) => {
    const result = parseInit({ type: 'init', chainId: 1, client }, chains);
    expect(result).toEqual({ chainId: 1 });
    expect(Object.keys(result)).toEqual(['chainId']);
  });
});

describe('parseInit appLogoUrl', () => {
  it('keeps an https logo address', () => {
    const appLogoUrl = 'https://mcp.jaw.id/logos/claude.svg';
    expect(parseInit({ type: 'init', chainId: 1, appName: 'Claude', appLogoUrl }, chains)).toEqual({
      chainId: 1,
      appName: 'Claude',
      appLogoUrl,
    });
  });

  it('keeps an address of exactly the cap and drops one a character longer', () => {
    const atCap = `https://mcp.jaw.id/${'a'.repeat(MAX_APP_LOGO_URL_LENGTH - 'https://mcp.jaw.id/'.length)}`;
    expect(atCap).toHaveLength(MAX_APP_LOGO_URL_LENGTH);
    expect(parseInit({ type: 'init', chainId: 1, appLogoUrl: atCap }, chains)).toEqual({
      chainId: 1,
      appLogoUrl: atCap,
    });
    expect(parseInit({ type: 'init', chainId: 1, appLogoUrl: `${atCap}a` }, chains)).toEqual({ chainId: 1 });
  });

  it.each([
    ['a number', 7],
    ['an empty string', ''],
    ['an http address', 'http://mcp.jaw.id/logos/claude.svg'],
    ['a data uri', 'data:image/png;base64,iVBORw0KGgo='],
    ['a javascript uri', 'javascript:alert(1)'],
    ['a relative path', '/logos/claude.svg'],
    ['null', null],
  ])('drops %s without refusing the init', (_, appLogoUrl) => {
    const result = parseInit({ type: 'init', chainId: 1, appLogoUrl }, chains);
    expect(result).toEqual({ chainId: 1 });
    expect(Object.keys(result)).toEqual(['chainId']);
  });
});

describe('parseInit and the account', () => {
  const account = '0x1111111111111111111111111111111111111111';

  it('keeps an address', () => {
    expect(parseInit({ chainId: 1, account }, chains)).toEqual({ chainId: 1, account });
  });

  it('keeps a checksummed address as sent', () => {
    const checksummed = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(parseInit({ chainId: 1, account: checksummed }, chains)).toEqual({ chainId: 1, account: checksummed });
  });

  it.each([null, undefined])('reads %s as no account', (value) => {
    expect(parseInit({ chainId: 1, account: value }, chains)).toEqual({ chainId: 1 });
  });

  it('an init without one parses as it did before', () => {
    expect(Object.keys(parseInit({ chainId: 1, appName: 'Claude' }, chains))).toEqual(['chainId', 'appName']);
  });

  it.each([
    ['a name', 'adz.jawbot.eth'],
    ['a short hex', '0x1234'],
    ['a number', 5],
    ['an object', { address: account }],
    ['an empty string', ''],
    ['a mixed case address with a bad checksum', '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
  ])('refuses %s', (_, value) => {
    expect(parseInit({ chainId: 1, account: value }, chains)).toEqual({
      refused: 'Invalid account: expected an address',
    });
  });
});
