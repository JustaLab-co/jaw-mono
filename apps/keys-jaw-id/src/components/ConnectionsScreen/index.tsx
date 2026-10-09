'use client';

import { CONNECTION_SCOPES, type ConnectionScope } from '@jaw.id/agent/reserved';
import { Account } from '@jaw.id/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { formatUnits, type Address, type Hex } from 'viem';
import { fetchCliApiKey } from '../../lib/cli-api-key';
import { postProof, SignInExpired, signIn, type ConnectionView, type SignInProof } from '../../lib/connections';
import { UiScope } from '../BudgetApproval';
import { ClientHeader } from '../ClientHeader';
import { SignInScreen } from '../OnboardingSection';
import { PermissionModal, type PermissionRequestData } from '../PermissionModal';
import type { ChainId } from '../../utils/types';

const usdc = (baseUnits: string) => `${formatUnits(BigInt(baseUnits), 6)} USDC`;

const BUDGET_STATE: Record<ConnectionView['budgets'][number]['state'], string> = {
  active: 'Active',
  revoke_on_chain: 'Still approved on chain',
  revoked: 'Revoked',
  expired: 'Expired',
};

interface Server {
  issuer: string;
  chainId: number;
  apiKey?: string;
}

/** The owner's connections on one MCP server, behind a passkey sign-in. */
export function ConnectionsScreen({ mcpUrl }: { mcpUrl: string }) {
  const [proof, setProof] = useState<SignInProof | null>(null);
  const [owner, setOwner] = useState<Account | null>(null);
  const [onChain, setOnChain] = useState<Hex | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();
  const base = `${mcpUrl}/api/connections`;

  const server = useQuery({
    queryKey: ['connections-server'],
    queryFn: async (): Promise<Server> => {
      const [res, apiKey] = await Promise.all([fetch(base, { cache: 'no-store' }), fetchCliApiKey()]);
      if (!res.ok) throw new Error('unavailable');
      return { ...(await res.json()), apiKey: apiKey || undefined };
    },
  });
  const list = useQuery({
    queryKey: ['connections', proof?.signature],
    enabled: proof !== null,
    retry: false,
    queryFn: async () => {
      try {
        return await postProof<ConnectionView[]>(base, proof as SignInProof);
      } catch (err) {
        if (err instanceof SignInExpired) {
          setProof(null);
          setError(err.message);
        }
        throw err;
      }
    },
  });

  if (server.isPending) return <p className="text-center text-sm">Loading…</p>;
  if (server.isError) return <p className="text-center text-sm">Connections are not available right now.</p>;
  const { chainId, apiKey } = server.data;

  const run = async (step: () => Promise<void>) => {
    setError('');
    try {
      await step();
    } catch (err) {
      if (err instanceof SignInExpired) setProof(null);
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  const signedIn = (address: Address) =>
    run(async () => {
      const account = await Account.get({ chainId, apiKey });
      setOwner(account);
      setProof(await signIn(account, address, server.data));
    });

  if (proof === null || owner === null) {
    return (
      <div className="flex flex-col gap-4 rounded-lg border p-6">
        <h1 className="text-lg font-semibold">Your connections</h1>
        <p className="text-muted-foreground text-sm">
          Sign in with your passkey to see the apps connected to your account.
        </p>
        <SignInScreen chainId={chainId as ChainId} apiKey={apiKey} onComplete={(a) => signedIn(a.address as Address)} />
        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>
    );
  }

  const revoke = (view: ConnectionView) =>
    run(async () => {
      setConfirming(null);
      const ended = await postProof<ConnectionView>(`${base}/${encodeURIComponent(view.id)}/revoke`, proof);
      queryClient.setQueryData<ConnectionView[]>(['connections', proof.signature], (old) =>
        old?.map((c) => (c.id === ended.id ? ended : c))
      );
      setOnChain(ended.budgets.find((b) => b.state === 'revoke_on_chain')?.permissionId ?? null);
    });

  const afterOnChain = (done: Hex, failed: string) =>
    run(async () => {
      setOnChain(null);
      const { data } = await list.refetch();
      if (failed) throw new Error(failed);
      const budgets = data?.find((c) => c.budgets.some((b) => b.permissionId === done))?.budgets ?? [];
      setOnChain(budgets.find((b) => b.state === 'revoke_on_chain' && b.permissionId !== done)?.permissionId ?? null);
    });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Your connections</h1>
      {error && <p className="text-destructive text-sm">{error}</p>}
      {list.isPending && <p className="text-sm">Loading…</p>}
      {list.isError && <p className="text-destructive text-sm">{list.error.message}</p>}
      {list.data?.length === 0 && <p className="text-sm">No app is connected to this account.</p>}
      {list.data?.map((view) => (
        <ConnectionCard
          key={view.id}
          view={view}
          confirming={confirming === view.id}
          onRevoke={() => setConfirming(view.id)}
          onCancel={() => setConfirming(null)}
          onConfirm={() => revoke(view)}
          onRevokeOnChain={setOnChain}
        />
      ))}
      {onChain && (
        <RevokeOnChain
          permissionId={onChain}
          owner={proof.account}
          account={owner}
          apiKey={apiKey}
          onDone={(failed) => afterOnChain(onChain, failed)}
        />
      )}
    </div>
  );
}

interface CardProps {
  view: ConnectionView;
  confirming: boolean;
  onRevoke: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onRevokeOnChain: (permissionId: Hex) => void;
}

function ConnectionCard({ view, confirming, onRevoke, onCancel, onConfirm, onRevokeOnChain }: CardProps) {
  // The float, when there is any to lose.
  const funded = view.float !== null && BigInt(view.float) > 0n ? view.float : null;
  const unread = view.payer !== null && view.float === null;
  const cannot = (Object.keys(CONNECTION_SCOPES) as ConnectionScope[]).filter((s) => !view.scopes.includes(s));
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-6">
      <div>
        <ClientHeader title="Connected:" client={view.client} heading="h2" />
        <p className="text-muted-foreground text-sm">
          {view.revokedAt
            ? `Revoked ${new Date(view.revokedAt).toLocaleString()}`
            : view.status === 'expired'
              ? `Ended ${new Date(view.expiresAt).toLocaleString()}`
              : `Connected ${new Date(view.createdAt).toLocaleString()}`}
        </p>
        <p className="text-muted-foreground text-sm">
          Can: {view.scopes.map((s) => CONNECTION_SCOPES[s as ConnectionScope] ?? s).join('; ')}
        </p>
        {cannot.length > 0 && (
          <p className="text-muted-foreground text-sm">Cannot: {cannot.map((s) => CONNECTION_SCOPES[s]).join('; ')}</p>
        )}
      </div>

      {view.budgets.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {view.budgets.map((b) => (
            <li key={b.permissionId} className="flex flex-wrap items-center gap-2">
              <span>{usdc(b.allowance)} per day</span>
              <span className="text-muted-foreground">{BUDGET_STATE[b.state]}</span>
              {b.state === 'revoke_on_chain' && (
                <button className="rounded border px-2 py-1" onClick={() => onRevokeOnChain(b.permissionId)}>
                  Revoke on chain
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {view.payer && (
        <p className="text-sm">
          {view.status === 'revoked' && funded ? (
            <>
              {usdc(funded)} is left in the payer <span className="font-mono">{view.payer}</span>. Nobody can move it
              any more.
            </>
          ) : (
            <>
              Float: {view.float === null ? 'unknown' : usdc(view.float)} in{' '}
              <span className="font-mono">{view.payer}</span>
            </>
          )}
        </p>
      )}

      {view.events.length > 0 && (
        <table className="text-xs">
          <tbody>
            {view.events.map((e) => (
              <tr key={`${e.at}-${e.requestId}`}>
                <td className="pr-2">{new Date(e.at).toLocaleTimeString()}</td>
                <td className="pr-2 font-mono">{e.tool}</td>
                <td>{e.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {view.status === 'active' && !confirming && (
        <button className="rounded border p-2" onClick={onRevoke}>
          Revoke
        </button>
      )}
      {confirming && (
        <div className="flex flex-col gap-2 rounded border p-3 text-sm">
          <p>The app&apos;s tokens stop working at once. Then you revoke its budget on chain with your passkey.</p>
          {unread && (
            <p className="text-destructive">
              The payer&apos;s balance could not be read. Any USDC in it cannot be returned after this; to get it back
              first, ask the agent to call jaw_disconnect.
            </p>
          )}
          {funded && (
            <p className="text-destructive">
              {usdc(funded)} in its payer cannot be returned after this. To get it back first, ask the agent to call
              jaw_disconnect.
            </p>
          )}
          <div className="flex gap-2">
            <button className="bg-destructive flex-1 rounded p-2 text-white" onClick={onConfirm}>
              Revoke anyway
            </button>
            <button className="flex-1 rounded border p-2" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

interface RevokeOnChainProps {
  permissionId: Hex;
  owner: Address;
  account: Account;
  apiKey?: string;
  onDone: (error: string) => void;
}

function RevokeOnChain({ permissionId, owner, account, apiKey, onDone }: RevokeOnChainProps) {
  const chain = useMemo(() => account.getChain(), [account]);
  const request = useMemo<PermissionRequestData>(
    () => ({ method: 'wallet_revokePermissions', params: [{ id: permissionId, address: owner }] }),
    [permissionId, owner]
  );
  return (
    <UiScope>
      <PermissionModal
        permissionRequest={request}
        chain={chain}
        apiKey={apiKey ?? ''}
        account={account}
        onSuccess={async () => onDone('')}
        onError={() => onDone('The budget is still approved on chain.')}
      />
    </UiScope>
  );
}
