// Demo funding config, shared by the /api/fund route and the client.

export { EURE_ADDRESS, EURE_DECIMALS } from './eure';

// The tour spends 2 EURe (send) plus EURe paymaster gas. An account holding
// at least this much can finish the tour: skip.
export const ALREADY_FUNDED_EURE = '3';
// Top-up for fresh accounts: spends + gas headroom.
export const FUND_AMOUNT_EURE = '5';
// Refuse to fund below this treasury balance so the demo never half-funds.
export const FUNDER_FLOOR_EURE = '10';

/** POST the address to /api/fund; resolves with {skipped} or {txHash}. */
export async function fundAccount(address: string): Promise<{ skipped?: boolean; txHash?: string }> {
  const res = await fetch('/api/fund', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const json = (await res.json().catch(() => ({}))) as { skipped?: boolean; txHash?: string; error?: string };
  if (!res.ok) throw new Error(json.error || 'Funding failed');
  return json;
}
