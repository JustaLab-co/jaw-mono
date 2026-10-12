import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Routes that third-party dApps may embed in an iframe (the SDK dialog).
// Everything NOT in this list keeps frame-ancestors 'none' + X-Frame-Options
// DENY — embeddability is opt-in per route, never inherited. Adding a route
// here requires security review.
const EMBEDDABLE_ROUTES: readonly string[] = ['/'];

export function middleware(request: NextRequest) {
  const isDev = process.env.NODE_ENV === 'development';
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isEmbeddable = EMBEDDABLE_ROUTES.includes(request.nextUrl.pathname);

  // --- connect-src ---
  // api.justaname.id: JAW RPC proxy, paymaster, passkey endpoints
  // eth.llamarpc.com: Fallback RPC used when no chain.rpcUrl is provided
  // http://127.0.0.1:* http://localhost:*: CLI bridge callback (loopback only)
  //
  // NOTE: https: and wss: wildcards are required because dApps pass arbitrary
  // chain.rpcUrl values via postMessage (Alchemy, Infura, Ankr, QuickNode, etc.).
  // These URLs are not known at build time and vary per connecting dApp.
  // If dApp RPC proxying is ever routed through api.justaname.id exclusively,
  // the wildcards can be removed.
  const isCLIBridge = request.nextUrl.pathname === '/cli-bridge';
  const connectSrc = [
    "'self'",
    'https://api.justaname.id',
    'https://eth.llamarpc.com',
    // CLI bridge: relay WebSocket + HTTPS/WSS for SDK RPC calls.
    // Other pages: dApps pass arbitrary chain.rpcUrl values.
    ...(isCLIBridge ? ['wss://relay.jaw.id', 'ws://localhost:*', 'https:', 'wss:'] : ['https:', 'wss:']),
  ].join(' ');

  // --- img-src ---
  // self: Local assets (jaw-logo.png, favicon, etc.)
  // data: Inline SVG wallet icon (JAW_WALLET_ICON) and data-URI chain icons
  // https://api.justaname.id: Chain icons fetched from wallet_getCapabilities
  //
  // NOTE: https: wildcard is required because dApps pass appLogoUrl from
  // any domain (their logo to show in modals). These URLs are user-controlled
  // and cannot be scoped at build time.
  const imgSrc = "'self' data: https://api.justaname.id https:";

  // --- style-src ---
  // 'unsafe-inline' is required because:
  // 1. Radix UI primitives (via @jaw.id/ui) inject inline styles at runtime
  //    for positioning dialogs, popovers, and tooltips
  // 2. React inline style={} attributes are used extensively in layout.tsx
  //    and all modal/dialog components
  // Nonce-based styles are not feasible without patching Radix UI internals.
  const styleSrc = "'self' 'unsafe-inline'";

  const csp = [
    "default-src 'self'",
    isDev ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'" : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src ${styleSrc}`,
    `img-src ${imgSrc}`,
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    // Clickjacking protection for the embeddable dialog route is handled by
    // the in-dialog visibility guard (IntersectionObserver v2) + popup
    // routing, not by framing headers.
    ...(isEmbeddable ? [] : ["frame-ancestors 'none'"]),
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    // TODO: Add CSP violation reporting endpoint. Example:
    //   report-uri https://your-domain.report-uri.com/r/d/csp/enforce
    //   report-to csp-endpoint
    // Then add the Report-To header:
    //   response.headers.set('Report-To', JSON.stringify({
    //     group: 'csp-endpoint',
    //     max_age: 10886400,
    //     endpoints: [{ url: 'https://your-domain.report-uri.com/r/d/csp/enforce' }],
    //   }));
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  // Forward the nonce to the request so the layout can read it via headers()
  // and stamp user-authored inline <script> tags (e.g. the theme detection
  // script in app/layout.tsx). Without this, those scripts get blocked in
  // production by the `strict-dynamic` CSP because they have no matching nonce.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  if (!isEmbeddable) {
    response.headers.set('X-Frame-Options', 'DENY');
  }
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('X-DNS-Prefetch-Control', 'off');

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
