import {
  formatEther,
  formatUnits,
  getAddress,
  parseAbi,
  parseAbiItem,
  slice,
  toFunctionSelector,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
} from 'viem';
import { ANY_FN_SEL, EMPTY_CALLDATA_FN_SEL } from '@jaw.id/core';

import type { CheckerRule } from './checkerRule';
import { groupNumber } from './displayFormat';

/** A piece of a rule's sentence: text, an address the screen draws as one, or the granting wallet. */
export type RulePart = string | { address: Address } | { wallet: true };

/**
 * How the grant screen states a checker it has read.
 * - `rule`: what the contract enforces, in words.
 * - `blocks`: a rule that can never pass a call to the function it guards.
 * - `custom`: a checker, or a rule of ours, whose effect the screen can't state truthfully.
 */
export type RuleText = { tone: 'rule'; parts: RulePart[] } | { tone: 'blocks' } | { tone: 'custom' };

/** An ERC-7730 descriptor's format for the function: its named signature and the labels it gives fields. */
export interface CallDescriptor {
  formatKey: string;
  fields: ReadonlyArray<{ path?: string; label?: string }>;
}

/** The function a rule guards, as the grant names it. */
export interface RuleCall {
  selector?: string;
  /** The dapp's own signature. Its types are bound to the selector; its parameter names are not. */
  signature?: string;
  descriptor?: CallDescriptor;
}

/** `ACCOUNT` in the call-checkers contracts: in an ArgIn list it stands for the wallet running the call. */
const ACCOUNT_WORD = '0x000000000000000000000000acc0acc0acc0acc0acc0acc0acc0acc0acc0acc0';

/** The ERC-20 functions with the standard's own parameter names, keyed by selector. */
const ERC20 = new Map(
  parseAbi([
    'function transfer(address to, uint256 amount)',
    'function approve(address spender, uint256 amount)',
    'function transferFrom(address from, address to, uint256 amount)',
    'function increaseAllowance(address spender, uint256 amount)',
    'function decreaseAllowance(address spender, uint256 amount)',
  ]).map((item) => [toFunctionSelector(item).toLowerCase(), item as AbiFunction])
);

/** Whether `selector` is one of the ERC-20 functions, so the call's target is the token it moves. */
export function isErc20Function(selector: string): boolean {
  return ERC20.has(selector.toLowerCase());
}

/** Whether `slot` of `selector` is the amount of an ERC-20 function, so it counts the target token. */
export function isTokenAmount(selector: string, slot: bigint): boolean {
  return ERC20.get(selector.toLowerCase())?.inputs[Number(slot)]?.name === 'amount';
}

type Slot = { path: string[]; type: string; dynamic: boolean };

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

function parseSignature(signature: string | undefined): AbiFunction | null {
  if (!signature) return null;
  try {
    return parseAbiItem(`function ${signature}`) as AbiFunction;
  } catch {
    return null;
  }
}

/**
 * The 32-byte words a call's arguments start with, in order, each with the path and type of the
 * value it holds. A fixed-size struct or array sits inline, a word per field. Anything of variable
 * size takes one word, an offset to where it really is, so a rule on it checks the offset.
 */
