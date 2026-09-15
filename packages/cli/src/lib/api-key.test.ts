import { describe, it, expect, afterEach } from 'vitest';
import { apiKeyFor, isRejectedApiKey } from './api-key.js';

describe('isRejectedApiKey', () => {
  it('recognises the refusal as the REST client reports it', () => {
    const err = Object.assign(new Error('ApiKeyInvalidException: Invalid Api Key'), { status: 403 });
    expect(isRejectedApiKey(err)).toBe(true);
  });

  /**
   * viem keeps the status and drops the body, and the transport error arrives
   * inside whatever action was running, so the status has to be found down the
   * chain rather than on the error that surfaces.
   */
  it('recognises a 403 wrapped by the action that hit it', () => {
    const transport = Object.assign(new Error('HTTP request failed.'), { status: 403 });
    const action = new Error('sendUserOperation failed', { cause: transport });
    expect(isRejectedApiKey(action)).toBe(true);
  });

  it('leaves every other failure alone', () => {
    expect(isRejectedApiKey(new Error('bundler is down'))).toBe(false);
    expect(isRejectedApiKey(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(false);
    expect(isRejectedApiKey('not even an error')).toBe(false);
  });
});

describe('apiKeyFor', () => {
  afterEach(() => {
    delete process.env['JAW_API_KEY'];
  });

  it('prefers the key the caller was given over everything stored', () => {
    process.env['JAW_API_KEY'] = 'from-env';
    expect(apiKeyFor({ apiKey: 'mine', workspaceApiKey: 'injected' }, 'from-flag')).toBe('from-flag');
  });

  it('prefers the environment over both stored keys', () => {
    process.env['JAW_API_KEY'] = 'from-env';
    expect(apiKeyFor({ apiKey: 'mine', workspaceApiKey: 'injected' })).toBe('from-env');
  });

  it("prefers the user's own key over the injected one", () => {
    expect(apiKeyFor({ apiKey: 'mine', workspaceApiKey: 'injected' })).toBe('mine');
  });

  /**
   * The case this resolver exists for: nobody pasted a key, the browser handed
   * one over on connect, and the paying path has to see it. Reading `apiKey`
   * alone answered undefined here, which is a payment that cannot refill its
   * payer.
   */
  it('falls back to the key the browser handed us', () => {
    expect(apiKeyFor({ workspaceApiKey: 'injected' })).toBe('injected');
  });

  it('answers undefined when there is no key anywhere', () => {
    expect(apiKeyFor({})).toBeUndefined();
  });
});
