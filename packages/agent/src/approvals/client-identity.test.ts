import { describe, expect, it } from 'vitest';
import { clientIdentity } from './client-identity.js';

describe('clientIdentity', () => {
  it('labels only the static first-party client official, under its own name', () => {
    expect(clientIdentity('jaw-cli', 'anything')).toEqual({
      clientId: 'jaw-cli',
      name: 'JAW CLI',
      host: null,
      official: true,
      reservedName: false,
    });
  });

  it('makes the metadata document domain the identity of a CIMD client', () => {
    expect(clientIdentity('https://agent.example/client.json', 'Example Agent')).toEqual({
      clientId: 'https://agent.example/client.json',
      name: 'Example Agent',
      host: 'agent.example',
      official: false,
      reservedName: false,
    });
  });

  it.each([
    'JAW CLI',
    'jaw',
    'My Jaw Wallet',
    'JAW\u200BCLI',
    'JAW\uFFFDCLI',
    '\u0408AW',
    '\u0458aw',
    '\uFF2A\uFF21\uFF37',
    'J.A.W',
    'J-A-W',
    'J A W',
    'j\u03B1w',
  ])('flags a CIMD client calling itself %j', (name) => {
    expect(clientIdentity('https://evil.example/c.json', name)).toMatchObject({
      official: false,
      reservedName: true,
      host: 'evil.example',
    });
  });

  it.each(['Raj Awesome', 'Mijaw', 'Jawbone', 'Example Agent', 'J. Awesome'])('does not flag %j', (name) => {
    expect(clientIdentity('https://agent.example/c.json', name).reservedName).toBe(false);
  });

  it('judges the raw name and shows it sanitized', () => {
    const id = clientIdentity('https://evil.example/c.json', 'JAW\u200BCLI\u202E');
    expect(id.reservedName).toBe(true);
    expect(id.name).not.toContain('\u200B');
    expect(id.name).not.toContain('\u202E');
  });
});
