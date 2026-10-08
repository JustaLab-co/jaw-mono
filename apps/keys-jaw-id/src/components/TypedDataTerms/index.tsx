import type { TypedDataView } from '../../lib/approval-decision';

const WARNINGS: Record<string, string> = {
  hidden_characters: 'This typed data contains hidden or direction-changing characters, shown as ⟦U+…⟧.',
  token_permit: 'This signature can let someone move your tokens without asking you again.',
  chain_mismatch: 'This typed data names another chain than the one this request is for.',
};

/** The server's preview, as served: domain and message as text. */
export function TypedDataTerms({ preview }: { preview: TypedDataView['preview'] }) {
  return (
    <>
      {preview.warnings.map((w) => (
        <p key={w} className="text-destructive text-sm">
          {WARNINGS[w] ?? w}
        </p>
      ))}
      <p className="text-sm">
        Sign <span className="font-mono">{preview.primaryType}</span>
      </p>
      <div>
        <p className="text-muted-foreground mb-1 text-xs">Domain</p>
        <pre className="bg-muted whitespace-pre-wrap break-all rounded p-3 text-xs">{preview.domain}</pre>
      </div>
      <div>
        <p className="text-muted-foreground mb-1 text-xs">Message</p>
        <pre className="bg-muted whitespace-pre-wrap break-all rounded p-3 text-xs">{preview.message}</pre>
      </div>
    </>
  );
}
