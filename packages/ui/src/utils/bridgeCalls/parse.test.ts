import { describe, expect, it } from 'vitest';
import { BRIDGE_CHAINS, type BridgeChain } from './contracts';
import { parse } from './parse';

type Body = { version: number; chains: Record<string, BridgeChain> };

const body = (change?: (body: Body) => void): unknown => {
  const copy = JSON.parse(JSON.stringify({ version: 2, chains: BRIDGE_CHAINS })) as Body;
  change?.(copy);
  return copy;
};
const reason = (raw: unknown) => {
  const result = parse(raw);
  return result.ok ? 'ok' : result.reason;
};

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('given the body the proxy serves for the bridge table', () => {
  it('when it is the compiled table, then it reads as a live table of that version', () => {
    const result = parse(body());
    expect(result).toMatchObject({ ok: true, contracts: { version: 2, source: 'live' } });
    if (result.ok) expect(result.contracts.chain(8453)).toEqual(BRIDGE_CHAINS[8453]);
  });

  it('when keys arrive in another order, then the table is the same', () => {
    const raw = body() as Body;
    raw.chains = Object.fromEntries(Object.entries(raw.chains).reverse());
    expect(parse(raw)).toMatchObject({ ok: true });
  });

  it('when a field the parser does not know comes along, then it is ignored', () => {
    expect(parse(body((b) => Object.assign(b.chains['8453'], { extra: 1 })))).toMatchObject({ ok: true });
  });

  it.each([
    ['not an object', 'text'],
    ['no version', { chains: BRIDGE_CHAINS }],
    ['a fractional version', { version: 1.5, chains: BRIDGE_CHAINS }],
    ['a negative version', { version: -1, chains: BRIDGE_CHAINS }],
    ['no chains', { version: 2 }],
    ['an empty chains map', { version: 2, chains: {} }],
  ])('when the body is %s, then it is rejected for its shape', (_name, raw) => {
    expect(reason(raw)).toMatch(/^bad shape/);
  });

  it('when a chain id is not a number, then it is rejected for its shape', () => {
    expect(reason(body((b) => (b.chains['base'] = b.chains['8453'])))).toMatch(/^bad shape/);
  });

  it('when a chain has no name, then it is rejected for its shape', () => {
    expect(reason(body((b) => delete (b.chains['8453'] as Partial<BridgeChain>).name))).toMatch(/^bad shape/);
  });

  it.each([-1, 37, 6.5])('when a token has %s decimals, then it is rejected', (decimals) => {
    expect(reason(body((b) => (b.chains['8453'].tokens[BASE_USDC].decimals = decimals)))).toMatch(/^bad shape/);
  });

  it('when an address is lowercase, then it is rejected as not checksummed', () => {
    const raw = body((b) => {
      const across = b.chains['8453'].across!;
      across.spokePool = across.spokePool.toLowerCase() as typeof across.spokePool;
    });
    expect(reason(raw)).toContain('not a checksummed address');
  });

  it('when a token address is lowercase, then it is rejected as not checksummed', () => {
    const raw = body((b) => {
      const tokens = b.chains['8453'].tokens;
      tokens[BASE_USDC.toLowerCase() as typeof BASE_USDC] = tokens[BASE_USDC];
      delete tokens[BASE_USDC];
    });
    expect(reason(raw)).toMatch(/^bad shape.*tokens/);
  });

  it('when one address holds two roles on a chain, then it is rejected', () => {
    const raw = body((b) => {
      const chain = b.chains['8453'];
      chain.relay!.depository = chain.across!.spokePool;
    });
    expect(reason(raw)).toBe('chain 8453: an address holds two roles');
  });

  it('when two chains share a protocolChain, then it is rejected', () => {
    const raw = body((b) => (b.chains['10'].relay!.protocolChain = b.chains['8453'].relay!.protocolChain));
    expect(reason(raw)).toBe('two chains share a protocolChain');
  });

  it('when a mainnet Relay chain has no routers, then it is rejected', () => {
    expect(reason(body((b) => (b.chains['8453'].relay!.erc20Routers = [])))).toBe(
      'chain 8453: a Relay chain has no routers'
    );
  });

  it('when a testnet Relay chain has no routers, then it is accepted', () => {
    expect(parse(body((b) => (b.chains['11155111'].relay!.erc20Routers = [])))).toMatchObject({ ok: true });
  });

  it('when a Relay chain lists a solver twice, then it is rejected', () => {
    const raw = body((b) => {
      const { solvers } = b.chains['8453'].relay!;
      b.chains['8453'].relay!.solvers = [...solvers, solvers[0]];
    });
    expect(reason(raw)).toBe('chain 8453: a Relay solver is listed twice');
  });

  it('when a Relay chain lists no solver, then it is rejected for its shape', () => {
    expect(reason(body((b) => (b.chains['8453'].relay!.solvers = [])))).toMatch(/^bad shape/);
  });
});
