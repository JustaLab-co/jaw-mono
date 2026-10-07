'use client';

import { Account } from '@jaw.id/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchCliApiKey } from '../../lib/cli-api-key';
import { SignInScreen, type AuthenticatedAccount } from '../OnboardingSection';
import type { ChainId } from '../../utils/types';

export interface ConsentDetails {
  uid: string;
  client: { id: string; name: string; host: string | null };
  redirectHost: string;
  scopes: { id: string; label: string }[];
  chainId: number;
  expiresAt: string;
  message: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function AuthorizeScreen({ uid, mcpUrl }: { uid: string; mcpUrl: string }) {
  const [account, setAccount] = useState<AuthenticatedAccount | null>(null);
  const [status, setStatus] = useState<'idle' | 'signing' | 'error'>('idle');
  const [error, setError] = useState('');
  const base = `${mcpUrl}/interaction/${encodeURIComponent(uid)}`;

  const query = useQuery({
    queryKey: ['consent', uid],
    retry: false,
    queryFn: async (): Promise<{ details: ConsentDetails; apiKey?: string }> => {
      // The agent workspace key, the same fallback the CLI bridge uses.
      const [res, apiKey] = await Promise.all([fetch(`${base}/details`, { cache: 'no-store' }), fetchCliApiKey()]);
      if (!res.ok) throw new Error('expired');
      return { details: await res.json(), apiKey: apiKey || undefined };
    },
  });

  if (query.isPending) return <p className="text-center text-sm">Loading…</p>;
  if (query.isError) return <p className="text-center text-sm">This request expired. Start again from your app.</p>;
  const { details, apiKey } = query.data;

  const connect = async (who: AuthenticatedAccount) => {
    setStatus('signing');
    try {
      const signer = await Account.get({ chainId: details.chainId, apiKey });
      const signature = await signer.signMessage(details.message);
      const res = await fetch(`${base}/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: who.address, signature }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(REFUSALS[body.error] ?? 'The server refused this consent.');
      if (new URL(body.next).origin !== new URL(mcpUrl).origin) throw new Error('Unexpected hand-back address.');
      window.location.assign(body.next);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Signing failed.');
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-6">
      <div>
        <h1 className="text-lg font-semibold">Connect {details.client.name}</h1>
        <p className="text-muted-foreground text-sm">{details.client.host ?? `Client ID ${details.client.id}`}</p>
        {LOOPBACK.has(details.redirectHost) && (
          <p className="text-muted-foreground text-sm">Returns to an app on this computer.</p>
        )}
      </div>
      <ul className="list-disc pl-5 text-sm">
        {details.scopes.map((s) => (
          <li key={s.id}>{s.label}</li>
        ))}
      </ul>
      <div>
        <p className="text-muted-foreground mb-1 text-xs">You will sign</p>
        <pre data-testid="consent-message" className="bg-muted whitespace-pre-wrap break-all rounded p-3 text-xs">
          {details.message}
        </pre>
      </div>
      {account ? (
        <>
          <p className="text-sm">
            Signing as <span className="font-mono">{account.address}</span>
          </p>
          <button
            className="bg-primary text-primary-foreground rounded p-2 disabled:opacity-50"
            disabled={status === 'signing'}
            onClick={() => connect(account)}
          >
            {status === 'signing' ? 'Waiting for passkey…' : 'Connect'}
          </button>
        </>
      ) : (
        <SignInScreen chainId={details.chainId as ChainId} apiKey={apiKey} onComplete={setAccount} />
      )}
      <button className="text-sm underline" onClick={() => window.location.assign(`${base}/abort`)}>
        Decline
      </button>
      {status === 'error' && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}

const REFUSALS: Record<string, string> = {
  bad_signature: 'The signature did not verify for this account.',
  already_consented: 'This request was already answered. Start again from your app.',
  not_found: 'This request expired. Start again from your app.',
};
