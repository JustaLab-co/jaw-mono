import {
  formatEther,
  formatUnits,
  getAddress,
  parseAbiItem,
  slice,
  toFunctionSelector,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
} from 'viem';

import type { CheckerRule } from './checkerRule';
import { groupNumber } from './displayFormat';

/** A piece of a rule's sentence: text, an address the screen draws as one, or the granting wallet. */
export type RulePart = string | { address: Address } | { wallet: true };

/**
 * How the grant screen states a checker's rule. `blocks` is a rule that can never pass a call to
 * the function it guards: an empty list, or a rule written for a different function.
 */
export type RuleText = { tone: 'rule'; parts: RulePart[] } | { tone: 'blocks' };

/** An ERC-7730 descriptor's format for the function: its named signature and the labels it gives fields. */
export interface CallDescriptor {
  formatKey: string;
  fields: ReadonlyArray<{ path?: string; label?: string }>;
}

/** The function a rule guards, as the grant names it. */
export interface RuleCall {
  selector?: string;
  signature?: string;
  descriptor?: CallDescriptor;
}

/** `ACCOUNT` in the call-checkers contracts: in an ArgIn list it stands for the wallet running the call. */
const ACCOUNT_WORD = '0x000000000000000000000000acc0acc0acc0acc0acc0acc0acc0acc0acc0acc0';
const ANY_FN_SEL = '0x32323232';

/** The ERC-20 functions, named by the standard, for a call whose signature carries no names. */
const ERC20: Record<string, { name: string; args: string[]; amountSlot: number }> = {
  '0xa9059cbb': { name: 'transfer', args: ['to', 'amount'], amountSlot: 1 },
  '0x095ea7b3': { name: 'approve', args: ['spender', 'amount'], amountSlot: 1 },
  '0x23b872dd': { name: 'transferFrom', args: ['from', 'to', 'amount'], amountSlot: 2 },
  '0x39509351': { name: 'increaseAllowance', args: ['spender', 'amount'], amountSlot: 1 },
  '0xa457c2d7': { name: 'decreaseAllowance', args: ['spender', 'amount'], amountSlot: 1 },
};

/** Whether `selector` is one of the ERC-20 functions, so the call's target is the token it moves. */
export function isErc20Function(selector: string): boolean {
  return selector.toLowerCase() in ERC20;
}

/** Whether `slot` of `selector` is the amount of an ERC-20 function, so it counts the target token. */
export function isTokenAmount(selector: string, slot: bigint): boolean {
  const erc20 = ERC20[selector.toLowerCase()];
  return !!erc20 && BigInt(erc20.amountSlot) === slot;
}

type Slot = { path: string[]; type: string };

function isDynamic(param: AbiParameter): boolean {
  const { type } = param;
  if (type === 'string' || type === 'bytes' || type.endsWith('[]')) return true;
  const fixed = type.match(/^(.*)\[(\d+)\]$/);
  if (fixed) return isDynamic({ ...param, type: fixed[1] } as AbiParameter);
  if (type === 'tuple') {
    return ((param as { components?: readonly AbiParameter[] }).components ?? []).some(isDynamic);
  }
  return false;
}

/**
 * The 32-byte words a call's arguments start with, in order, each with the path and type of the
 * value it holds. A fixed-size struct or array sits inline, a word per field; anything of
 * variable size takes one word, an offset to where it really is.
 */
function slotsOf(signature: string | undefined): Slot[] | null {
  if (!signature) return null;
  let item: AbiFunction;
  try {
    item = parseAbiItem(`function ${signature}`) as AbiFunction;
  } catch {
    return null;
  }
  const slots: Slot[] = [];
  const walk = (param: AbiParameter, path: string[]) => {
    const fixed = param.type.match(/^(.*)\[(\d+)\]$/);
    if (isDynamic(param)) {
      slots.push({ path, type: param.type });
    } else if (fixed) {
      for (let i = 0; i < Number(fixed[2]); i++)
        walk({ ...param, type: fixed[1] } as AbiParameter, [...path, `[${i}]`]);
    } else if (param.type === 'tuple') {
      for (const field of (param as { components: readonly AbiParameter[] }).components) {
        walk(field, [...path, field.name ?? '']);
      }
    } else {
      slots.push({ path, type: param.type });
    }
  };
  item.inputs.forEach((param) => walk(param, [param.name ?? '']));
  return slots;
}

/** The name a reader knows the value by: its own field name, with any array index after it. */
function nameOf(path: string[]): string | null {
  if (path.some((part) => part === '')) return null;
  let name = '';
  for (const part of path) name = part.startsWith('[') ? `${name}${part}` : part;
  return name || null;
}

