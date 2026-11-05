// @vitest-environment jsdom
// The guardian's approve screen inside an app: what the request shows, the two confirmations that
// turn Approve on, the count once approved, and the states where this guardian can't approve.
// Names come from the identity cache, stubbed here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  type Ceremony,
  type CeremonyApproval,
  type CeremonyChain,
  type CeremonyListEntry,
} from '@jaw.id/core';
import type { Address, Hex } from 'viem';
import type { GuardianApprovalBlock } from '../../utils/recoveryRequest';

/** ENS names by lowercased address, as the identity cache would answer them. */
const names: Record<string, string> = {};
vi.mock('../../hooks/useReverseIdentity', () => ({
  useReverseIdentity: (address?: string) => ({
    name: (address && names[address.toLowerCase()]) ?? null,
    plainName: null,
    avatar: null,
  }),
}));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const { GuardianApproveDialog } = await import('./index');

const HOUR = 3_600_000;
const ACCOUNT: Address = '0x2FA8A6b6C0E3c1d6C2D3cB4C1f0d0B6b0e61C41d';
const GUARDIAN: Address = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';
const REQUEST_ID = `0x${'7f'.repeat(32)}` as Hex;

const chain = (chainId: number, status: CeremonyChain['status']): CeremonyChain => ({
  chainId,
  status,
  executeAt: null,
  requestTxHash: null,
  executeTxHash: null,
});

