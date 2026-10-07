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

  it.each(['JAW CLI', 'jaw', 'My Jaw Wallet', 'JAW​CLI'])('flags a CIMD client calling itself %j', (name) => {
    const id = clientIdentity('https://evil.example/c.json', name);
    expect(id).toMatchObject({ official: false, reservedName: true, host: 'evil.example' });
  });
});
