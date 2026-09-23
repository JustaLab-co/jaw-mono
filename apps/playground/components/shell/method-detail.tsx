'use client';

import { useState, type ReactNode } from 'react';
import { opensDialog, methodNeedsAttention, type PlaygroundMethod } from '../../lib/method-ui-meta';
import { segClass, SegGroup } from './primitives';

export interface MethodDetailProps {
  method: PlaygroundMethod;
  transport: 'iframe' | 'popup';
  isConnected: boolean;
  /** The page's existing connect/disconnect flow — used by the amber fix pill. */
  onToggleConnect: () => void;
  /** Rendered code example for the Code Snippet tab. */
  snippet: string;
  /** Eyebrow above the snippet (package name). */
  snippetLabel: string;
  /** Execute-tab content. */
  children: ReactNode;
}

/**
 * Main-pane method view: title row, Execute/Code Snippet tabs, dialog badge,
 * and the connect-gate pill. Mount with `key={method.id}` so tab/copy state
 * resets per method. The Execute tab is unmounted while the snippet shows, so
 * nothing below here may own form state — see useMethodParams.
 */
export function MethodDetail({
  method,
  transport,
  isConnected,
  onToggleConnect,
  snippet,
  snippetLabel,
  children,
}: MethodDetailProps) {
  const [tab, setTab] = useState<'execute' | 'snippet'>('execute');
  const [copied, setCopied] = useState(false);

  const dialog = opensDialog(method);
  const gated = method.requiresConnection && !isConnected;
  const needsAttention = methodNeedsAttention(method, isConnected);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="flex min-w-0 flex-col gap-[18px]">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 break-words font-mono text-[27px] font-semibold tracking-[-0.025em] max-md:min-w-0 max-md:text-[22px] max-md:[overflow-wrap:anywhere]">
            {method.name}
          </h1>
          <span className="border-shell-line-2 text-shell-ink-3 whitespace-nowrap rounded-full border px-[11px] py-[5px] text-[12.5px] capitalize">
            {method.category}
          </span>
        </div>
        <p className="text-shell-ink-3 mt-3 max-w-[70ch] text-base leading-relaxed">{method.description}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <SegGroup label="Method view">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'execute'}
              onClick={() => setTab('execute')}
              className={segClass(tab === 'execute')}
            >
              Execute
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'snippet'}
              onClick={() => setTab('snippet')}
              className={segClass(tab === 'snippet')}
            >
              Code Snippet
            </button>
          </SegGroup>

          <span className="bg-shell-raise-2 text-shell-ink-3 inline-flex items-center gap-[7px] rounded-full px-3 py-1.5 text-[12.5px]">
            {dialog ? (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
                <path d="M3.5 9h17" />
              </svg>
            ) : (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M4 12h16" />
              </svg>
            )}
            <span className="whitespace-nowrap">{dialog ? `Opens ${transport} dialog` : 'No dialog'}</span>
          </span>

          {needsAttention && (
            <button
              type="button"
              onClick={onToggleConnect}
              className="border-shell-warn/45 text-shell-ink inline-flex cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-full border bg-transparent px-[13px] py-1.5 text-[12.5px] font-medium"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3v9" />
                <path d="M7.5 6.5a7 7 0 109 0" />
              </svg>
              {gated ? 'Connect to run' : 'Disconnect to see the dialog'}
            </button>
          )}
        </div>
      </div>

      {tab === 'execute' ? (
        children
      ) : (
        <div className="border-shell-line bg-shell-code overflow-hidden rounded-2xl border">
          <div className="border-shell-line flex items-center justify-between border-b px-4 py-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#64748B]">{snippetLabel}</span>
            <button
              type="button"
              onClick={handleCopy}
              className="cursor-pointer rounded-full border border-white/[.18] bg-transparent px-3 py-1.5 text-[11.5px] text-[#F5F5F4]"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="text-shell-code-ink m-0 overflow-x-auto p-5 font-mono text-[12.5px] leading-[1.75]">
            {snippet}
          </pre>
        </div>
      )}
    </section>
  );
}
