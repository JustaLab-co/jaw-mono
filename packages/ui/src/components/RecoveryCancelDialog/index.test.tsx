// @vitest-environment jsdom
// The owner's veto screen: the request someone opened, the networks a cancel reaches, the one
// destructive button, and the outcome per network. Before enough guardians approve, nothing is on
// any network to cancel, and the screen says so instead of offering a cancel that core refuses.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  type Ceremony,
  type CeremonyChain,
  type RecoverySetupResult,
} from '@jaw.id/core';
import type { Address, Hex } from 'viem';

const getAdminBatch = vi.fn();
vi.mock('@jaw.id/core', async (importActual) => ({
  ...(await importActual<typeof import('@jaw.id/core')>()),
  getAdminBatch: (...args: unknown[]) => getAdminBatch(...args),
}));
vi.mock('../../hooks/useReverseIdentity', () => ({
  useReverseIdentity: (address?: string) => ({
    name: address?.toLowerCase() === ACCOUNT.toLowerCase() ? 'angelo.justan.id' : null,
    plainName: null,
    avatar: null,
  }),
}));
vi.mock('../../hooks/useChainIcons', () => ({ useChainIcons: () => ({}) }));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const { RecoveryCancelDialog } = await import('./index');

const HOUR = 3_600_000;
const ACCOUNT: Address = '0x2FA8A6b6C0E3c1d6C2D3cB4C1f0d0B6b0e61C41d';
const NEW_KEY = `0x04a1${'00'.repeat(60)}77c2` as Hex;

const chain = (chainId: number, status: CeremonyChain['status'], executeAt: string | null = null): CeremonyChain => ({
  chainId,
  status,
  executeAt,
  requestTxHash: null,
  executeTxHash: null,
});

function ceremony(overrides: Partial<Ceremony> = {}): Ceremony {
  return {
    requestId: `0x${'7f'.repeat(32)}`,
    account: ACCOUNT,
    subject: NEW_KEY,
    salt: `0x${'01'.repeat(32)}`,
    expiry: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
    createdAt: new Date().toISOString(),
    threshold: 2,
    collected: 2,
    guardians: [1, 2].map((n) => ({
      recoveryId: `0x${String(n).repeat(64)}` as Hex,
      provider: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
      commitment: `0x${String(n).repeat(64)}` as Hex,
      delay: 172_800,
      approvedAt: new Date().toISOString(),
    })),
    chains: [chain(8453, 'REQUESTED', new Date(Date.now() + 47 * HOUR).toISOString()), chain(1, 'PENDING')],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const callbacks = { onConfirm: vi.fn(), onCancel: vi.fn(), onDone: vi.fn() };

async function show(props: { ceremony?: Ceremony; result?: RecoverySetupResult; error?: string } = {}) {
  await act(async () =>
    root.render(
      <RecoveryCancelDialog
        open
        onOpenChange={() => undefined}
        origin="https://playground.jaw.id"
        appName="JAW Playground"
        mainnetRpcUrl="https://rpc"
        ceremony={props.ceremony ?? ceremony()}
        onConfirm={callbacks.onConfirm}
        isCancelling={false}
        result={props.result}
        error={props.error}
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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('reviewing the request', () => {
  it('shows when it was requested, the new passkey, the approvals and when it could finish', async () => {
    const text = await show();

    expect(text).toContain('Cancel this recovery?');
    expect(text).toContain('Someone asked to add a new passkey to angelo.justan.id.');
    expect(text).toContain('RequestedToday,');
    expect(text).toContain('0x04a1...77c2');
    expect(text).toContain('Approvals2 of 2');
    expect(text).toContain('Could finish');
  });

  it('lists the networks where the request waits, with the fees paid by JAW', async () => {
    const text = await show();

    expect(text).toContain('Base');
    expect(text).toContain('Ethereum');
    expect(text).toContain('Included');
    expect(text).toContain('Paid by JAW');
  });

  it('cancels on Cancel recovery, and Not now declines', async () => {
    await show();

    await act(async () => button('Cancel recovery')?.click());
    expect(callbacks.onConfirm).toHaveBeenCalledTimes(1);

    await act(async () => button('Not now')?.click());
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
  });

  it('has nothing to cancel while the guardians are still approving, and says what to do', async () => {
    const text = await show({
      ceremony: ceremony({ collected: 1, chains: [chain(8453, 'COLLECTING'), chain(1, 'COLLECTING')] }),
    });

    expect(text).toContain('Approvals1 of 2');
    expect(text).toContain('48h after the next approval');
    expect(text).toContain('Nothing to cancel yet');
    expect(text).toContain('tell your guardians not to approve it');
    expect(text).not.toContain('Paid by JAW');
    expect(button('Cancel recovery')?.disabled).toBe(true);
  });

  it('has nothing to cancel once the request ended', async () => {
    const text = await show({ ceremony: ceremony({ chains: [chain(8453, 'EXECUTED')] }) });

    expect(text).toContain('Nothing to cancel');
    expect(text).toContain('The recovery already went through.');
    expect(button('Cancel recovery')?.disabled).toBe(true);
  });
});

describe('after cancelling', () => {
  const result: RecoverySetupResult = {
    door: 'relay',
    batchId: `0x${'cd'.repeat(32)}`,
    chains: [
      { chainId: 8453, status: 'COMPLETED', txHash: null },
      { chainId: 1, status: 'PENDING', txHash: null },
    ],
  };

  it('shows each network’s outcome: cancelled where it landed, updating where it is on its way', async () => {
    const text = await show({ result });

    expect(text).toContain('Recovery cancelled');
    expect(text).toContain('BaseCancelled');
    expect(text).toContain('EthereumUpdating…');
    expect(text).toContain('That new passkey can’t be added now.');
  });

  it('ends on Done with the latest statuses', async () => {
    await show({ result });
    await act(async () => button('Done')?.click());

    expect(callbacks.onDone).toHaveBeenCalledWith(result);
  });

  it('says so when a network didn’t go through', async () => {
    const text = await show({
      result: { ...result, chains: [{ chainId: 8453, status: 'DEAD', txHash: null }] },
    });

    expect(text).toContain('Didn’t go through');
    expect(text).toContain('It didn’t go through on every network.');
  });
});
