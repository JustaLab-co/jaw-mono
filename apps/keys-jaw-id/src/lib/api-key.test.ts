import { describe, it, expect } from 'vitest';
import { apiKeyFromChain } from './api-key';

const RPC = 'https://api.justaname.id/proxy/v1/rpc?chainId=8453';

describe('apiKeyFromChain', () => {
  it('prefers the key it was handed', () => {
    expect(apiKeyFromChain('mine', `${RPC}&api-key=from-url`)).toBe('mine');
  });

  it('reads the one the dApp put in the rpc url', () => {
    expect(apiKeyFromChain(undefined, `${RPC}&api-key=from-url`)).toBe('from-url');
  });

  // The case the six copies spelled as '': keyless there is no key anywhere, and
  // everything downstream takes it optional.
  it.each([
    ['no key in the url', RPC],
    ['an empty key in the url', `${RPC}&api-key=`],
    ['no url at all', undefined],
    ['a url that does not parse', 'not a url'],
  ])('answers undefined with %s', (_label, rpcUrl) => {
    expect(apiKeyFromChain(undefined, rpcUrl)).toBeUndefined();
  });

  it('treats an empty key handed in as no key', () => {
    expect(apiKeyFromChain('', RPC)).toBeUndefined();
  });
});
