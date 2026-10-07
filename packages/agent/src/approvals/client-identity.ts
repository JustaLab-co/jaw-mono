import { sanitizeLine } from '../util/terminal.js';

/** Clients JAW ships, registered on the server. Only these may be called official. */
export const FIRST_PARTY_CLIENTS: Readonly<Record<string, string>> = { 'jaw-cli': 'JAW CLI' };

export interface ClientIdentity {
  clientId: string;
  /** The first-party name, or what a third-party client declared about itself, sanitized. */
  name: string;
  /** Domain of the client's metadata document: the identity a third-party client cannot fake. */
  host: string | null;
  official: boolean;
  /** A third-party client whose declared name claims to be JAW. */
  reservedName: boolean;
}

// Lowercase Cyrillic and Greek letters that render like the Latin ones in "jaw".
const LOOKALIKES: Readonly<Record<string, string>> = {
  ј: 'j',
  ϳ: 'j',
  а: 'a',
  α: 'a',
  ԝ: 'w',
  ѡ: 'w',
  ω: 'w',
};

/** Whether `name` contains "jaw" as a word, after folding lookalikes and joining spelled-out letters. */
function claimsJaw(name: string): boolean {
  const folded = [...name.normalize('NFKC').toLowerCase()].map((c) => LOOKALIKES[c] ?? c).join('');
  // Anything but a letter or digit separates words, invisible characters included.
  const words: string[] = [];
  let letters = '';
  for (const word of folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    // "J.A.W" and "J A W" spell one word out of single letters.
    if (word.length === 1) {
      letters += word;
      continue;
    }
    if (letters) words.push(letters);
    letters = '';
    words.push(word);
  }
  if (letters) words.push(letters);
  return words.includes('jaw');
}

export function clientIdentity(clientId: string, declaredName: string): ClientIdentity {
  const firstParty = Object.hasOwn(FIRST_PARTY_CLIENTS, clientId) ? FIRST_PARTY_CLIENTS[clientId] : undefined;
  let host: string | null = null;
  try {
    host = new URL(clientId).host;
  } catch {
    host = null;
  }
  return {
    clientId,
    name: firstParty ?? sanitizeLine(declaredName, 64),
    host,
    official: firstParty !== undefined,
    reservedName: firstParty === undefined && claimsJaw(declaredName),
  };
}
