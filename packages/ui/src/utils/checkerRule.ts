import { decodeAbiParameters, isAddressEqual, slice, size, type Address, type Hex } from 'viem';
import {
  ARG_AT_MOST_TEMPLATE_ADDRESS,
  ARG_IN_TEMPLATE_ADDRESS,
  VALUE_AT_MOST_TEMPLATE_ADDRESS,
  predictCheckerAddress,
} from '@jaw.id/core';

/** A rule one of the reusable checker templates enforces, read from the clone's settings. */
export type CheckerRule =
  | { kind: 'argIn'; selector: Hex; slot: bigint; allowed: Hex[] }
  | { kind: 'argAtMost'; selector: Hex; slot: bigint; max: bigint }
  | { kind: 'valueAtMost'; selector: Hex; max: bigint };

/**
 * What the grant screen can say about a checker.
 * - `ours`: a clone of one of the three templates, made by our factory, so the rule is exactly this.
 * - `broken`: one of ours whose settings its template can't read, so it reverts on every call.
 * - `custom`: anything else. Its code decides, and nothing here can say what it allows.
 */
export type CheckerReading = { status: 'ours'; rule: CheckerRule } | { status: 'broken' } | { status: 'custom' };

/** What the screen knows about a checker: how the grant would deploy it, or the code already there. */
export interface CheckerSource {
  checkerDeploy?: { template: string; settings: string };
  code?: Hex;
}

// The 45-byte proxy Solady's LibClone puts in front of a clone's settings.
const PROXY_HEAD = '0x363d3d373d3d3d363d73';
const PROXY_TAIL = '0x5af43d82803e903d91602b57fd5bf3';
const PROXY_SIZE = 45;

const TEMPLATES = [ARG_IN_TEMPLATE_ADDRESS, ARG_AT_MOST_TEMPLATE_ADDRESS, VALUE_AT_MOST_TEMPLATE_ADDRESS] as const;

/** The template and settings a deployed clone runs, or null for code of any other shape. */
function fromCloneCode(code: Hex): { template: Address; settings: Hex } | null {
  if (size(code) < PROXY_SIZE) return null;
  if (slice(code, 0, 10).toLowerCase() !== PROXY_HEAD) return null;
  if (slice(code, 30, PROXY_SIZE).toLowerCase() !== PROXY_TAIL) return null;
  return { template: slice(code, 10, 30), settings: size(code) > PROXY_SIZE ? slice(code, PROXY_SIZE) : '0x' };
}

function isHex(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0;
}

/**
 * Solidity's decoder refuses a `bytes4` whose word has anything after its first four bytes, so
 * the contract would revert where viem's decoder reads on.
 */
function hasCleanSelectorWord(settings: Hex): boolean {
  return size(settings) >= 32 && /^0+$/.test(slice(settings, 4, 32).slice(2));
}

/** The template's rule from its settings, or null when its template can't read them. */
function decodeRule(template: Address, settings: Hex): CheckerRule | null {
  if (!hasCleanSelectorWord(settings)) return null;
  try {
    if (isAddressEqual(template, ARG_IN_TEMPLATE_ADDRESS)) {
      const [selector, slot, allowed] = decodeAbiParameters(
        [{ type: 'bytes4' }, { type: 'uint256' }, { type: 'bytes32[]' }],
        settings
      );
      return { kind: 'argIn', selector, slot, allowed: [...allowed] };
    }
    if (isAddressEqual(template, ARG_AT_MOST_TEMPLATE_ADDRESS)) {
      const [selector, slot, max] = decodeAbiParameters(
        [{ type: 'bytes4' }, { type: 'uint256' }, { type: 'uint256' }],
        settings
      );
      return { kind: 'argAtMost', selector, slot, max };
    }
    const [selector, max] = decodeAbiParameters([{ type: 'bytes4' }, { type: 'uint256' }], settings);
    return { kind: 'valueAtMost', selector, max };
  } catch {
    return null;
  }
}

/**
 * Says what a checker enforces when it is one of ours. A checker is ours only when its template is
 * one of the three and our factory puts the clone of that template with those settings at exactly
 * this address. Reading the template out of the code is not enough: anyone can deploy code shaped
 * like our clone, with any behaviour behind it.
 */
export function readChecker(checker: string, source: CheckerSource): CheckerReading {
  const deploy = source.checkerDeploy;
  const parts =
    deploy && isHex(deploy.template) && size(deploy.template) === 20 && isHex(deploy.settings)
      ? { template: deploy.template as Address, settings: deploy.settings }
      : source.code
        ? fromCloneCode(source.code)
        : null;
  if (!parts) return { status: 'custom' };

  if (!TEMPLATES.some((template) => isAddressEqual(template, parts.template))) return { status: 'custom' };
  if (checker.toLowerCase() !== predictCheckerAddress(parts.template, parts.settings).toLowerCase()) {
    return { status: 'custom' };
  }

  const rule = decodeRule(parts.template, parts.settings);
  return rule ? { status: 'ours', rule } : { status: 'broken' };
}
