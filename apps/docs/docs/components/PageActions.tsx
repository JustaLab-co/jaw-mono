'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Vocs has no slot under the page title, so the actions mount right after the
// article's h1. Client-side navigation swaps the article, hence the observer.
export function PageActions() {
  const [mount, setMount] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const sync = () => {
      const h1 = document.querySelector('article h1');
      for (const el of document.querySelectorAll('[data-page-actions]')) {
        if (el.previousElementSibling !== h1) el.remove();
      }
      if (!h1) return setMount(null);
      if (h1.nextElementSibling?.hasAttribute('data-page-actions')) return;
      const el = document.createElement('div');
      el.setAttribute('data-page-actions', '');
      h1.after(el);
      setMount(el);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  if (!mount) return null;
  return createPortal(<Actions key={window.location.pathname} />, mount);
}

function Actions() {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const { origin, pathname } = window.location;
  const pageUrl = origin + pathname;
  const markdownUrl = `${origin}/assets/md${pathname === '/' ? '/index' : pathname.replace(/\/$/, '')}.md`;
  const prompt = encodeURIComponent(`Read ${pageUrl} so I can ask you questions about it.`);

  const copyMarkdown = async () => {
    const response = await fetch(markdownUrl);
    await navigator.clipboard.writeText(await response.text());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="page-actions">
      <button type="button" onClick={copyMarkdown}>
        <ClipboardIcon />
        {copied ? 'Copied' : 'Copy Markdown'}
      </button>
      <div className="page-actions-menu" ref={menuRef}>
        <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          Open
          <ChevronIcon />
        </button>
        {open && (
          <div role="menu">
            <a role="menuitem" href={`https://chatgpt.com/?hints=search&q=${prompt}`} target="_blank" rel="noreferrer">
              Open in ChatGPT
            </a>
            <a role="menuitem" href={`https://claude.ai/new?q=${prompt}`} target="_blank" rel="noreferrer">
              Open in Claude
            </a>
            <a role="menuitem" href={markdownUrl} target="_blank" rel="noreferrer">
              View as Markdown
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function ClipboardIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="8" height="4" x="8" y="2" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
