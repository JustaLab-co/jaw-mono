/**
 * EIP-681 payment request URI for a plain transfer to `address` on `chainId`.
 *
 * The chain is in the payload, not just in the surrounding text, because that
 * is what makes a wrong-network send harder: a scanner that understands the URI
 * selects the network itself instead of leaving the sender to notice a label.
 *
 * Deliberately minimal. `amount` is omitted even when the caller knows one,
 * because nothing on this screen can verify what actually arrives — a shortfall
 * would look identical to a success. An expected amount belongs here once a
 * request has its own routing address to check it against.
 */
export function eip681Uri(address: string, chainId: number): string {
  return `ethereum:${address}@${chainId}`;
}
