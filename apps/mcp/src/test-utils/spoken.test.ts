import { describe, expect, it } from 'vitest';
import { leaks, spoken, toAgent, type ToolResult } from './spoken';

const said = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

describe('spoken', () => {
  it('given a refusal led by its code, then the owner hears what follows the code', () => {
    expect(spoken(said('account_busy: The wallet is busy.'))).toBe('The wallet is busy.');
  });

  it('given a line led by a tool name, then the name is not taken for a code and the leak check finds it', () => {
    const r = said('jaw_send_calls: hello');

    expect(spoken(r)).toBe('jaw_send_calls: hello');
    expect(leaks(spoken(r))).not.toEqual([]);
  });

  it('given a line for the agent, then it is kept from the owner and listed for the agent', () => {
    const r = said('Done.\nFor the agent: Call jaw_get_assets.');

    expect(spoken(r)).toBe('Done.');
    expect(toAgent(r)).toEqual(['For the agent: Call jaw_get_assets.']);
  });
});
