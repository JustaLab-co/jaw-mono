/**
 * For tests: what a tool result says, split into what the agent may read out to the owner and what is for the agent
 * alone, and the words that should never reach the owner.
 */
import { FOR_AGENT } from '@/tools/reply';

export interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: { summary?: string };
}

const isJson = (text: string) => {
  try {
    return typeof JSON.parse(text) === 'object';
  } catch {
    return false;
  }
};

/**
 * Every line of prose the result hands the agent, each once and none blank: the summary is usually also the first
 * text block. The structured result also comes as a JSON text block; its field names are the API, not prose.
 */
export const prose = (r: ToolResult): string[] => [
  ...new Set(
    [...(r.content ?? []).map((c) => c.text ?? '').filter((t) => !isJson(t)), r.structuredContent?.summary ?? '']
      .join('\n')
      .split('\n')
      .filter((l) => l.trim() !== '')
  ),
];

// A machine code such as `account_busy: ` or `no-grant: ` leads a refusal for the agent's logic; the owner hears what
// follows it. Owner prose starts with a capital, so no sentence is cut. A tool name is never a code, so one at the
// start of a line stays in for the leak check to find.
const CODE = /^(?!jaw_)[a-z][a-z0-9_-]*: /;

/** What the agent may read out to the owner: the prose less the lines for the agent and the leading codes. */
export const spoken = (r: ToolResult): string =>
  prose(r)
    .filter((l) => !l.startsWith(FOR_AGENT))
    .map((l) => l.replace(CODE, ''))
    .join('\n');

/** The lines for the agent alone, each starting with `For the agent:`. */
export const toAgent = (r: ToolResult): string[] => prose(r).filter((l) => l.startsWith(FOR_AGENT));

/** Words that only make sense inside the server, or raw forms the owner should never read. */
export const INTERNAL: readonly RegExp[] = [
  /\bjaw_[a-z_]+/,
  /eip155:/,
  /x402/i,
  /\bfloat\b/i,
  /paymaster/i,
  /\bproxy\b/i,
  /idempotency/i,
  /calldata/i,
  /entrypoint/i,
  /\buserOp\b/i,
  /permit2/i,
  /\bsession keys?\b/i,
  // The wallet's words are spend limit and permission.
  /\bbudgets?\b/i,
  /\bgrants?\b/i,
  // Amounts as people read them, networks by name, dates without a clock.
  /\bbase units\b/i,
  /\bwei\b/,
  /\bchain \d+/i,
  /\d{4}-\d{2}-\d{2}T/,
];

/** The internal words `text` uses, as their patterns; empty when the owner may read all of it. */
export const leaks = (text: string): string[] => INTERNAL.filter((w) => w.test(text)).map(String);
