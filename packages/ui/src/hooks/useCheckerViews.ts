import { useCallback, useEffect, useMemo, useState } from 'react';
import { erc20Abi, zeroAddress, type Address, type Hex } from 'viem';

import type { CallPermission, CheckerView } from '../components/PermissionDialog/types';
import { readChecker } from '../utils/checkerRule';
import { getDefaultDescriptorSource, resolveCalldataDescriptor, type DescriptorField } from '../utils/clearSigning';
import { getPublicClient, jawRpcUrl } from '../utils/publicClient';
import { describeRule, isErc20Function, type CallDescriptor } from '../utils/ruleText';

type Token = { decimals: number; symbol: string };

function hasChecker(call: CallPermission): call is CallPermission & { checker: string } {
  return typeof call.checker === 'string' && call.checker.toLowerCase() !== zeroAddress;
}

/** A descriptor's fields with nested ones flattened to full paths, the way a rule's argument is named. */
function flattenFields(fields: readonly DescriptorField[] | undefined, prefix = ''): CallDescriptor['fields'] {
  return (fields ?? []).flatMap((field) => {
    const path = prefix ? `${prefix}.${field.path.replace(/^#\./, '')}` : field.path;
    return [{ path, label: field.label }, ...flattenFields(field.fields, path)];
  });
}

const hasNames = (signature: string) => /\(\s*[^,()]*\s+[A-Za-z_$][\w$]*\s*[,)]/.test(signature);
const keyOf = (address: string) => address.toLowerCase();
const callKey = (call: CallPermission) => `${keyOf(call.target)}:${(call.selector ?? '').toLowerCase()}`;

/**
 * What the grant screen says about each call's checker. A checker whose deploy is in the request is
 * read from it; any other is read from the chain. The contract's clear-signing labels and the token's
 * units are looked up only to word the rule, so the line upgrades in place when they arrive and
 * nothing waits on them. Undefined for a call while its checker is still unknown, or can't be read.
 */
export function useCheckerViews(
  calls: CallPermission[],
  options: { chainId?: number; apiKey?: string; nativeSymbol: string }
): (call: CallPermission) => CheckerView | undefined {
  const { chainId, apiKey, nativeSymbol } = options;
  const [codes, setCodes] = useState<Record<string, Hex>>({});
  const [descriptors, setDescriptors] = useState<Record<string, CallDescriptor>>({});
  const [tokens, setTokens] = useState<Record<string, Token>>({});

  const checked = useMemo(() => calls.filter(hasChecker), [calls]);
  // Stable across renders that carry the same calls, so the reads below run once per set.
  const signature = checked
    .map((call) => `${callKey(call)}:${keyOf(call.checker)}:${call.checkerDeploy ? 'deploy' : ''}`)
    .join('|');

  useEffect(() => {
    if (!chainId || checked.length === 0) return;
    let cancelled = false;
    const client = getPublicClient(chainId, jawRpcUrl(chainId, apiKey));

    for (const call of checked) {
      if (!call.checkerDeploy) {
        client
          .getCode({ address: call.checker as Address })
          .then((code) => !cancelled && setCodes((prev) => ({ ...prev, [keyOf(call.checker)]: code ?? '0x' })))
          .catch(() => undefined);
      }
      if (call.selector && !hasNames(call.functionSignature)) {
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
        const address = call.target as Address;
        Promise.all([
          client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
          client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
        ])
          .then(([decimals, symbol]) => {
            if (!cancelled) setTokens((prev) => ({ ...prev, [keyOf(call.target)]: { decimals, symbol } }));
          })
          .catch(() => undefined);
      }
    }
    return () => {
      cancelled = true;
    };
    // `signature` stands for `checked`: the same calls read the same things.
  }, [signature, chainId, apiKey]);

  return useCallback(
    (call: CallPermission): CheckerView | undefined => {
      if (!hasChecker(call)) return undefined;
      const code = codes[keyOf(call.checker)];
      if (!call.checkerDeploy && code === undefined) return undefined;

      const reading = readChecker(call.checker, { checkerDeploy: call.checkerDeploy, code });
      if (reading.status === 'custom') return { tone: 'custom' };
      if (reading.status === 'broken') return { tone: 'blocks' };
      return describeRule(reading.rule, {
        call: { selector: call.selector, signature: call.functionSignature, descriptor: descriptors[callKey(call)] },
        token: tokens[keyOf(call.target)],
        nativeSymbol,
      });
    },
    [codes, descriptors, tokens, nativeSymbol]
  );
}
