export const MAX_BODY_BYTES = 64 * 1024;

/** The body, or undefined once it passes `max` bytes; stops reading at that point. */
export async function readBody(req: Request, max = MAX_BODY_BYTES): Promise<Buffer | undefined> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return undefined;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

export const tooLarge = () => Response.json({ error: 'body_too_large' }, { status: 413 });

/** Parsed JSON, `{}` when unparseable, or undefined when the body is over the cap. */
export async function readJson(req: Request, max = 16 * 1024): Promise<unknown> {
  const body = await readBody(req, max);
  if (!body) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return {};
  }
}
