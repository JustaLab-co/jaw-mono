import { AuthorizeScreen } from '../../components/AuthorizeScreen';

// Consent for an MCP client connecting to the hosted JAW server. The server
// comes from this deployment's config, never from the query string.
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<{ uid?: string }> }) {
  const { uid } = await searchParams;
  const mcpUrl = process.env.JAW_MCP_URL;
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        {uid && mcpUrl ? (
          <AuthorizeScreen uid={uid} mcpUrl={mcpUrl} />
        ) : (
          <p className="text-center text-sm">This link is incomplete. Start again from your app.</p>
        )}
      </div>
    </div>
  );
}
