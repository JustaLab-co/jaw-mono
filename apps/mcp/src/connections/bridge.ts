import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

// NextRequest rewrites the first loopback host anywhere in its URL to
// "localhost", query string included, which breaks a loopback redirect_uri
// such as http://127.0.0.1:8765/callback. The base Request keeps the URL as sent.
const requestUrl = Object.getOwnPropertyDescriptor(Request.prototype, 'url')!.get!;

// Runs a node (req, res) handler, such as a Koa callback, against a web Request.
// Bodies are buffered: every provider request and response is small.
export async function bridge(req: Request, run: NodeHandler): Promise<Response> {
  const url = new URL(requestUrl.call(req));
  const body = Buffer.from(await req.arrayBuffer());

  const nodeReq = new IncomingMessage(new Socket());
  nodeReq.method = req.method;
  nodeReq.url = url.pathname + url.search;
  nodeReq.headers = Object.fromEntries(req.headers);
  nodeReq.headers.host ??= url.host;
  nodeReq.headers['x-forwarded-proto'] ??= url.protocol.slice(0, -1);
  if (body.length) {
    nodeReq.headers['content-length'] = String(body.length);
    nodeReq.push(body);
  }
  nodeReq.push(null);

  const nodeRes = new ServerResponse(nodeReq);
  const chunks: Buffer[] = [];
  const toBuffer = (chunk: unknown) =>
    typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);

  return new Promise<Response>((resolve, reject) => {
    nodeRes.write = ((chunk: unknown) => {
      chunks.push(toBuffer(chunk));
      return true;
    }) as ServerResponse['write'];
    nodeRes.end = ((chunk?: unknown) => {
      if (chunk && typeof chunk !== 'function') chunks.push(toBuffer(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(nodeRes.getHeaders())) {
        for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) headers.append(name, String(v));
      }
      const payload = chunks.length ? Buffer.concat(chunks) : null;
      const nullBody = [204, 304].includes(nodeRes.statusCode) || req.method === 'HEAD';
      resolve(new Response(nullBody ? null : payload, { status: nodeRes.statusCode, headers }));
      return nodeRes;
    }) as ServerResponse['end'];
    Promise.resolve(run(nodeReq, nodeRes)).catch(reject);
  });
}
