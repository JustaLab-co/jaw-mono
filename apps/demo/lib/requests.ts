import { getJaw } from './jaw';
import { ARB_SEPOLIA_HEX, EURE_ADDRESS } from './eure';

type JawProvider = NonNullable<ReturnType<typeof getJaw>>['provider'];

// Monerium EURe on Arbitrum Sepolia (18 decimals).
const EURE = EURE_ADDRESS;

// The two "friends" the splits screen settles up with. The mock UI shows its
// own names/amounts; the real batch just has to be a genuine 2-recipient
// transfer, not match the pixels.
const RECIPIENTS = [
  '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  '0x000000000000000000000000000000000000dEaD',
] as const;

// 1 EURe
const ONE_EURE = 10n ** 18n;

// The demo "agent" the Agens screen delegates to.
const AGENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
// Native ETH sentinel used by the permissions contract.
const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
// 25 EURe / 0.01 ETH (both 18 decimals)
const EURE_DAILY_CAP = `0x${(25n * ONE_EURE).toString(16)}`;
const ETH_MONTHLY_CAP = '0x2386f26fc10000';

/**
 * Agent screen "Delegate to agent": ERC-7715 grant — the agent may spend up to
 * 25 EURe per DAY and 0.01 ETH per MONTH, and the whole permission expires
 * in 30 days. Enforced onchain by the permission manager, revocable anytime.
 */
export function sendAgentGrant(provider: JawProvider) {
  const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  return provider.request({
    method: 'wallet_grantPermissions',
    params: [
      {
        expiry,
        spender: AGENT,
        chainId: ARB_SEPOLIA_HEX,
        permissions: {
          // Allowed call target: the EURe token contract, transfers only.
          calls: [{ target: EURE, selector: '0xa9059cbb' }], // EURe.transfer
          spends: [
            { token: EURE, allowance: EURE_DAILY_CAP, unit: 'day', multiplier: 1 },
            { token: NATIVE_ETH, allowance: ETH_MONTHLY_CAP, unit: 'month', multiplier: 1 },
          ],
        },
      },
    ],
  });
}

// Hand-rolled ERC-20 transfer(address,uint256) calldata — selector a9059cbb —
// so the demo needs no ABI library.
function erc20Transfer(to: string, amount: bigint): `0x${string}` {
  const addr = to.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const amt = amount.toString(16).padStart(64, '0');
  return `0xa9059cbb${addr}${amt}`;
}

/**
 * Post-connect request for a non-sign-in feature, chosen by feature id.
 * Returns null when the feature has no wallet request. Keeping the dispatch
 * here means the page never grows a chain of per-feature branches.
 */
export function featureRequest(provider: JawProvider, featureId: number): Promise<unknown> | null {
  switch (featureId) {
    case 2:
      return sendSplitsBatch(provider);
    case 3:
      return sendAgentGrant(provider);
    default:
      return null;
  }
}

/**
 * Splits "Settle All": one EIP-5792 batch sending 1 EURe to each of two
 * addresses atomically — one signature, two transfers, like settling a bill
 * with two friends at once.
 */
export function sendSplitsBatch(provider: JawProvider) {
  return provider.request({
    method: 'wallet_sendCalls',
    params: [
      {
        version: '2.0.0',
        chainId: ARB_SEPOLIA_HEX,
        atomicRequired: true,
        calls: RECIPIENTS.map((to) => ({
          to: EURE,
          data: erc20Transfer(to, ONE_EURE),
        })),
      },
    ],
  });
}
