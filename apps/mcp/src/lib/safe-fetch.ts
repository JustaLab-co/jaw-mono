import { lookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { FetchRefused } from '@jaw.id/agent';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
// No ::ffff:0:0/96 rule: BlockList checks IPv4-mapped addresses against the
// IPv4 rules already, and that rule would match every IPv4 address.
for (const [net, bits] of [
  ['::', 127],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

const MAX_BODY_BYTES = 1_000_000;

export const isPrivate = (address: string) => blocked.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');

// Checks the addresses the socket actually connects to, so a name cannot pass
// with a public answer and then connect to a private one.
export const publicOnly =
  (resolve: typeof lookup = lookup): LookupFunction =>
  (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, '', 0);
      if (addresses.some((a) => isPrivate(a.address))) {
        return callback(new FetchRefused('the URL resolves to a private address'), '', 0);
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };

function toResponse(res: IncomingMessage, body: Buffer): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) headers.append(name, v);
  }
  const status = res.statusCode ?? 502;
  return new Response([101, 204, 205, 304].includes(status) ? null : new Uint8Array(body), { status, headers });
}

// https only, never follows redirects, and connects only to public addresses.
// Hosts in `insecureHosts` skip the https and address checks: local verification only.
export function safeFetch(insecureHosts: ReadonlySet<string>): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const insecure = insecureHosts.has(url.host);
    if (!insecure && url.protocol !== 'https:') throw new FetchRefused('only https URLs can be fetched');
    if (!insecure && isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivate(url.hostname.replace(/^\[|\]$/g, ''))) {
      throw new FetchRefused('the URL resolves to a private address');
    }
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = Object.fromEntries(new Headers(init?.headers));
    return new Promise<Response>((resolve, reject) => {
      const req = send(
        url,
        {
          method: init?.method ?? 'GET',
          headers,
          signal: init?.signal ?? undefined,
          lookup: insecure ? undefined : publicOnly(),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          // A longer body is cut, not refused: a paid answer still arrives, and its payment stays recorded.
          res.on('data', (chunk: Buffer) => {
            if (size >= MAX_BODY_BYTES) return;
            chunks.push(chunk.subarray(0, MAX_BODY_BYTES - size));
            size += chunk.length;
            if (size < MAX_BODY_BYTES) return;
            delete res.headers['content-length'];
            resolve(toResponse(res, Buffer.concat(chunks)));
            res.destroy();
          });
          res.on('end', () => resolve(toResponse(res, Buffer.concat(chunks))));
          res.on('error', reject);
        }
      );
      req.on('error', (err) => reject(err.cause instanceof FetchRefused ? err.cause : err));
      if (init?.body) req.write(typeof init.body === 'string' ? init.body : String(init.body));
      req.end();
    });
  };
}
