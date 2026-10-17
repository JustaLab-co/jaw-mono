import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The same resource config() derives, read without it so this page answers
// even while the rest of the configuration is incomplete.
const mcpUrl = () => new URL('/mcp', process.env.JAW_MCP_PUBLIC_URL || 'https://mcp.jaw.id').href;

const AGENTS_URL = 'https://jaw.id/agents';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function html(url: string): string {
  const u = escape(url);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>jaw mcp</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:Canvas;color:CanvasText}
main{max-width:36rem;padding:1rem}
p{margin:0}
a{color:inherit}
.url{display:block;margin:.4rem 0 .9rem;padding:.5rem .75rem;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:6px;background:color-mix(in srgb,CanvasText 6%,Canvas);text-decoration:none;overflow-wrap:anywhere;user-select:all}
</style>
</head>
<body>
<main>
<p>hi. i'm the jaw mcp server.</p>
<p>add me as a connector to your favorite ai:</p>
<a class="url" href="${u}">${u}</a>
<p>more at <a href="${AGENTS_URL}">jaw.id/agents</a></p>
</main>
</body>
</html>
`;
}

// A text/html media range with q > 0; `text/html;q=0` is a refusal.
const acceptsHtml = (accept: string | null) =>
  (accept ?? '').split(',').some((range) => {
    const [type, ...params] = range.split(';').map((s) => s.trim().toLowerCase());
    const q = params.find((p) => p.startsWith('q='));
    return type === 'text/html' && (q === undefined || Number(q.slice(2)) > 0);
  });

const text = (url: string) =>
  `hi. i'm the jaw mcp server.
add me as a connector to your favorite ai:
${url}
more at ${AGENTS_URL}
`;

export const GET = withEdge(
  async (req) => {
    const wantsHtml = acceptsHtml(req.headers.get('accept'));
    const url = mcpUrl();
    return new Response(wantsHtml ? html(url) : text(url), {
      headers: {
        'content-type': wantsHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        vary: 'accept',
      },
    });
  },
  { guarded: false }
);
export const HEAD = GET;
