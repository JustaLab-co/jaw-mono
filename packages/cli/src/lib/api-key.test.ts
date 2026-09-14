import { describe, it, expect, afterEach } from 'vitest';
import { apiKeyFor } from './api-key.js';

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
