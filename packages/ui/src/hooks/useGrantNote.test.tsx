// @vitest-environment jsdom
// Next runs effects twice in development (Strict Mode). A refusal answers the dapp, so it must
// reach the host once however often the effect runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useGrantNote } from './useGrantNote';

let root: Root;
let container: HTMLDivElement;
let shown: ReturnType<typeof useGrantNote> = {};

function Screen({ note, onRefuse }: { note: unknown; onRefuse: (reason: string) => void }) {
  shown = useGrantNote(note, onRefuse);
  return null;
}

async function render(note: unknown, onRefuse: (reason: string) => void) {
  await act(async () => {
    root.render(
      <StrictMode>
        <Screen note={note} onRefuse={onRefuse} />
      </StrictMode>
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  shown = {};
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useGrantNote', () => {
  it('refuses a note that breaks the rule once, even when effects run twice', async () => {
    const onRefuse = vi.fn();

    await render('Daily \u202EDCA', onRefuse);
    // A host re-rendering with a new callback must not refuse again either.
    await render('Daily \u202EDCA', () => onRefuse());

    expect(onRefuse).toHaveBeenCalledTimes(1);
    expect(shown.note).toBeUndefined();
    expect(shown.refusal).toContain('note');
  });

  it('hands back the trimmed note and refuses nothing for a good one', async () => {
    const onRefuse = vi.fn();

    await render('  Daily DCA into ETH  ', onRefuse);

    expect(shown).toEqual({ note: 'Daily DCA into ETH' });
    expect(onRefuse).not.toHaveBeenCalled();
  });
});
