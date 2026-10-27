import { describe, it, expect, beforeEach, vi } from 'vitest';
import { decodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import type { SessionConfig } from '../session/session-config.js';
import type { SessionHost } from '../ports.js';
import { PERMIT2_ADDRESS } from './permit2.js';

// The guards a session must clear before the key signs anything, driven through
// the port alone so they hold for any host, not just the CLI's files.

const sendCalls = vi.fn();
let derivedAddress = '0x5e55105e55105e55105e55105e55105e55105e55';

vi.mock('@jaw.id/core', () => ({
  Account: {
    fromLocalAccount: vi.fn(async () => ({ address: derivedAddress, sendCalls, getCallStatus: vi.fn() })),
  },
}));
// A network read on every first session; nothing here is about the fee token.
vi.mock('./fee-token.js', () => ({ whyFeeTokenDisagrees: vi.fn(async () => null) }));

const { SessionBridge } = await import('./session-bridge.js');
const { Account } = await import('@jaw.id/core');
const { whyFeeTokenDisagrees } = await import('./fee-token.js');

const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SESSION_ADDRESS = derivedAddress;

const session = (over: Partial<SessionConfig> = {}): SessionConfig => ({
  ownerAddress: '0x1111111111111111111111111111111111111111',
  sessionAddress: SESSION_ADDRESS,
  permissionId: '0xperm',
  chainId: 84532,
  expiry: Math.floor(Date.now() / 1000) + 86400,
  createdAt: new Date().toISOString(),
  mode: 'eip7702',
  ...over,
});

const host = (over: Partial<SessionHost> = {}, config: SessionConfig = session()): SessionHost => ({
  loadSession: () => config,
  loadSessionKey: () => '0x' + 'ab'.repeat(32),
  configuredPaymaster: () => undefined,
  freshApiKey: async () => undefined,
  ...over,
});

const bridge = (h: SessionHost = host(), apiKey = 'key') =>
  new SessionBridge({ apiKey, chainId: 84532, host: h, logger: { warn: vi.fn() } });
const send = (b: InstanceType<typeof SessionBridge>) => b.request('wallet_sendCalls', [{ calls: [] }]);

beforeEach(() => {
  vi.clearAllMocks();
  derivedAddress = SESSION_ADDRESS;
  sendCalls.mockResolvedValue({ id: '0xbatch', chainId: 84532 });
});

describe('SessionBridge guards', () => {
  it('sends under the session permission when every guard holds', async () => {
    await send(bridge());

    expect(sendCalls).toHaveBeenCalledWith([], { permissionId: '0xperm', onSigned: expect.any(Function) });
  });

  it('refuses an expired session before deriving the key', async () => {
    const b = bridge(host({}, session({ expiry: Math.floor(Date.now() / 1000) - 1 })));

    await expect(send(b)).rejects.toThrow(/Session expired on/);
    expect(Account.fromLocalAccount).not.toHaveBeenCalled();
  });

  it('refuses a session whose expiry cannot be read', async () => {
    const b = bridge(host({}, session({ expiry: null })));

    await expect(send(b)).rejects.toThrow(/does not say when it ends/);
    expect(sendCalls).not.toHaveBeenCalled();
  });

  it('refuses a session an older CLI made, which used a separate address', async () => {
    const b = bridge(host({}, session({ mode: 'counterfactual' })));

    await expect(send(b)).rejects.toThrow(/older CLI/);
    expect(sendCalls).not.toHaveBeenCalled();
  });

  it('refuses a session made for another chain', async () => {
    const b = bridge(host({}, session({ chainId: 8453 })));

    await expect(send(b)).rejects.toThrow(/created for chain 8453/);
  });

  it('refuses when the key derives an account the permission was not granted to', async () => {
    derivedAddress = '0x2222222222222222222222222222222222222222';

    await expect(send(bridge())).rejects.toThrow(/out of sync/);
    expect(sendCalls).not.toHaveBeenCalled();
  });

  it('checks the expiry again on a session it already derived', async () => {
    const config = session();
    const b = bridge(host({}, config));
    await send(b);
    config.expiry = Math.floor(Date.now() / 1000) - 1;

    await expect(send(b)).rejects.toThrow(/Session expired on/);
    expect(sendCalls).toHaveBeenCalledTimes(1);
  });
});

describe('SessionBridge.approvePermit2', () => {
  it('approves Permit2 for the maximum on the registry USDC, outside the permission', async () => {
    await bridge().approvePermit2(USDC_BASE_SEPOLIA);

    const [[calls, options]] = sendCalls.mock.calls;
    expect(options).not.toHaveProperty('permissionId');
    expect(calls[0].to).toBe(USDC_BASE_SEPOLIA);
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
    expect(functionName).toBe('approve');
    expect(args).toEqual([PERMIT2_ADDRESS, maxUint256]);
  });

  it('refuses any other token', async () => {
    await expect(bridge().approvePermit2('0x3333333333333333333333333333333333333333')).rejects.toThrow(
      /only the registry USDC/
    );
    expect(sendCalls).not.toHaveBeenCalled();
  });
});

describe('SessionBridge and the host', () => {
  it('takes a paymaster the host configured for this chain', async () => {
    const h = host({ configuredPaymaster: () => ({ url: 'https://paymaster.example', context: { x: 1 } }) });
    await send(bridge(h));

    expect(Account.fromLocalAccount).toHaveBeenCalledWith(
      expect.objectContaining({ paymasterUrl: 'https://paymaster.example', paymasterContext: { x: 1 } }),
      expect.anything(),
      { eip7702: true }
    );
  });

  it('pays the fee in the registry USDC when no token is named', async () => {
    await send(bridge());

    expect(Account.fromLocalAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        paymasterUrl: expect.stringContaining('erc20-paymaster'),
        paymasterContext: { token: USDC_BASE_SEPOLIA },
      }),
      expect.anything(),
      { eip7702: true }
    );
  });

  it('pays the fee in the token it is given, through the same paymaster', async () => {
    const token = '0x4200000000000000000000000000000000000006';
    await send(
      new SessionBridge({
        apiKey: 'key',
        chainId: 84532,
        host: host(),
        logger: { warn: vi.fn() },
        paymasterContext: { token },
      })
    );

    expect(Account.fromLocalAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        paymasterUrl: expect.stringContaining('erc20-paymaster'),
        paymasterContext: { token },
      }),
      expect.anything(),
      { eip7702: true }
    );
  });

  // A session prefunded in the native coin pays its gas from its own balance, as any account
  // with no paymaster does.
  it('given a native fee, then it sends with no paymaster, whatever else is set', async () => {
    const h = host({ configuredPaymaster: () => ({ url: 'https://paymaster.example' }) });
    await send(
      new SessionBridge({
        apiKey: 'key',
        chainId: 84532,
        host: h,
        logger: { warn: vi.fn() },
        paymasterContext: { token: USDC_BASE_SEPOLIA },
        nativeFee: true,
      })
    );

    expect(Account.fromLocalAccount).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'key', paymasterUrl: undefined, paymasterContext: undefined }),
      expect.anything(),
      { eip7702: true }
    );
    expect(whyFeeTokenDisagrees).not.toHaveBeenCalled();
  });

  it('given a native fee, when the key is refused, then the retry still sends with no paymaster', async () => {
    sendCalls.mockRejectedValueOnce(new Error('refused'));

    await send(
      new SessionBridge({
        apiKey: 'old-key',
        chainId: 84532,
        host: host({ freshApiKey: async () => 'new-key' }),
        logger: { warn: vi.fn() },
        nativeFee: true,
      })
    );

    expect(Account.fromLocalAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: 'new-key', paymasterUrl: undefined }),
      expect.anything(),
      expect.anything()
    );
  });

  it('retries once under the key the host offers for the one that was refused', async () => {
    const refused = new Error('refused');
    sendCalls.mockRejectedValueOnce(refused);
    const freshApiKey = vi.fn(async () => 'new-key');

    await send(bridge(host({ freshApiKey }), 'old-key'));

    expect(freshApiKey).toHaveBeenCalledWith(refused, 'old-key');
    expect(sendCalls).toHaveBeenCalledTimes(2);
    expect(Account.fromLocalAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: 'new-key' }),
      expect.anything(),
      expect.anything()
    );
  });

  it('surfaces the refusal when the host has no other key, or the same one', async () => {
    for (const offer of [undefined, 'old-key']) {
      sendCalls.mockReset().mockRejectedValue(new Error('refused'));

      await expect(send(bridge(host({ freshApiKey: async () => offer }), 'old-key'))).rejects.toThrow('refused');
      expect(sendCalls).toHaveBeenCalledTimes(1);
    }
  });
});

