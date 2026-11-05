// @vitest-environment jsdom
// The recovering user's status screen: one view over the request, whatever stage it is at, and
// each network with its own status. Names come from the identity cache, stubbed here: what is
// under test is which name a guardian is shown by, not how names are fetched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  deriveAccountRecordV1,
  deriveAccountRecordV2,
  type Ceremony,
  type CeremonyChain,
} from '@jaw.id/core';
import type { Hex } from 'viem';

/** ENS names by lowercased address, as the identity cache would answer them. */
const names: Record<string, string> = {};
vi.mock('../../hooks/useAddressIdentities', () => ({
  useAddressIdentities: (inputs: Array<{ address: string; chainId: number }>) =>
    Object.fromEntries(
      inputs.map(({ address, chainId }) => [
        `${address.toLowerCase()}:${chainId}`,
        { ensName: names[address.toLowerCase()] ?? null, ensAvatar: null },
      ])
    ),
}));
vi.mock('../../hooks/useReverseIdentity', () => ({
  useReverseIdentity: (address?: string) => ({
    name: (address && names[address.toLowerCase()]) ?? null,
    plainName: null,
    avatar: null,
  }),
}));
vi.mock('../../hooks/useChainIcons', () => ({ useChainIcons: () => ({}) }));

const { RecoveryStatus } = await import('./RecoveryStatus');

const HOUR = 3_600_000;
const ACCOUNT = '0x2FA8A6b6C0E3c1d6C2D3cB4C1f0d0B6b0e61C41d';
const REQUEST_ID = `0x${'7f'.repeat(32)}` as Hex;
const APPROVE_URL = 'https://keys.jaw.id/recover/approve';
const WALLET = `0x${'00'.repeat(12)}${'7a'.repeat(20)}` as Hex;
const PASSKEY = `0x${'51'.repeat(64)}` as Hex;
const OTHER_PASSKEY = `0x${'8f'.repeat(64)}` as Hex;

const guardian = (commitment: Hex, approvedAt: string | null, n: number) => ({
  recoveryId: `0x${String(n).repeat(64)}` as Hex,
  provider: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  commitment,
  delay: 172_800,
  approvedAt,
});

