import { config } from '@/connections/config';

/** Lets keys.jaw.id, and only it, call the routes its pages use. No credentials. */
export function pageCors(res: Response): Response {
  res.headers.set('access-control-allow-origin', config().keysOrigin);
  res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.headers.set('access-control-allow-headers', 'content-type');
  res.headers.set('cache-control', 'no-store');
  res.headers.set('vary', 'origin');
  return res;
}

export function preflight(): Response {
  return pageCors(new Response(null, { status: 204 }));
}
