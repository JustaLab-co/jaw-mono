import { generateProtectedResourceMetadata, metadataCorsOptionsRequestHandler } from 'mcp-handler';
import { config } from '@/connections/config';
import { CONNECTION_SCOPES } from '@jaw.id/agent';
import { withEdge } from '@/lib/edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withEdge(
  async () => {
    const { issuer, resource } = config();
    const metadata = generateProtectedResourceMetadata({
      authServerUrls: [issuer],
      resourceUrl: resource,
      additionalMetadata: { scopes_supported: Object.keys(CONNECTION_SCOPES), resource_name: 'JAW' },
    });
    return Response.json(metadata, { headers: { 'access-control-allow-origin': '*' } });
  },
  { guarded: false }
);
export const OPTIONS = metadataCorsOptionsRequestHandler();
