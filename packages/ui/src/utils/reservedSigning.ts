import { hexToString, isHex } from 'viem';

// A copy of the rule in @jaw.id/agent's approvals/reserved.ts, which this
// published package cannot depend on. keys-jaw-id tests that the two agree.
const RESERVED_PREFIX = 'JAW ';
const JAW_DOMAIN_NAME = 'JAW';

export const RESERVED_SIGNING_REFUSAL = 'JAW reserves this request for its own consent and approval pages';

/** Why a generic signing request must not reach the passkey, or undefined when it may. */
export function reservedSigningRefusal(method: string, params: unknown): string | undefined {
  const list = Array.isArray(params) ? params : [params];
  let reserved = false;
  if (method === 'personal_sign') reserved = list.some(isReservedText);
  else if (method.startsWith('eth_signTypedData')) reserved = list.some(isJawTypedData);
  else if (method === 'wallet_sign') {
    const request = (list[0] as { request?: { type?: unknown; data?: { message?: unknown } } } | undefined)?.request;
    reserved = request?.type === '0x45' ? isReservedText(request.data?.message) : isJawTypedData(request?.data);
  }
  return reserved ? RESERVED_SIGNING_REFUSAL : undefined;
}

function isReservedText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.startsWith(RESERVED_PREFIX) || (isHex(value) && hexToString(value).startsWith(RESERVED_PREFIX));
}

function isJawTypedData(value: unknown): boolean {
  let data = value;
  if (typeof value === 'string') {
    try {
      data = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return (data as { domain?: { name?: unknown } } | null)?.domain?.name === JAW_DOMAIN_NAME;
}
