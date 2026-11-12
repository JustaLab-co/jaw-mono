import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address, Hex } from 'viem';

import { hasChecker } from '../components/PermissionDialog/calls';
import type { CallPermission, CheckerView } from '../components/PermissionDialog/types';
import { readChecker } from '../utils/checkerRule';
import {
  createTokenResolver,
  getDefaultDescriptorSource,
  resolveCalldataDescriptor,
  type DescriptorField,
} from '../utils/clearSigning';
import { getPublicClient, jawRpcUrl } from '../utils/publicClient';
import { describeRule, isErc20Function, type CallDescriptor } from '../utils/ruleText';

type Token = { decimals: number; symbol: string };

/** A token's own `symbol()` is free text the token chose, so only its start goes into the rule. */
const MAX_SYMBOL = 12;

/** A descriptor's fields with nested ones flattened to full paths, the way a rule's argument is named. */
function flattenFields(fields: readonly DescriptorField[] | undefined, prefix = ''): CallDescriptor['fields'] {
  return (fields ?? []).flatMap((field) => {
    const path = prefix ? `${prefix}.${field.path.replace(/^#\./, '')}` : field.path;
    return [{ path, label: field.label }, ...flattenFields(field.fields, path)];
  });
}

/**
 * What the grant screen says about each call's checker. A checker whose deploy is in the request is
 * read from it; any other is read from the chain. The contract's clear-signing labels and the token's
 * units are looked up only to word the rule, so the line upgrades in place when they arrive and
 * nothing waits on them. Undefined for a call while its checker is still unknown, or can't be read.
 *
 * Everything read is keyed by chain: the same address on another chain is another contract.
 */
export function useCheckerViews(
  calls: CallPermission[],
  options: {
    chainId?: number;
    apiKey?: string;
    nativeSymbol: string;
    /** What the host already knows about each target token, keyed by address. */
    tokenMeta?: Record<string, { symbol: string; decimals?: number | null }>;
  }
): (call: CallPermission) => CheckerView | undefined {
  const { chainId, apiKey, nativeSymbol, tokenMeta } = options;
  const [codes, setCodes] = useState<Record<string, Hex>>({});
  const [descriptors, setDescriptors] = useState<Record<string, CallDescriptor>>({});
  const [tokens, setTokens] = useState<Record<string, Token>>({});

  const chainKey = useCallback((...parts: string[]) => [chainId ?? '', ...parts].join(':').toLowerCase(), [chainId]);
  const callKey = useCallback((call: CallPermission) => chainKey(call.target, call.selector ?? ''), [chainKey]);

  const checked = useMemo(() => calls.filter(hasChecker), [calls]);
  // What the reads below depend on, stable across renders that carry the same calls.
  const readKey = checked
    .map((call) => `${callKey(call)}:${call.checker.toLowerCase()}:${call.checkerDeploy ? 'deploy' : ''}`)
    .join('|');

  useEffect(() => {
    if (!chainId || checked.length === 0) return;
    let cancelled = false;
    const client = getPublicClient(chainId, jawRpcUrl(chainId, apiKey));
    const resolveToken = createTokenResolver(chainId, apiKey);

    for (const call of checked) {
      if (!call.checkerDeploy) {
        client
          .getCode({ address: call.checker as Address })
          .then((code) => !cancelled && setCodes((prev) => ({ ...prev, [chainKey(call.checker)]: code ?? '0x' })))
          .catch(() => undefined);
      }
      if (call.selector) {
        // The registry matches a call on its selector alone; the zero word only makes it long enough.
        resolveCalldataDescriptor(
          getDefaultDescriptorSource(),
          chainId,
          call.target,
          `${call.selector}${'0'.repeat(64)}`
        )
          .then((match) => {
            if (cancelled || !match) return;
            const descriptor = { formatKey: match.formatKey, fields: flattenFields(match.format.fields) };
            setDescriptors((prev) => ({ ...prev, [callKey(call)]: descriptor }));
          })
          .catch(() => undefined);
      }
      if (call.selector && isErc20Function(call.selector)) {
        resolveToken(call.target)
          .then((token) => {
            if (cancelled || !token) return;
            setTokens((prev) => ({
              ...prev,
              [chainKey(call.target)]: { decimals: token.decimals, symbol: token.symbol.slice(0, MAX_SYMBOL) },
            }));
          })
          .catch(() => undefined);
      }
    }
    return () => {
      cancelled = true;
    };
    // `readKey` stands for `checked`: the same calls read the same things.
  }, [readKey, chainId, apiKey]);

  return useCallback(
    (call: CallPermission): CheckerView | undefined => {
      if (!hasChecker(call)) return undefined;
      const code = codes[chainKey(call.checker)];
      if (!call.checkerDeploy && code === undefined) return undefined;

      const reading = readChecker(call.checker, { checkerDeploy: call.checkerDeploy, code });
      if (reading.status === 'custom') return { tone: 'custom' };
      if (reading.status === 'broken') return { tone: 'blocks' };

      // The host's own token data names the group header too, so the rule says the same thing.
      const known = tokenMeta?.[call.target];
      const token =
        known && typeof known.decimals === 'number'
          ? { decimals: known.decimals, symbol: known.symbol.slice(0, MAX_SYMBOL) }
          : tokens[chainKey(call.target)];
      return describeRule(reading.rule, {
        call: { selector: call.selector, signature: call.functionSignature, descriptor: descriptors[callKey(call)] },
        token,
        nativeSymbol,
      });
    },
    [codes, descriptors, tokens, tokenMeta, nativeSymbol, chainKey, callKey]
  );
}
