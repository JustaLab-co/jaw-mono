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

  it.each(['Raj Awesome', 'Mijaw', 'Jawbone', 'Example Agent', 'J. Awesome', 'Jaws'])('does not flag %j', (name) => {
    expect(clientIdentity('https://agent.example/c.json', name).reservedName).toBe(false);
  });

  it.each([
    ['J\u200BAW', 'zero width space'],
    ['JA\u200BW', 'zero width space'],
    ['J\u00ADaw', 'soft hyphen'],
    ['J\u2060aw', 'word joiner'],
    ['J\u034Faw', 'combining grapheme joiner'],
    ['J\u180Eaw', 'mongolian vowel separator'],
    ['j\u200Daw', 'zero width joiner'],
    ['ja\u3164w', 'hangul filler'],
    ['j\u115Faw', 'hangul choseong filler'],
    ['ja\u1160w', 'hangul jungseong filler'],
    ['jaw\uFFA0', 'halfwidth hangul filler'],
  ])('flags %j: an invisible %s inside "jaw" does not split it', (name) => {
    expect(clientIdentity('https://evil.example/c.json', name).reservedName).toBe(true);
  });

  it.each([
    ['J\u00ADaw', 'Jaw'],
    ['J\u2060aw', 'Jaw'],
    ['J\u034Faw', 'Jaw'],
    ['ja\u3164w', 'jaw'],
    ['jaw\uFFA0 Wallet', 'jaw Wallet'],
  ])('shows %j without its invisible characters', (name, shown) => {
    expect(clientIdentity('https://evil.example/c.json', name).name).toBe(shown);
  });

  it.each(['JawWallet', 'MyJaw', 'JAWApp', 'JAWwallet', 'myJAW', 'Jaw2Go', 'JAWCLI'])(
    'flags %j: "jaw" starts or ends a camel case segment',
    (name) => {
      expect(clientIdentity('https://evil.example/c.json', name).reservedName).toBe(true);
    }
  );

  it.each(['Mijaw', 'Jawbone', 'Jaws', 'Sjawa'])(
    'does not flag %j: "jaw" only runs inside a lowercase segment',
    (name) => {
      expect(clientIdentity('https://agent.example/c.json', name).reservedName).toBe(false);
    }
  );

  it.each(['\u1D0A\u1D00\u1D21', '\u1D0A\u1D00\u1D21 Wallet'])('flags %j: small capitals fold to "jaw"', (name) => {
    expect(clientIdentity('https://evil.example/c.json', name).reservedName).toBe(true);
  });

  it('judges the raw name and shows it sanitized', () => {
    const id = clientIdentity('https://evil.example/c.json', 'JAW\u200BCLI\u202E');
    expect(id.reservedName).toBe(true);
    expect(id.name).not.toContain('\u200B');
    expect(id.name).not.toContain('\u202E');
  });

  it.each(['J\u1EA1w', 'J\u00E0w', 'J\u0251w', '\u13ABaw', 'Ja\u13B3', '\u13AB\u13AA\u13D4'])(
    'flags %j: marks fold away after decomposition, and Cherokee and Latin alpha fold like other lookalikes',
    (name) => {
      expect(clientIdentity('https://evil.example/c.json', name).reservedName).toBe(true);
    }
  );

  it.each(['JAWS', 'JAWAD', 'JAWBONE'])(
    'flags %j, an accepted false positive: dropping the all-capitals rule would let JAW\u200BCLI pass as JAWCLI',
    (name) => {
      expect(clientIdentity('https://agent.example/c.json', name).reservedName).toBe(true);
    }
  );
});
