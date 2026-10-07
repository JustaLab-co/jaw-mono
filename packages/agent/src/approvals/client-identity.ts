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

const LOOKALIKES: Readonly<Record<string, string>> = {
  ј: 'j',
  ϳ: 'j',
  ᴊ: 'j',
  а: 'a',
  α: 'a',
  ᴀ: 'a',
  ԝ: 'w',
  ѡ: 'w',
  ω: 'w',
  ᴡ: 'w',
};

const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

const isLower = (c: string | undefined) => c !== undefined && /\p{Ll}/u.test(c);
const isUpper = (c: string | undefined) => c !== undefined && /\p{Lu}/u.test(c);
const isDigit = (c: string | undefined) => c !== undefined && /\p{N}/u.test(c);

function foldsToJaw(chars: string[]): boolean {
  return chars.map((c) => LOOKALIKES[c.toLowerCase()] ?? c.toLowerCase()).join('') === 'jaw';
}

function startsSegment(chars: string[], i: number): boolean {
  const [before, prev, cur, next] = [chars[i - 2], chars[i - 1], chars[i], chars[i + 1]];
  if (isLower(prev) && isUpper(cur)) return true;
  if (isUpper(prev) && isUpper(cur) && isLower(next)) return true;
  if (isUpper(before) && isUpper(prev) && isLower(cur)) return true;
  return isDigit(prev) !== isDigit(cur);
}

function wordClaimsJaw(word: string): boolean {
  const chars = [...word];
  if (chars.length <= 3) return foldsToJaw(chars);
  const capitals = !chars.some(isLower);
  const end = chars.length - 3;
  return (
    (foldsToJaw(chars.slice(0, 3)) && (capitals || startsSegment(chars, 3))) ||
    (foldsToJaw(chars.slice(end)) && (capitals || startsSegment(chars, end)))
  );
}

function claimsJaw(name: string): boolean {
  const visible = name.normalize('NFKC').replace(HIDDEN, '').replace(/\p{M}/gu, '');
  const words: string[] = [];
  let letters = '';
  for (const word of visible.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    // "J.A.W" and "J A W" spell one word out of single letters.
    if ([...word].length === 1) {
      letters += word;
      continue;
    }
    if (letters) words.push(letters);
    letters = '';
    words.push(word);
  }
  if (letters) words.push(letters);
  return words.some(wordClaimsJaw);
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
    name: firstParty ?? sanitizeLine(declaredName.replace(HIDDEN, ''), 64),
    host,
    official: firstParty !== undefined,
    reservedName: firstParty === undefined && claimsJaw(declaredName),
  };
}