describe('SessionBridge and the userOp hash', () => {
  const HASH = `0x${'7'.repeat(64)}`;
  const signThen = (outcome: () => Promise<unknown>) =>
    sendCalls.mockImplementationOnce(async (_calls, options: { onSigned: (h: string) => Promise<void> }) => {
      await options.onSigned(HASH);
      return outcome();
    });

  it('given a caller waiting for the hash, when it sends, then it gets the hash before the send returns', async () => {
    const seen: string[] = [];
    signThen(async () => {
      seen.push('sent');
      return { id: HASH, chainId: 84532 };
    });

    const sent = await bridge().request(
      'wallet_sendCalls',
      [{ calls: [{ to: USDC_BASE_SEPOLIA, data: '0x' }] }],
      async (h) => {
        seen.push(h);
      }
    );

    expect(seen).toEqual([HASH, 'sent']);
    expect(sent).toEqual({ id: HASH, chainId: 84532 });
    expect(sendCalls).toHaveBeenCalledWith(
      [{ to: USDC_BASE_SEPOLIA, data: '0x' }],
      expect.objectContaining({ permissionId: '0xperm' })
    );
  });

  it('given a send that failed after the userOp was signed, when the host offers a fresh key, then it surfaces the failure and signs no second userOp', async () => {
    const lost = new Error('the answer was lost');
    signThen(async () => {
      throw lost;
    });
    const freshApiKey = vi.fn(async () => 'new-key');

    await expect(send(bridge(host({ freshApiKey }), 'old-key'))).rejects.toBe(lost);
    expect(sendCalls).toHaveBeenCalledTimes(1);
  });

  it('given a caller waiting for the hash, when it approves Permit2, then it gets the hash before the send returns', async () => {
    signThen(async () => ({ id: HASH, chainId: 84532 }));
    const seen: string[] = [];

    await bridge().approvePermit2(USDC_BASE_SEPOLIA, async (h) => {
      seen.push(h);
    });

    expect(seen).toEqual([HASH]);
  });

  it('given a Permit2 approval that failed after it was signed, then it is not sent again under a fresh key', async () => {
    signThen(async () => {
      throw new Error('the answer was lost');
    });

    await expect(
      bridge(host({ freshApiKey: async () => 'new-key' }), 'old-key').approvePermit2(USDC_BASE_SEPOLIA)
    ).rejects.toThrow('the answer was lost');
    expect(sendCalls).toHaveBeenCalledTimes(1);
  });

  it('given the caller fails to keep the hash, when the host offers a fresh key, then it may run again, since nothing went out', async () => {
    sendCalls.mockImplementationOnce(async (_calls, options: { onSigned: (h: string) => Promise<void> }) => {
      await options.onSigned(HASH);
      return { id: HASH, chainId: 84532 };
    });
    let keep = 0;

    await bridge(host({ freshApiKey: async () => 'new-key' }), 'old-key').request(
      'wallet_sendCalls',
      [{ calls: [] }],
      async () => {
        if (keep++ === 0) throw new Error('could not record the hash');
      }
    );

    expect(sendCalls).toHaveBeenCalledTimes(2);
  });

  it('given the caller fails to keep the hash, then the send fails with that error', async () => {
    signThen(async () => ({ id: HASH, chainId: 84532 }));

    await expect(
      bridge().request('wallet_sendCalls', [{ calls: [] }], async () => {
        throw new Error('could not record the hash');
      })
    ).rejects.toThrow('could not record the hash');
  });
});