const descriptorPath = (path: string | undefined) => path?.replace(/^#\./, '');

/**
 * The argument a rule reads at `slot`, named rather than numbered when anything can name it: the
 * call's own signature, then the contract's clear-signing descriptor, then the ERC-20 standard.
 * Counted from one only when none of them does.
 */
export function argumentAt(slot: bigint, call: RuleCall): { label: string; type?: string } {
  const index = Number(slot);
  const own = slotsOf(call.signature)?.[index];
  const described = call.descriptor ? slotsOf(call.descriptor.formatKey)?.[index] : undefined;
  const type = own?.type ?? described?.type ?? undefined;
  const typed = (label: string) => (type ? { label, type } : { label });

  const ownName = own && nameOf(own.path);
  if (ownName) return typed(ownName);

  if (described && call.descriptor) {
    const joined = described.path.join('.');
    const field = call.descriptor.fields.find((f) => descriptorPath(f.path) === joined && f.label);
    if (field?.label) return typed(field.label);
    const describedName = nameOf(described.path);
    if (describedName) return typed(describedName);
  }

  const erc20 = call.selector ? ERC20[call.selector.toLowerCase()] : undefined;
  if (erc20 && index < erc20.args.length) return typed(erc20.args[index]);

  return typed(`argument ${index + 1}`);
}

/** One allowed word, shown the way its argument's type reads it. */
function valueOf(word: Hex, type: string | undefined): RulePart {
  if (word.toLowerCase() === ACCOUNT_WORD) return { wallet: true };
  const high = word.slice(2, 26);
  const looksLikeAddress = /^0+$/.test(high);
  if (type === 'address' || (type === undefined && looksLikeAddress && BigInt(word) !== 0n)) {
    return looksLikeAddress ? { address: getAddress(slice(word, 12)) } : word;
  }
  if (type?.startsWith('uint')) return groupNumber(BigInt(word).toString());
  if (type?.startsWith('int')) {
    const bits = Number(type.slice(3) || '256');
    return groupNumber(BigInt.asIntN(bits, BigInt(word)).toString());
  }
  if (type === 'bool') return BigInt(word) === 0n ? 'false' : BigInt(word) === 1n ? 'true' : word;
  const bytes = type?.match(/^bytes(\d+)$/);
  if (bytes) return slice(word, 0, Number(bytes[1]));
  return word;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function selectorOf(call: RuleCall): string | undefined {
  if (call.selector) return call.selector.toLowerCase();
  if (!call.signature) return undefined;
  try {
    return toFunctionSelector(`function ${call.signature}`).toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * A checker's rule in the words the grant screen shows, from what the contract will actually check.
 * The argument is named from the call it guards, and each value is shown as its type reads it.
 */
export function describeRule(
  rule: CheckerRule,
  context: { call: RuleCall; token?: { decimals: number; symbol: string }; nativeSymbol: string }
): RuleText {
  const callSelector = selectorOf(context.call);
  const anyFunction = callSelector === ANY_FN_SEL;
  if (callSelector && !anyFunction && callSelector !== rule.selector.toLowerCase()) return { tone: 'blocks' };

  // Under "any function" the call says nothing about the rule's function, so only the rule names it.
  const call: RuleCall = anyFunction ? { selector: rule.selector } : { ...context.call, selector: rule.selector };

  let sentence: RulePart[];
  if (rule.kind === 'argIn') {
    if (rule.allowed.length === 0) return { tone: 'blocks' };
    const { label, type } = argumentAt(rule.slot, call);
    const values = rule.allowed.map((word) => valueOf(word, type));
    const list = values.flatMap((value, i) => (i === 0 ? [value] : [', ', value]));
    sentence = [`${label} must be `, ...(values.length > 1 ? ['one of ', ...list] : list)];
  } else if (rule.kind === 'argAtMost') {
    const { label } = argumentAt(rule.slot, call);
    const cap =
      context.token && isTokenAmount(rule.selector, rule.slot)
        ? `${groupNumber(formatUnits(rule.max, context.token.decimals))} ${context.token.symbol}`
        : groupNumber(rule.max.toString());
    sentence = [`${label} at most ${cap} per call`];
  } else {
    sentence = [`Sends at most ${groupNumber(formatEther(rule.max))} ${context.nativeSymbol} per call`];
  }

  if (anyFunction) {
    const name = ERC20[rule.selector.toLowerCase()]?.name ?? rule.selector;
    const [first, ...rest] = sentence;
    return { tone: 'rule', parts: [`Only ${name}, where `, first, ...rest] };
  }
  const [first, ...rest] = sentence;
  return { tone: 'rule', parts: [typeof first === 'string' ? capitalize(first) : first, ...rest] };
}
