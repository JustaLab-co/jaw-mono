import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DialogAppHeader } from './index';

describe('DialogAppHeader originLabel', () => {
  it('shows the label instead of the host', () => {
    const html = renderToStaticMarkup(
      <DialogAppHeader appName="Claude" origin="https://keys.jaw.id" originLabel="via JAW bridge" />
    );
    expect(html).toContain('via JAW bridge');
    expect(html).not.toContain('keys.jaw.id');
  });

  it('shows the host when there is no label', () => {
    const html = renderToStaticMarkup(<DialogAppHeader appName="Claude" origin="https://www.dapp.xyz" />);
    expect(html).toContain('dapp.xyz');
  });
});
