'use client';

import { useMemo, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { SUPPORTED_CHAINS } from '@jaw.id/core';
import { CopyButton } from '../CopyButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import {
  dateTone,
  formatUnixDate,
  groupNumber,
  isStartField,
  isUnixTimestamp,
  maxUintFor,
  type DateTone,
} from '../../utils/displayFormat';

// EIP-712 TypedData structure (mirrors the dialog's local type).
interface TypedData {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

type TreeNode = {
  id: string;
  depth: number;
  label: string;
  kind: 'leaf' | 'group';
  badge?: string; // solidity type (leaves)
  value?: string; // formatted, truncated value (leaves)
  tone?: DateTone; // warning state (leaves): expired → destructive, far/Unlimited/No-expiry → warning
  copyValue?: string; // full untruncated value to copy (address/bytes leaves)
  note?: string; // hover-tooltip text explaining the tone (leaves)
  children?: TreeNode[];
};

const INDENT = 14; // px per depth level
const MAX_DEPTH = 12;

const isArrayType = (type: string) => /\[\d*\]$/.test(type);
const baseType = (type: string) => type.replace(/\[\d*\]$/, '');

/** Network name for a chainId, e.g. "Ethereum · 1"; bare id when unrecognised. */
function networkLabel(id: number): string {
  const chain = SUPPORTED_CHAINS.find((c) => c.id === id);
  return chain ? `${chain.name} · ${id}` : String(id);
}

/**
 * Format a primitive leaf by its solidity type AND field name. The field name
 * lets us render the *meaning* rather than the raw integer: `deadline`→date,
 * `chainId`→network, amount-like→grouped ("Unlimited" at max-uint). We never
 * apply token decimals here (unknown in the raw fallback) — that's clear-signing's
 * job; integers are grouped, not truncated like a hash.
 */
interface FormattedLeaf {
  text: string;
  tone?: DateTone;
  // Raw value to copy when `text` is a derived form (e.g. a date hiding its unix integer).
  copyValue?: string;
  // Hover-tooltip text explaining the tone. Semantic per case (an Unlimited amount and a
  // far-future date both use tone 'far' but must NOT share the same message).
  note?: string;
}

export function formatValue(type: string, value: unknown, fieldName = ''): FormattedLeaf {
  if (value === null || value === undefined) return { text: '—' };
  const name = fieldName.toLowerCase();

  if (type === 'address') {
    const v = String(value);
    return { text: v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v };
  }

  if (/^bytes\d*$/.test(type)) {
    const v = String(value);
    if (v.startsWith('0x')) {
      const byteLen = (v.length - 2) / 2;
      const body = v.length > 20 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v;
      return { text: `${body} ${byteLen}b` };
    }
    return { text: v };
  }

  if (/^(u?int)\d*$/.test(type)) {
    let big: bigint | null = null;
    try {
      big = BigInt(String(value));
    } catch {
      return { text: String(value) };
    }

    if (name === 'chainid' || name.endsWith('chainid')) return { text: networkLabel(Number(big)) };

    const isStart = isStartField(name);
    const isTimestamp =
      isStart || /(deadline|expir|validuntil|validafter|validbefore|validto|notbefore|notafter|timestamp)/.test(name);
    const isAmount = /(amount|value|allowance|limit|balance|price|cost|fee|total|wad|shares|qty)/.test(name);

    const mx = maxUintFor(type);
    if (mx !== null && big === mx) {
      // "No expiry" / "Unlimited" are self-explanatory — warning icon only, no redundant note.
      if (isTimestamp) return { text: 'No expiry', tone: 'far' };
      if (isAmount) return { text: 'Unlimited', tone: 'far' };
    }
    // A start of 0 means valid from the first block, not from 1 Jan 1970.
    if (isStart && big === 0n) return { text: 'Immediately', copyValue: '0' };
    if (isTimestamp && isUnixTimestamp(big)) {
      const tone = dateTone(big, isStart ? 'start' : 'deadline');
      return {
        text: formatUnixDate(big),
        tone: tone === 'normal' ? undefined : tone,
        copyValue: big.toString(),
        note:
          tone === 'expired'
            ? 'This date is in the past.'
            : tone === 'far'
              ? 'More than a year in the future.'
              : undefined,
      };
    }

    return { text: groupNumber(big.toString()) };
  }

  if (type === 'bool') return { text: String(value) };

  const v = String(value);
  return { text: v.length > 80 ? `${v.slice(0, 78)}…` : v };
}

/** Build one node (recursively for structs/arrays) from a type + value. */
function buildNode(
  types: TypedData['types'],
  type: string,
  value: unknown,
  label: string,
  id: string,
  depth: number
): TreeNode {
  if (depth > MAX_DEPTH) {
    return { id, depth, label, kind: 'leaf', badge: type, value: '…' };
  }

  if (isArrayType(type)) {
    const base = baseType(type);
    const arr = Array.isArray(value) ? value : [];
    return {
      id,
      depth,
      label,
      kind: 'group',
      // Generic index labels — never derive from the element's struct type name.
      children: arr.map((el, i) => buildNode(types, base, el, `[${i}]`, `${id}[${i}]`, depth + 1)),
    };
  }

  // Struct
  const fields = types[type];
  if (fields) {
    if (value === null || value === undefined) {
      return { id, depth, label, kind: 'leaf', value: 'None' };
    }
    const obj = value as Record<string, unknown>;
    return {
      id,
      depth,
      label,
      kind: 'group',
      children: fields.map((f) => buildNode(types, f.type, obj?.[f.name], f.name, `${id}.${f.name}`, depth + 1)),
    };
  }

  // Leaf. Keep the full value to copy whenever the display is truncated — addresses,
  // bytes, and any long string/value that formatValue shortened.
  const raw = value == null ? undefined : String(value);
  const copyable = raw != null && (type === 'address' || /^bytes\d*$/.test(type) || raw.length > 60);
  const formatted = formatValue(type, value, label);
  return {
    id,
    depth,
    label,
    kind: 'leaf',
    badge: type,
    value: formatted.text,
    tone: formatted.tone,
    note: formatted.note,
    // Derived leaves (dates) carry their own raw copy value; else the truncation rule.
    copyValue: formatted.copyValue ?? (copyable ? raw : undefined),
  };
}

/** Depth-ordered guide rails behind the row content. */
function Spines({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="bg-foreground/[0.08] absolute bottom-0 top-0 w-px"
          style={{ left: 9 + 3 + i * INDENT }}
        />
      ))}
    </>
  );
}

