// @vitest-environment jsdom
// The start screens: a name or an address finds the account, the backend's live read says whether
// it can be recovered, and "Create new passkey" hands on exactly the account the review screen
// showed. The name lookup and the configs read are the network, stubbed here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SIGNATURE_RECOVERY_PROVIDER_ADDRESS, type RecoveryChainConfig } from '@jaw.id/core';
import { getAddress, type Address, type Hex } from 'viem';

const getRecoveryConfig = vi.fn();
vi.mock('@jaw.id/core', async (importActual) => ({
  ...(await importActual<typeof import('@jaw.id/core')>()),
  getRecoveryConfig: (...args: unknown[]) => getRecoveryConfig(...args),
}));
const resolveEnsToAddress = vi.fn();
vi.mock('../../utils/ensResolve', () => ({
  resolveEnsToAddress: (...args: unknown[]) => resolveEnsToAddress(...args),
}));
vi.mock('../ShellDialog', () => ({ ShellDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../hooks/useChainIcons', () => ({ useChainIcons: () => ({}) }));
vi.mock('../../hooks/useReverseIdentity', () => ({
  useReverseIdentity: () => ({ name: null, plainName: null, avatar: null }),
}));

const { RecoveryStartDialog } = await import('./index');

const ACCOUNT: Address = getAddress('0x2fa8a6b6c0e3c1d6c2d3cb4c1f0d0b6b0e61c41d');
const method = (n: number, delay: number) => ({
  recoveryId: `0x${String(n).repeat(64)}` as Hex,
  provider: SIGNATURE_RECOVERY_PROVIDER_ADDRESS,
  commitment: `0x${'00'.repeat(12)}${String(n).repeat(40)}` as Hex,
  delay,
});
const config = (chainId: number, overrides: Partial<RecoveryChainConfig> = {}): RecoveryChainConfig => ({
  chainId,
  deployed: true,
  enrolled: true,
  threshold: 2,
  recoveries: [method(1, 172_800), method(2, 172_800), method(3, 259_200)],
  ...overrides,
});
/** Recovery on Base and Ethereum, not on Optimism (never set up there). */
const RECOVERY_ON = { chains: [config(8453), config(1), config(10, { enrolled: false, recoveries: [] })] };
const RECOVERY_OFF = { chains: [config(8453, { recoveries: [], threshold: 0 }), config(1, { deployed: false })] };

let container: HTMLDivElement;
let root: Root;
const onStart = vi.fn();

async function open(props: { account?: Address } = {}) {
  await act(async () =>
    root.render(
      <RecoveryStartDialog
        open
        onOpenChange={() => undefined}
        account={props.account}
        approveUrl="https://keys.jaw.id/recover/approve"
        apiKey="test-key"
        mainnetRpcUrl="https://rpc"
        onStart={onStart}
        isStarting={false}
        onClose={() => undefined}
        onDone={() => undefined}
        onOpenAccount={() => undefined}
      />
    )
  );
}

/** Type into the account field and let the lookup run. */
async function type(value: string) {
  const input = container.querySelector('input') as HTMLInputElement;
  // React tracks the value it last set, so the native setter is what makes it see a change.
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onStart.mockReset();
  getRecoveryConfig.mockReset();
  getRecoveryConfig.mockResolvedValue(RECOVERY_ON);
  resolveEnsToAddress.mockReset();
  resolveEnsToAddress.mockResolvedValue(ACCOUNT.toLowerCase());
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('finding the account to recover', () => {
  it('resolves a name on mainnet, reads its recovery and marks it on', async () => {
    await open();
    await type('Angelo.Justan.id');

    expect(resolveEnsToAddress).toHaveBeenCalledWith('angelo.justan.id', 1, 'https://rpc');
    expect(getRecoveryConfig).toHaveBeenCalledWith(ACCOUNT, 'test-key');
    expect(container.textContent).toContain('angelo.justan.id');
    expect(container.textContent).toContain('Recovery on');
    expect(button('Continue')?.disabled).toBe(false);
  });

  it('takes an address as it is, with no name lookup', async () => {
    await open();
    await type(ACCOUNT.toLowerCase());

    expect(resolveEnsToAddress).not.toHaveBeenCalled();
    expect(getRecoveryConfig).toHaveBeenCalledWith(ACCOUNT, 'test-key');
    expect(button('Continue')?.disabled).toBe(false);
  });

  it('says so and keeps Continue disabled when recovery is not set up for the account', async () => {
    getRecoveryConfig.mockResolvedValue(RECOVERY_OFF);
    await open();
    await type('angelo.justan.id');

    expect(container.textContent).toContain('Recovery isn’t set up for this account');
    expect(container.textContent).not.toContain('Recovery on');
    expect(button('Continue')?.disabled).toBe(true);
  });

  it('says when a name points nowhere', async () => {
    resolveEnsToAddress.mockRejectedValue(new Error('No address found for chain 1 on ENS name nobody.eth'));
    await open();
    await type('nobody.eth');

    expect(container.textContent).toContain('No account found for this name.');
    expect(getRecoveryConfig).not.toHaveBeenCalled();
    expect(button('Continue')?.disabled).toBe(true);
  });
});

describe('creating the new passkey', () => {
  it('shows the guardians, the wait and the networks from the lowest network with recovery on', async () => {
    await open({ account: ACCOUNT });

    const text = container.textContent ?? '';
    expect(text).toContain('New key, same account.');
    expect(text).toContain('3 · any 2 approve');
    expect(text).toContain('48h after they approve');
    expect(text).toContain('Ethereum');
    expect(text).toContain('Base');
    expect(text).not.toContain('OP Mainnet');
  });

  it('starts with the account the review shows and the name it was found by', async () => {
    await open();
    await type('angelo.justan.id');
    await act(async () => button('Continue')?.click());
    await act(async () => button('Create new passkey')?.click());

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(ACCOUNT, 'angelo.justan.id');
  });

  it('names the passkey after the short address when the account has no name', async () => {
    await open({ account: ACCOUNT });
    await act(async () => button('Create new passkey')?.click());

    const [account, username] = onStart.mock.calls[0];
    expect(account).toBe(ACCOUNT);
    expect(username).toBe('0x2FA8...C41d');
  });

  it('cannot start when recovery is not set up for the account', async () => {
    getRecoveryConfig.mockResolvedValue(RECOVERY_OFF);
    await open({ account: ACCOUNT });

    expect(container.textContent).toContain('Recovery isn’t set up for this account');
    expect(button('Create new passkey')?.disabled).toBe(true);
    await act(async () => button('Create new passkey')?.click());
    expect(onStart).not.toHaveBeenCalled();
  });
});
