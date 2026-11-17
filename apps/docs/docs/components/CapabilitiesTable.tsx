'use client';

import { useEffect, useState } from 'react';
import { JAW, MAINNET_CHAINS as CORE_MAINNET_CHAINS, TESTNET_CHAINS as CORE_TESTNET_CHAINS } from '@jaw.id/core';

type Capabilities = Record<string, Record<string, unknown>>;

interface ChainInfo {
  name: string;
  chainId: number;
  hexId: string;
}

// Generate chain info from core's SUPPORTED_CHAINS
const MAINNET_CHAINS: ChainInfo[] = CORE_MAINNET_CHAINS.map((chain) => ({
  name: chain.name,
  chainId: chain.id,
  hexId: `0x${chain.id.toString(16)}`,
}));

const TESTNET_CHAINS: ChainInfo[] = CORE_TESTNET_CHAINS.map((chain) => ({
  name: chain.name,
  chainId: chain.id,
  hexId: `0x${chain.id.toString(16)}`,
}));

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ color: '#22c55e' }}>
    <path
      d="M13.5 4.5L6 12L2.5 8.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const XIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ color: '#ef4444' }}>
    <path d="M12 4L4 12M4 4L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const LoadingDot = () => (
  <span
    style={{
      display: 'inline-block',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: '#94a3b8',
      animation: 'pulse 1.5s ease-in-out infinite',
    }}
  />
);

function CapabilityCell({ supported }: { supported: boolean | null }) {
  if (supported === null) {
    return <LoadingDot />;
  }
  return supported ? <CheckIcon /> : <XIcon />;
}

function FeeTokensCell({ tokens }: { tokens: string[] | 'dynamic' | null }) {
  if (tokens === null) {
    return <LoadingDot />;
  }
  if (tokens === 'dynamic') {
    return <span style={{ fontSize: '0.875rem' }}>Dynamic</span>;
  }
  if (tokens.length === 0) {
    return <span style={{ color: '#94a3b8' }}>-</span>;
  }
  return <span style={{ fontSize: '0.875rem' }}>{tokens.join(', ')}</span>;
}

interface CapabilitiesTableProps {
  type: 'mainnet' | 'testnet';
}

export function CapabilitiesTable({ type }: CapabilitiesTableProps) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const chains = type === 'mainnet' ? MAINNET_CHAINS : TESTNET_CHAINS;

  useEffect(() => {
    async function fetchCapabilities() {
      const apiKey = import.meta.env.VITE_JAW_API_KEY;

      if (!apiKey) {
        setError('API key not configured');
        setLoading(false);
        return;
      }

      try {
        const jaw = JAW.create({
          apiKey,
          appName: 'JAW Docs',
          preference: {
            showTestnets: type === 'testnet',
          },
        });

        const result = await jaw.provider.request({
          method: 'wallet_getCapabilities',
        });

        setCapabilities(result as Capabilities);
      } catch (err) {
        console.error('Failed to fetch capabilities:', err);
        setError('Failed to load capabilities');
      } finally {
        setLoading(false);
      }
    }

    fetchCapabilities();
  }, [type]);

  const getCapability = (hexId: string, capName: string): boolean | null => {
    if (loading) return null;
    if (!capabilities) return false;

    const chainCaps = capabilities[hexId];
    if (!chainCaps) return false;

    const cap = chainCaps[capName] as { supported?: boolean; status?: string } | undefined;
    if (!cap) return false;

    return cap.supported === true || cap.status === 'supported';
  };

  const getFeeTokens = (hexId: string): string[] | 'dynamic' | null => {
    if (loading) return null;
    if (!capabilities) return [];

    const chainCaps = capabilities[hexId];
    if (!chainCaps) return [];

    const feeToken = chainCaps.feeToken as
      | {
          supported?: boolean;
          mode?: 'dynamic';
          tokens?: Array<{ symbol: string }>;
        }
      | undefined;

    if (!feeToken?.supported) return [];
    if (feeToken.mode === 'dynamic') return 'dynamic';
    if (!feeToken.tokens) return [];

    return feeToken.tokens.map((t) => t.symbol);
  };

  const tableStyles: React.CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.875rem',
  };

  const thStyles: React.CSSProperties = {
    textAlign: 'left',
    padding: '0.75rem 1rem',
    borderBottom: '1px solid var(--vocs-color_border)',
    fontWeight: 600,
  };

  const thCenterStyles: React.CSSProperties = {
    ...thStyles,
    textAlign: 'center',
  };

  const tdStyles: React.CSSProperties = {
    padding: '0.75rem 1rem',
    borderBottom: '1px solid var(--vocs-color_border)',
  };

  const tdCenterStyles: React.CSSProperties = {
    ...tdStyles,
    textAlign: 'center',
  };

  if (error && !capabilities) {
    return (
      <div
        style={{
          padding: '1rem',
          backgroundColor: 'var(--vocs-color_background2)',
          borderRadius: '0.5rem',
          color: 'var(--vocs-color_text2)',
          fontSize: '0.875rem',
        }}
      >
        {error}. Showing static data.
        <table style={{ ...tableStyles, marginTop: '1rem' }}>
          <thead>
            <tr>
              <th style={thStyles}>Network</th>
              <th style={thStyles}>Chain ID</th>
              <th style={thStyles}>Chain ID (Hex)</th>
            </tr>
          </thead>
          <tbody>
            {chains.map((chain) => (
              <tr key={chain.hexId}>
                <td style={tdStyles}>{chain.name}</td>
                <td style={tdStyles}>
                  <code>{chain.chainId}</code>
                </td>
                <td style={tdStyles}>
                  <code>{chain.hexId}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
      `}</style>
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyles}>
          <thead>
            <tr>
              <th style={thStyles}>Network</th>
              <th style={thStyles}>Chain ID</th>
              <th style={thCenterStyles} title="Atomic batch transactions (EIP-5792)">
                Batch
              </th>
              <th style={thCenterStyles} title="Gasless transactions via paymaster">
                Gasless
              </th>
              <th style={thCenterStyles} title="Permission system support">
                Permissions
              </th>
              <th style={thStyles}>Fee Tokens</th>
            </tr>
          </thead>
          <tbody>
            {chains.map((chain) => (
              <tr key={chain.hexId}>
                <td style={tdStyles}>{chain.name}</td>
                <td style={tdStyles}>
                  <code>{chain.chainId}</code>
                  <span style={{ color: 'var(--vocs-color_text3)', marginLeft: '0.5rem' }}>({chain.hexId})</span>
                </td>
                <td style={tdCenterStyles}>
                  <CapabilityCell supported={getCapability(chain.hexId, 'atomicBatch')} />
                </td>
                <td style={tdCenterStyles}>
                  <CapabilityCell supported={getCapability(chain.hexId, 'paymasterService')} />
                </td>
                <td style={tdCenterStyles}>
                  <CapabilityCell supported={getCapability(chain.hexId, 'permissions')} />
                </td>
                <td style={tdStyles}>
                  <FeeTokensCell tokens={getFeeTokens(chain.hexId)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
