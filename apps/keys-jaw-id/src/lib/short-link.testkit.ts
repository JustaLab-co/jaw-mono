/** Seals `plain` the way the MCP server does, under `key` for the blob stored at `id`, with a fixed IV. */
export async function sealForTest(plain: unknown, id: string, key: string): Promise<string> {
  const iv = new Uint8Array(12).fill(9);
  const aes = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`jaw-short-link/1\n${id}`) },
    aes,
    new TextEncoder().encode(typeof plain === 'string' ? plain : JSON.stringify(plain))
  );
  return Buffer.concat([iv, new Uint8Array(ct)]).toString('base64url');
}
