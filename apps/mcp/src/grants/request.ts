import { randomBytes } from 'node:crypto';
import { openRequest, usdcForNetwork, type ApprovalId, type ApprovalRequest } from '@jaw.id/agent';
import { parseUnits, type Address } from 'viem';
import { CONNECTION_TTL_MS } from '@/connections/rows';

export const PER_DAY = /^\d{1,9}(\.\d{1,6})?$/;

interface Asker {
  account: Address;
  chainId: number;
  clientName: string;
  clientId: string;
  sessionAddress: Address;
}

export function budgetRequest(c: Asker, perDay: string, now: Date): ApprovalRequest | 'no_usdc' | 'zero' {
  const usdc = usdcForNetwork(`eip155:${c.chainId}`);
  if (!usdc) return 'no_usdc';
  const allowance = parseUnits(perDay, usdc.decimals);
  if (allowance === 0n) return 'zero';
  return openRequest(
    {
      id: randomBytes(16).toString('base64url') as ApprovalId,
      account: c.account,
      chainId: c.chainId,
      requester: { name: c.clientName, clientId: c.clientId },
      sessionAddress: c.sessionAddress,
      body: {
        kind: 'budget',
        spender: c.sessionAddress,
        token: usdc.address,
        allowance: allowance.toString(),
        expiry: Math.floor((now.getTime() + CONNECTION_TTL_MS) / 1000),
      },
    },
    now
  );
}
