import { ApproveScreen } from '../../../components/ApproveScreen';

// The MCP server comes from this deployment's config, never from the URL.
export default async function ApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const mcpUrl = process.env.JAW_MCP_URL;
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        {mcpUrl ? (
          <ApproveScreen id={id} mcpUrl={mcpUrl} />
        ) : (
          <p className="text-center text-sm">Approvals are not available here.</p>
        )}
      </div>
    </div>
  );
}
