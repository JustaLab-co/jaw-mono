import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { FetchRefused } from '@jaw.id/agent';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 127],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

function isPrivate(address: string): boolean {
  return blocked.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
}

/**
 * fetch for URLs an agent supplies. https only, no redirects, and no host that
 * resolves to a private, loopback, link-local or metadata address. Hosts in
 * `allow` skip both checks; that is for local verification only.
 */
export function safeFetch(allow: ReadonlySet<string>): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!allow.has(url.host)) {
      if (url.protocol !== 'https:') throw new FetchRefused('only https URLs can be fetched');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
      if (addresses.some(isPrivate)) throw new FetchRefused('the URL resolves to a private address');
    }
    return fetch(input, { ...init, redirect: 'manual' });
  };
}