const chain = (chainId: number, status: CeremonyChain['status'], executeAt: string | null = null): CeremonyChain => ({
  chainId,
  status,
  executeAt,
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
    guardians: [guardian(WALLET, null, 1), guardian(PASSKEY, null, 2), guardian(OTHER_PASSKEY, null, 3)],
    chains: [chain(8453, 'COLLECTING'), chain(1, 'COLLECTING')],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const callbacks = { onDone: vi.fn(), onStartAgain: vi.fn(), onOpenAccount: vi.fn() };

async function show(
  value: Ceremony | null,
  props: { failed?: boolean; withStartAgain?: boolean; chainId?: number } = {}
) {
  await act(async () =>
    root.render(
      <RecoveryStatus
        ceremony={value}
        failed={props.failed}
        approveUrl={APPROVE_URL}
        mainnetRpcUrl="https://rpc"
        onDone={callbacks.onDone}
        onStartAgain={props.withStartAgain === false ? undefined : callbacks.onStartAgain}
        onOpenAccount={callbacks.onOpenAccount}
        chainId={props.chainId}
      />
    )
  );
  return container.textContent ?? '';
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  for (const key of Object.keys(names)) delete names[key];
  names[ACCOUNT.toLowerCase()] = 'angelo.justan.id';
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('while the guardians are approving', () => {
  it('asks the user to contact them, with each guardian waiting or approved and how many are needed', async () => {
    const text = await show(
      ceremony({
        collected: 1,
        guardians: [
          guardian(WALLET, new Date().toISOString(), 1),
          guardian(PASSKEY, null, 2),
          guardian(OTHER_PASSKEY, null, 3),
        ],
      })
    );

    expect(text).toContain('angelo.justan.id · recovery started');
    expect(text).toContain('Ask your guardians.');
    expect(text).toContain('Any 2 of 3 can approve.');
    expect(text).toContain('Guardians · 1 of 2 approved');
    expect(text.split('Waiting').length - 1).toBe(2);
    expect(text).toContain('That call is the check.');
    expect(text).toContain('Open until');
    expect(text).toContain('30 days');
    expect(button('Done for now')).toBeDefined();
  });

  it('copies the guardians’ link: the approve page with the request id appended', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await show(ceremony());

    await act(async () => button('Copy link')?.click());

    expect(writeText).toHaveBeenCalledWith(`${APPROVE_URL}/${REQUEST_ID}`);
    expect(container.textContent).toContain(`keys.jaw.id/recover/approve/${REQUEST_ID}`);
  });

  it('ends the screen with Done for now', async () => {
    await show(ceremony());
    await act(async () => button('Done for now')?.click());

    expect(callbacks.onDone).toHaveBeenCalledTimes(1);
  });
});

describe('guardian names', () => {
  it('names a wallet guardian by its address’s name', async () => {
    names[`0x${'7a'.repeat(20)}`] = 'ghadi.justan.id';

    expect(await show(ceremony())).toContain('ghadi.justan.id');
  });

  it('names a passkey guardian by the JAW account its key created, v2 before v1', async () => {
    names[deriveAccountRecordV1(PASSKEY).address.toLowerCase()] = 'old.justan.id';
    names[deriveAccountRecordV2(PASSKEY).address.toLowerCase()] = 'leo.justan.id';
    names[deriveAccountRecordV1(OTHER_PASSKEY).address.toLowerCase()] = 'mariano.justan.id';
    const text = await show(ceremony());

    expect(text).toContain('leo.justan.id');
    expect(text).not.toContain('old.justan.id');
    expect(text).toContain('mariano.justan.id');
  });

  it('shows a passkey guardian whose accounts have no name by its short key', async () => {
    expect(await show(ceremony())).toContain('0x5151...5151');
  });
});

describe('during the waiting period', () => {
  it('shows the approvals, the ones not needed, and each network’s time left and own status', async () => {
    const executeAt = new Date(Date.now() + 47 * HOUR + 12.5 * 60_000).toISOString();
    const text = await show(
      ceremony({
        collected: 2,
        guardians: [
          guardian(WALLET, new Date().toISOString(), 1),
          guardian(PASSKEY, new Date().toISOString(), 2),
          guardian(OTHER_PASSKEY, null, 3),
        ],
        chains: [chain(8453, 'REQUESTED', executeAt), chain(1, 'PENDING'), chain(10, 'EXECUTED')],
      })
    );

    expect(text).toContain('angelo.justan.id · recovery in progress');
    expect(text).toContain('Waiting period.');
    expect(text).toContain('Approvals · 2 of 2');
    expect(text).toContain('Not needed');
    expect(text).toContain('47h 12m left');
    expect(text).toContain('Starting…');
    expect(text).toContain('Recovered');
    expect(text).toContain('That’s what the wait is for.');
    expect(button('Done')).toBeDefined();
  });
});

describe('once the recovery executed', () => {
  it('says the new passkey controls the account, lists the networks and warns about unused ones', async () => {
    const text = await show(ceremony({ collected: 2, chains: [chain(8453, 'EXECUTED'), chain(1, 'FAILED')] }));

    expect(text).toContain('You’re back in.');
    expect(text).toContain('Your new passkey now controls angelo.justan.id.');
    expect(text).toContain('Recovered');
    expect(text).toContain('Didn’t go through');
    expect(text).toContain('Works on these networks only');
  });

  it('opens the account when it executed on the network the passkey signs in on', async () => {
    const text = await show(ceremony({ chains: [chain(8453, 'EXECUTED'), chain(1, 'EXECUTED')] }), { chainId: 8453 });

    expect(text).toContain('You’re back in.');
    expect(button('Open my account')).toBeDefined();
  });

  it('names the networks it works on, and offers no way in, when it never executed on the sign-in network', async () => {
    // The account was never used on Optimism before the recovery: no request went there.
    const text = await show(ceremony({ chains: [chain(8453, 'EXECUTED'), chain(1, 'EXECUTED')] }), { chainId: 10 });

    expect(text).toContain('Recovered on other networks.');
    expect(text).toContain('Your new passkey now controls angelo.justan.id on the networks below.');
    expect(text).toContain('It can’t be used on OP Mainnet yet.');
    expect(text).toContain('Base');
    expect(text).toContain('Ethereum');
    expect(text).toContain('Works on these networks only');
    expect(text).not.toContain('You’re back in.');
    expect(button('Open my account')).toBeUndefined();

    await act(async () => button('Done')?.click());
    expect(callbacks.onDone).toHaveBeenCalledTimes(1);
  });

  it('lists only the networks it executed on', async () => {
    const text = await show(ceremony({ chains: [chain(8453, 'EXECUTED'), chain(10, 'FAILED')] }), { chainId: 10 });

    expect(text).toContain('Recovered on other networks.');
    expect(text).not.toContain('Didn’t go through');
  });

  it('opens the account with the new passkey', async () => {
    await show(ceremony({ chains: [chain(8453, 'EXECUTED')] }));
    await act(async () => button('Open my account')?.click());

    expect(callbacks.onOpenAccount).toHaveBeenCalledTimes(1);
  });
});

describe('the endings', () => {
  it.each([
    ['cancelled', 'CANCELLED', 'Recovery cancelled.'],
    ['expired', 'EXPIRED', 'Request expired.'],
    ['failed', 'FAILED', 'Recovery didn’t go through.'],
  ] as const)('a %s request ends plainly, with Start again', async (_, status, title) => {
    const text = await show(ceremony({ chains: [chain(8453, status), chain(1, status)] }));

    expect(text).toContain(title);
    expect(text).toContain('Nothing in the account changed.');
    await act(async () => button('Start again')?.click());
    expect(callbacks.onStartAgain).toHaveBeenCalledTimes(1);
  });

  it('offers Done instead when the host cannot start again', async () => {
    await show(ceremony({ chains: [chain(8453, 'CANCELLED')] }), { withStartAgain: false });

    expect(button('Start again')).toBeUndefined();
    expect(button('Done')).toBeDefined();
  });
});

describe('before the request is read', () => {
  it('waits on a spinner, and says so when the read fails', async () => {
    expect(await show(null)).not.toContain('couldn’t be loaded');
    expect(await show(null, { failed: true })).toContain('This request couldn’t be loaded');
  });
});
