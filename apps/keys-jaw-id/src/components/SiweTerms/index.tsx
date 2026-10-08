import type { SiweView } from '../../lib/approval-decision';

/** The server's preview of a Sign in with Ethereum message, as served. */
export function SiweTerms({ preview }: { preview: SiweView['preview'] }) {
  return (
    <>
      <p className="text-destructive text-sm">
        Signing logs the agent into {preview.domain} as {preview.account}.
      </p>
      {preview.warnings.includes('hidden_characters') && (
        <p className="text-destructive text-sm">
          This login contains hidden or direction-changing characters, shown as ⟦U+…⟧.
        </p>
      )}
      {preview.statement && <p className="text-sm">{preview.statement}</p>}
      <p className="text-muted-foreground break-all text-sm">
        Site: <span className="font-mono">{preview.uri}</span>
      </p>
      <p className="text-muted-foreground text-xs">
        Nonce <span className="font-mono">{preview.nonce}</span>, issued {new Date(preview.issuedAt).toLocaleString()}
        {preview.expirationTime && `, expires ${new Date(preview.expirationTime).toLocaleString()}`}
      </p>
    </>
  );
}