describe('SessionBridge fee failure advice', () => {
  const WETH = '0x4200000000000000000000000000000000000006';
  const unsized = new Error('Could not size the ERC-20 paymaster approval for token x on chain 84532: boom');
  const withContext = (paymasterContext?: Record<string, unknown>) =>
    new SessionBridge({ apiKey: 'key', chainId: 84532, host: host(), logger: { warn: vi.fn() }, paymasterContext });

  it('given the fee is paid in USDC, then it says to send USDC', async () => {
    sendCalls.mockRejectedValue(unsized);
    await expect(send(withContext())).rejects.toThrow(/holds no USDC.*Send it 0\.1 USDC/s);
  });

  it('given the fee is paid in another token, then it names that token and not USDC', async () => {
    sendCalls.mockRejectedValue(unsized);
    const err = await send(withContext({ token: WETH })).catch((e: Error) => e);
    expect(err.message).toContain(`holds none of the fee token ${WETH}`);
    expect(err.message).not.toContain('0.1 USDC');
  });

  it('given the context names the registry USDC, then it still says USDC', async () => {
    sendCalls.mockRejectedValue(unsized);
    await expect(send(withContext({ token: USDC_BASE_SEPOLIA }))).rejects.toThrow(/Send it 0\.1 USDC/);
  });
});