function ceremony(overrides: Partial<Ceremony> = {}): Ceremony {
  return {
    requestId: REQUEST_ID,
    account: ACCOUNT,
    subject: `0x${'ab'.repeat(64)}`,
    salt: `0x${'01'.repeat(32)}`,
    expiry: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
    createdAt: new Date().toISOString(),
    threshold: 2,
    collected: 0,
    guardians: [1, 2, 3].map((n) => ({
      recoveryId: `0x${String(n).repeat(64)}` as Hex,
      provider: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
      commitment: `0x${'51'.repeat(64)}` as Hex,
      delay: 172_800,
      approvedAt: null,
    })),
    chains: [chain(8453, 'COLLECTING'), chain(1, 'COLLECTING')],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const callbacks = { onApprove: vi.fn(), onCancel: vi.fn(), onDone: vi.fn() };

async function show(
  props: {
    ceremony?: Ceremony | null;
    block?: GuardianApprovalBlock | null;
    approval?: CeremonyApproval | null;
    openRequests?: CeremonyListEntry[];
  } = {}
) {
  await act(async () =>
    root.render(
      <GuardianApproveDialog
        open
        onOpenChange={() => undefined}
        origin="https://playground.jaw.id"
        appName="JAW Playground"
        mainnetRpcUrl="https://rpc"
        ceremony={props.ceremony === undefined ? ceremony() : props.ceremony}
        openRequests={props.openRequests}
        guardian={GUARDIAN}
        block={props.block}
        onApprove={callbacks.onApprove}
        isApproving={false}
        approval={props.approval}
        onCancel={callbacks.onCancel}
        onDone={callbacks.onDone}
      />
    )
  );
  return container.textContent ?? '';
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined;
const checkboxes = () => [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  for (const key of Object.keys(names)) delete names[key];
  names[ACCOUNT.toLowerCase()] = 'angelo.justan.id';
  names[GUARDIAN.toLowerCase()] = 'ghadi.justan.id';
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('reviewing the request', () => {
  it('shows the account, when its new passkey was made, the wait and who is approving', async () => {
    const text = await show();

    expect(text).toContain('Approve angelo.justan.id’s new passkey');
    expect(text).toContain('angelo.justan.id lost their passkey and made a new one.');
    expect(text).toContain('Made today,');
    expect(text).toContain('48h before it works');
    expect(text).toContain('Approving as');
    expect(text).toContain('ghadi.justan.id');
    expect(text).toContain('This app can’t vouch for the request');
    expect(text).toContain('Contact them yourself before you approve.');
  });

  it('turns Approve on only once both confirmations are ticked', async () => {
    await show();
    const [contacted, calm] = checkboxes();
    expect(button('Approve')?.disabled).toBe(true);

    await act(async () => contacted.click());
    expect(button('Approve')?.disabled).toBe(true);

    await act(async () => calm.click());
    expect(button('Approve')?.disabled).toBe(false);

    await act(async () => contacted.click());
    expect(button('Approve')?.disabled).toBe(true);
  });

  it('approves on Approve, and Cancel declines', async () => {
    await show();
    for (const box of checkboxes()) await act(async () => box.click());

    await act(async () => button('Approve')?.click());
    expect(callbacks.onApprove).toHaveBeenCalledTimes(1);

    await act(async () => button('Cancel')?.click());
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
  });

  it('says how many requests are open for the account and when each was opened', async () => {
    const opened = (requestId: Hex, createdAt: string) => ({ requestId, createdAt }) as unknown as CeremonyListEntry;
    const yesterday = new Date(Date.now() - 24 * HOUR).toISOString();
    const text = await show({
      openRequests: [opened(REQUEST_ID, new Date().toISOString()), opened(`0x${'11'.repeat(32)}`, yesterday)],
    });

    expect(text).toContain('2 recovery requests are open for this account');
    expect(text).toContain('This one: opened today,');
    expect(text).toContain('Another: opened yesterday,');
    expect(text).toContain('Ask angelo.justan.id when they started theirs');
  });

  it('says nothing about other requests when this is the only one', async () => {
    const text = await show({
      openRequests: [{ requestId: REQUEST_ID, createdAt: new Date().toISOString() } as unknown as CeremonyListEntry],
    });

    expect(text).not.toContain('requests are open');
  });
});

describe('when this guardian can’t approve', () => {
  it('says the account isn’t a guardian and offers only Close', async () => {
    const text = await show({ block: 'not-guardian' });

    expect(text).toContain('This account isn’t a guardian for this request');
    expect(checkboxes()).toHaveLength(0);
    expect(button('Approve')).toBeUndefined();
    await act(async () => button('Close')?.click());
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['waiting out its delay', [chain(8453, 'REQUESTED')], 'Enough guardians already approved it.'],
    ['recovered', [chain(8453, 'EXECUTED')], 'The recovery already went through.'],
    ['cancelled', [chain(8453, 'CANCELLED')], 'An owner of this account cancelled the request.'],
    ['expired', [chain(8453, 'EXPIRED')], 'It closed before it could finish.'],
  ] as const)('says a request %s no longer takes approvals', async (_, chains, detail) => {
    const text = await show({ ceremony: ceremony({ chains: [...chains] }), block: 'closed' });

    expect(text).toContain('This request can’t be approved any more');
    expect(text).toContain(detail);
    expect(button('Approve')).toBeUndefined();
    expect(button('Close')).toBeDefined();
  });

  it('waits on a spinner until the request is read, with Approve off', async () => {
    const text = await show({ ceremony: null });

    expect(text).not.toContain('Approve angelo');
    expect(button('Approve')?.disabled).toBe(true);
  });
});

describe('once approved', () => {
  it('shows who approved and the count, then Done', async () => {
    const text = await show({ approval: { collected: 1, threshold: 2, queued: false } });

    expect(text).toContain('You approved.');
    expect(text).toContain('Your approval counts on every network.');
    expect(text).toContain('Approved as');
    expect(text).toContain('ghadi.justan.id');
    expect(text).toContain('1 of 2');
    expect(text).toContain('Once 2 guardians approve, the request goes on every network and waits 48h.');
    expect(text).toContain('angelo.justan.id can cancel it at any time until then.');

    await act(async () => button('Done')?.click());
    expect(callbacks.onDone).toHaveBeenCalledTimes(1);
  });

  it('says the wait starts when this approval was the last one needed', async () => {
    const text = await show({ approval: { collected: 2, threshold: 2, queued: true } });

    expect(text).toContain('2 of 2');
    expect(text).toContain('Enough guardians approved, so the request goes on every network and waits 48h.');
  });
});
