import { ConnectionsScreen } from '../../components/ConnectionsScreen';

// The MCP server comes from this deployment's config, never from the URL.
export default function ConnectionsPage() {
  const mcpUrl = process.env.JAW_MCP_URL;
  return (
    <div className="flex min-h-screen items-start justify-center p-4">
      <div className="w-full max-w-xl">
        {mcpUrl ? (
          <ConnectionsScreen mcpUrl={mcpUrl} />
        ) : (
          <p className="text-center text-sm">Connections are not available here.</p>
        )}
      </div>
    </div>
  );
}