/** Right-aligned leaf value with an optional copy button (address/bytes) and deadline tone. */
function LeafValue({
  display,
  copyValue,
  tone,
  note,
}: {
  display?: string;
  copyValue?: string;
  tone?: DateTone;
  note?: string;
}) {
  const toneClass = tone === 'expired' ? 'text-destructive' : tone === 'far' ? 'text-warning' : 'text-foreground';
  const showIcon = tone === 'expired' || tone === 'far';
  return (
    <span className="ml-auto flex min-w-0 items-center justify-end gap-1">
      {showIcon &&
        (note ? (
          // Icon reveals the note on hover (dates: why it's flagged).
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Hover-only (no tabIndex) so it doesn't auto-open when a dialog focuses in. */}
              <span aria-label={note} className="flex-none cursor-help">
                <TriangleAlert className={`size-3 ${toneClass}`} strokeWidth={2} />
              </span>
            </TooltipTrigger>
            <TooltipContent>{note}</TooltipContent>
          </Tooltip>
        ) : (
          // Self-explanatory (Unlimited / No expiry) — icon only, no note.
          <TriangleAlert className={`size-3 flex-none ${toneClass}`} strokeWidth={2} />
        ))}
      <span className={`text-body-xs min-w-0 break-all text-right font-mono font-medium ${toneClass}`}>{display}</span>
      {copyValue && <CopyButton value={copyValue} size={12} resetAfterMs={1500} label="Copy value" />}
    </span>
  );
}

const Caret = ({ open }: { open: boolean }) => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="text-muted-foreground flex-none transition-transform"
    style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/**
 * Decoded EIP-712 tree: walks the primaryType's fields against the message,
 * annotating each with its solidity type and truncating hex/number values.
 * Structs and arrays are collapsible; guide rails mark nesting depth.
 */
export function Eip712Tree({ typedData }: { typedData: TypedData }) {
  const rootNodes = useMemo(() => {
    // Optional-chained, not indexed: an absent `types` threw here before the caller's
    // shape check existed, and a throw mid-render strands the signing request.
    const types = typedData?.types ?? {};
    const fields = types[typedData?.primaryType] ?? [];
    return fields.map((f) => buildNode(types, f.type, typedData.message?.[f.name], f.name, f.name, 0));
  }, [typedData]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Flatten to the visible rows honoring collapse state.
  const rows: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      rows.push(n);
      if (n.kind === 'group' && n.children && !collapsed.has(n.id)) walk(n.children);
    }
  };
  walk(rootNodes);

  return (
    <div className="border-border rounded-box overflow-hidden border">
      <div className="border-border/40 border-b px-3 py-2">
        <span className="text-muted-foreground text-label font-mono uppercase">{typedData.primaryType}</span>
      </div>
      <div>
        {rows.map((r, i) => {
          const pad = r.depth * INDENT;
          const border = i === 0 ? '' : 'border-border/40 border-t';
          if (r.kind === 'group') {
            const open = !collapsed.has(r.id);
            return (
              <button
                key={r.id}
                onClick={() => toggle(r.id)}
                className={`hover:bg-foreground/[0.03] relative flex w-full items-center gap-1.5 py-2 pr-3 text-left ${border}`}
                style={{ paddingLeft: 9 + pad }}
              >
                <Spines depth={r.depth} />
                <Caret open={open} />
                <span className="text-foreground/90 text-code font-mono font-medium">{r.label}</span>
              </button>
            );
          }
          return (
            <div key={r.id} className={`relative py-2 pl-2 pr-3 ${border}`}>
              <Spines depth={r.depth} />
              <div className="flex items-center gap-1.5" style={{ paddingLeft: pad }}>
                <span className="text-muted-foreground text-code flex-none font-mono font-medium">{r.label}</span>
                {/* 7px is below the 9px floor every type role observes — kept because this badge
                    carries the Solidity type beside a dense tree row, where the role's 9px pushes
                    the row taller. The only sub-9px value in the package; see tailwind.config.js. */}
                {r.badge && (
                  <span className="text-muted-foreground/70 bg-foreground/5 rounded-xs flex-none px-1 py-px font-mono text-[7px] font-medium">
                    {r.badge}
                  </span>
                )}
                <LeafValue display={r.value} copyValue={r.copyValue} tone={r.tone} note={r.note} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
