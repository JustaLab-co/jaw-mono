// @vitest-environment jsdom
// Once a request opens Add Funds it stays there until it settles, and it
// settles once. The dialog is stubbed: what is under test is the view the hook
// picks and how many times it rejects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Account } from '@jaw.id/core';

vi.mock('../components/AddFundsDialog', async (importActual) => ({
  ...(await importActual<typeof import('../components/AddFundsDialog')>()),
  AddFundsDialog: (props: {
    address: string;
    chainId: number;
    onDone: () => void;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div>
      <p>
        Receive {props.address} on {props.chainId}
      </p>
      <button onClick={props.onDone}>Done</button>
      <button onClick={() => props.onOpenChange(false)}>X</button>
    </div>
  ),
}));

const { useAddFundsView } = await import('./ReactUIHandler');

const ALICE = '0x00000000000000000000000000000000000A11cE';
const BOB = '0x0000000000000000000000000000000000000B0b';
const CHAIN = 84532;
const ADD_FUNDS_REJECTION = 'Insufficient funds. The user opened Add funds; retry after the deposit.';

const accountOf = (address: string) => ({ address }) as unknown as Account;

function Screen({ account, chainId, onReject }: { account: Account; chainId: number; onReject: () => void }) {
  const submittingRef = useRef(false);
  const { addFundsView, onAddFunds } = useAddFundsView({ account, short: ALICE, chainId, submittingRef, onReject });
  if (addFundsView) return addFundsView;
  return (
    <div>
      <button onClick={onAddFunds}>Add funds</button>
      <button>Confirm</button>
    </div>
  );
}

let root: Root;
const render = (account: Account, chainId: number, onReject: () => void) =>
  act(async () => root.render(<Screen account={account} chainId={chainId} onReject={onReject} />));
const buttonNamed = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const click = (label: string) => act(async () => buttonNamed(label)?.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.body.appendChild(document.createElement('div')));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

describe('the Add Funds view of a request', () => {
  it('Given Add Funds is open, When the account and chain change, Then it stays on the captured ones, unsettled', async () => {
    const onReject = vi.fn();
    await render(accountOf(ALICE), CHAIN, onReject);
    await click('Add funds');

    await render(accountOf(BOB), 8453, onReject);

    expect(document.body.textContent).toContain(`Receive ${ALICE} on ${CHAIN}`);
    expect(buttonNamed('Confirm')).toBeUndefined();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('Given Add Funds is open, When the user leaves with Done, Done and X, Then it rejects once', async () => {
    const onReject = vi.fn();
    await render(accountOf(ALICE), CHAIN, onReject);
    await click('Add funds');

    await click('Done');
    await click('Done');
    await click('X');

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0][0]).toMatchObject({ code: 4001, message: ADD_FUNDS_REJECTION });
  });
});