function slotsOf(item: AbiFunction | null): Slot[] | null {
  if (!item) return null;
  const slots: Slot[] = [];
  const walk = (param: AbiParameter, path: string[]) => {
    const fixed = param.type.match(/^(.*)\[(\d+)\]$/);
    if (isDynamic(param)) {
      slots.push({ path, type: param.type, dynamic: true });
    } else if (fixed) {
      for (let i = 0; i < Number(fixed[2]); i++)
        walk({ ...param, type: fixed[1] } as AbiParameter, [...path, `[${i}]`]);
    } else if (param.type === 'tuple') {
      for (const field of (param as { components: readonly AbiParameter[] }).components) {
        walk(field, [...path, field.name ?? '']);
      }
    } else {
      slots.push({ path, type: param.type, dynamic: false });
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

/** The argument a rule reads at a slot: what to call it, its type, and whether a rule on it is readable. */
export interface RuleArgument {
  label: string;
  type?: string;
  /** The slot holds an offset to a variable-size value, so the rule checks the offset, not the value. */
  dynamic?: boolean;
  /** The function's arguments end before this slot, so the rule reads whatever data follows them. */
  beyondArguments?: boolean;
}

/**
 * The argument a rule reads at `slot`, named by sources the dapp doesn't control: the contract's
 * clear-signing descriptor, then the ERC-20 standard. A name the dapp's own signature gives is
 * shown as the app's, since nothing binds it to the function. Counted from one when nothing names it.
 */
export function argumentAt(slot: bigint, call: RuleCall): RuleArgument {
  const index = Number(slot);
  const erc20 = call.selector ? (ERC20.get(call.selector.toLowerCase()) ?? null) : null;
  const sources = {
    descriptor: call.descriptor ? slotsOf(parseSignature(call.descriptor.formatKey)) : null,
    erc20: slotsOf(erc20),
    own: slotsOf(parseSignature(call.signature)),
  };
  // Types are bound to the selector whichever source states them, so the first one that has
  // the function's arguments decides where they end.
  const known = sources.descriptor ?? sources.erc20 ?? sources.own;
  const at = known?.[index];
  const facts = {
    ...(at ? { type: at.type } : {}),
    ...(at?.dynamic ? { dynamic: true } : {}),
    ...(known && !at ? { beyondArguments: true } : {}),
  };

  const described = sources.descriptor?.[index];
  if (described && call.descriptor) {
    const joined = described.path.join('.');
    const field = call.descriptor.fields.find((f) => descriptorPath(f.path) === joined && f.label);
    if (field?.label) return { label: field.label, ...facts };
    const name = nameOf(described.path);
    if (name) return { label: name, ...facts };
  }
  const standard = sources.erc20?.[index];
  const standardName = standard && nameOf(standard.path);
  if (standardName) return { label: standardName, ...facts };

  const ownName = sources.own?.[index] && nameOf(sources.own[index].path);
  const position = `argument ${index + 1}`;
  return { label: ownName ? `${position} (the app calls it “${ownName}”)` : position, ...facts };
}

/**
 * One allowed word as its argument's type reads it, or null when no valid argument of that type
 * is encoded as that word, so it can never match.
 */
function valueOf(word: Hex, type: string | undefined): RulePart | null {
  if (word.toLowerCase() === ACCOUNT_WORD) return { wallet: true };
  const value = BigInt(word);
  if (type === 'address') return value < 2n ** 160n ? { address: getAddress(slice(word, 12)) } : null;
  const uint = type?.match(/^uint(\d*)$/);
  if (uint) return value < 2n ** BigInt(uint[1] || 256) ? groupNumber(value.toString()) : null;
  const int = type?.match(/^int(\d*)$/);
  if (int) {
    const signed = BigInt.asIntN(Number(int[1] || 256), value);
    // Solidity encodes a negative value sign-extended to the whole word; any other word isn't one.
    return BigInt.asUintN(256, signed) === value ? groupNumber(signed.toString()) : null;
  }
  if (type === 'bool') return value === 0n ? 'false' : value === 1n ? 'true' : null;
  const bytes = type?.match(/^bytes(\d+)$/);
  if (bytes) {
    const size = Number(bytes[1]);
    return /^0*$/.test(word.slice(2 + size * 2)) ? slice(word, 0, size) : null;
  }
  return word;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function selectorOf(call: RuleCall): string | undefined {
  if (call.selector) return call.selector.toLowerCase();
  const item = parseSignature(call.signature);
  return item ? toFunctionSelector(item).toLowerCase() : undefined;
}

/** What the rule's function is called when it guards "any function". */
function functionName(selector: Hex): string {
  if (selector.toLowerCase() === EMPTY_CALLDATA_FN_SEL.toLowerCase()) return 'plain transfers';
  return ERC20.get(selector.toLowerCase())?.name ?? selector;
}

/**
 * A checker's rule in the words the grant screen shows, stating only what the contract will check.
 * Where the contract would check something other than what the words would say (an offset, data
 * past the arguments, a number compared across types), it is a custom check instead.
 */
export function describeRule(
  rule: CheckerRule,
  context: { call: RuleCall; token?: { decimals: number; symbol: string }; nativeSymbol: string }
): RuleText {
  const callSelector = selectorOf(context.call);
  const anyFunction = callSelector === ANY_FN_SEL.toLowerCase();
  // Every template first requires the call to be to its own function, so on any other it blocks.
  if (callSelector && !anyFunction && callSelector !== rule.selector.toLowerCase()) return { tone: 'blocks' };

  if (rule.kind === 'valueAtMost') {
    const amount = `${groupNumber(formatEther(rule.max))} ${context.nativeSymbol}`;
    return {
      tone: 'rule',
      parts: [
        anyFunction
          ? `Only ${functionName(rule.selector)}, sending at most ${amount} per call`
          : `Sends at most ${amount} per call`,
      ],
    };
  }

  // A plain transfer has no arguments, so a rule that reads one never passes it.
  if (rule.selector.toLowerCase() === EMPTY_CALLDATA_FN_SEL.toLowerCase()) return { tone: 'blocks' };

  // Under "any function" the call says nothing about the rule's function, so only the rule names it.
  const call: RuleCall = anyFunction ? { selector: rule.selector } : { ...context.call, selector: rule.selector };
  const argument = argumentAt(rule.slot, call);
  if (argument.dynamic || argument.beyondArguments) return { tone: 'custom' };

  let sentence: RulePart[];
  if (rule.kind === 'argIn') {
    const values = rule.allowed.map((word) => valueOf(word, argument.type)).filter((v): v is RulePart => v !== null);
    if (values.length === 0) return { tone: 'blocks' };
    const list = values.flatMap((value, i) => (i === 0 ? [value] : [', ', value]));
    sentence = [`${argument.label} must be `, ...(values.length > 1 ? ['one of ', ...list] : list)];
  } else {
    const tokenAmount = isTokenAmount(rule.selector, rule.slot);
    const cap = tokenAmount
      ? context.token
        ? `${groupNumber(formatUnits(rule.max, context.token.decimals))} ${context.token.symbol}`
        : `${groupNumber(rule.max.toString())} base units`
      : groupNumber(rule.max.toString());
    const type = argument.type;
    // The contract compares the word as an unsigned number. For a signed argument every negative
    // value is a huge one, so only 0 to the cap passes; for any other type the number means nothing.
    if (type === undefined || /^uint\d*$/.test(type)) sentence = [`${argument.label} at most ${cap} per call`];
    else if (/^int\d*$/.test(type)) sentence = [`${argument.label} from 0 to ${cap} per call`];
    else return { tone: 'custom' };
  }

  if (anyFunction) return { tone: 'rule', parts: [`Only ${functionName(rule.selector)}, where `, ...sentence] };
  const [first, ...rest] = sentence;
  return { tone: 'rule', parts: [typeof first === 'string' ? capitalize(first) : first, ...rest] };
}
