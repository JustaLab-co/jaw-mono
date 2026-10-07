/** What the MCP server knows about a client. Only the first-party client is official. */
export interface ClientIdentity {
  clientId: string;
  name: string;
  host: string | null;
  official: boolean;
  reservedName: boolean;
}

// A third-party client is named by the domain of its metadata document, which it
// cannot fake; the name it declares about itself is secondary.
export function ClientHeader({
  title,
  client,
  heading: Heading = 'h1',
}: {
  title: string;
  client: ClientIdentity;
  heading?: 'h1' | 'h2';
}) {
  const shown = client.official ? client.name : (client.host ?? client.clientId);
  return (
    <>
      <Heading className="text-lg font-semibold">
        {title} {shown}
      </Heading>
      {client.official ? (
        <p className="text-muted-foreground text-sm">Official JAW client</p>
      ) : (
        <p className="text-muted-foreground text-sm">Calls itself &quot;{client.name}&quot;</p>
      )}
      {client.reservedName && (
        <p className="text-destructive text-sm">
          &quot;{client.name}&quot; is not a JAW app. Continue only if you trust {shown}.
        </p>
      )}
    </>
  );
}
