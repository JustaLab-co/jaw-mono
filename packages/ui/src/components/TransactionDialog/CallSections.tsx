'use client';

import { Code } from 'lucide-react';
import { AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion';
import { CopyButton } from '../CopyButton';
import { Eyebrow, InlineWarning, PartyRow, Row, ValueAmount } from '../primitives';
import { useAddressIdentity, type IdentitySource } from '../../hooks/useAddressIdentities';
import { useDecodedCalldata, type DecodeResult } from '../../hooks/useDecodedCalldata';
import { formatNativeValue } from '../../utils/displayFormat';
import { DecodedCalldataView, callLabel } from './DecodedCalldata';
import type { Detail } from '../../utils/bridgeCalls/transfer';
import type { TransactionData } from './types';

/**
 * Label for a step we couldn't decode. Only a value-bearing call with no calldata is a plain
 * native transfer — the absence of calldata alone doesn't make one, so an empty call stays
 * "Call N" rather than claiming to move funds.
 */
export function stepFallbackLabel(index: number, hasData: boolean, value: string | null): string {
  return !hasData && value ? 'Transfer' : `Call ${index + 1}`;
}

/** Who a call goes to reads by name only: ENS, else the clear-signing name. Token reads would show nothing here. */
export const NAME_SOURCES: readonly IdentitySource[] = ['ens', 'clearSigning'];

interface DecodeContext {
  chainId: number;
  apiKey?: string;
  mainnetRpcUrl: string;
}

interface StepOverride {
  label?: string;
  alert?: string;
}

function StepAlert({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div role="alert" className="px-3 pt-3">
      <InlineWarning text={text} />
    </div>
  );
}

/** The single-transaction calldata card, folded behind the decoded call name. */
export function SingleCallData({
  to,
  data,
  decode,
  label,
  alert,
  ...ctx
}: DecodeContext & StepOverride & { to: string; data: string; decode: DecodeResult }) {
  return (
    <AccordionItem value="calldata" className="border-border rounded-box overflow-hidden border">
      <StepAlert text={alert} />
      <AccordionTrigger className="items-center p-3 hover:no-underline">
        <span className="flex min-w-0 items-center gap-3">
          <span className="border-border bg-secondary rounded-chip flex size-7 flex-none items-center justify-center border">
            <Code className="text-muted-foreground size-3.5" strokeWidth={1.5} />
          </span>
          <span className="flex min-w-0 flex-col items-start">
            <Eyebrow>Calldata</Eyebrow>
            <span className="text-foreground text-value mt-1 truncate">
              {label ?? callLabel(decode, 'Contract call')}
            </span>
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-end">
            <CopyButton value={data} label="Copy calldata" />
          </div>
          <DecodedCalldataView to={to} data={data} decode={decode} {...ctx} />
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

/** One numbered batch step, headed by its decoded action name. */
export function BatchStep({
  transaction,
  index,
  nativeSymbol,
  nativeTokenPrice,
  label,
  alert,
  ...ctx
}: Omit<DecodeContext, 'chainId'> &
  StepOverride & {
    transaction: TransactionData;
    index: number;
    nativeSymbol: string;
    nativeTokenPrice: number;
  }) {
  const decode = useDecodedCalldata(transaction.to, transaction.data, transaction.chainId, ctx.apiKey);
  const target = useAddressIdentity(transaction.to, transaction.chainId, {
    mainnetRpcUrl: ctx.mainnetRpcUrl,
    apiKey: ctx.apiKey,
    include: NAME_SOURCES,
  });
  const value = formatNativeValue(transaction.value);
  const hasData = !!transaction.data && transaction.data !== '0x';

  return (
    <AccordionItem value={`transaction-${index}`} className="border-border rounded-box overflow-hidden border">
      <StepAlert text={alert} />
      <AccordionTrigger className="items-center p-3 hover:no-underline">
        <span className="flex min-w-0 items-center gap-2">
          <span className="bg-secondary text-foreground text-body-xs flex size-5 flex-none items-center justify-center rounded-full font-semibold">
            {index + 1}
          </span>
          <span className="text-foreground text-value truncate">
            {label ?? callLabel(decode, transaction.action ?? stepFallbackLabel(index, hasData, value))}
          </span>
          {/* Native value in the header, so a collapsed step still shows what it moves.
              Token amounts live in the calldata, so they only appear once expanded. */}
          {value && (
            <span className="text-muted-foreground text-body-sm flex-none font-mono">
              {value} {nativeSymbol}
            </span>
          )}
        </span>
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-3">
        <div className="flex flex-col gap-3">
          <div className="border-border rounded-box border p-3">
            <PartyRow
              label="Interacting with"
              value={target?.label ?? ''}
              address={transaction.to}
              avatarUrl={target?.ensAvatar ?? undefined}
            />
          </div>

          {value && (
            <Row label="Value">
              <ValueAmount
                amount={value}
                symbol={nativeSymbol}
                price={nativeTokenPrice}
                className="text-foreground text-value font-mono font-semibold"
              />
            </Row>
          )}

          {hasData && (
            <div className="border-border rounded-box flex flex-col gap-2 border p-3">
              <div className="flex items-center justify-between">
                <Eyebrow>Data</Eyebrow>
                <CopyButton value={transaction.data ?? ''} label="Copy calldata" />
              </div>
              <DecodedCalldataView
                to={transaction.to}
                data={transaction.data as string}
                chainId={transaction.chainId}
                decode={decode}
                {...ctx}
              />
            </div>
          )}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

export function BridgeDetails({ details }: { details: readonly Detail[] }) {
  return (
    <AccordionItem value="details" className="border-border rounded-box overflow-hidden border">
      <AccordionTrigger className="items-center p-3 hover:no-underline">
        <span className="text-foreground text-heading">Details</span>
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-3">
        <dl className="divide-border/40 flex flex-col divide-y">
          {details.map(({ label, value, copy }) => (
            <div key={label} className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <dt className="text-muted-foreground text-body-sm flex-none font-medium">{label}</dt>
              <dd className="text-foreground text-body-sm flex min-w-0 items-start justify-end gap-1.5 text-right font-mono">
                <span className="[overflow-wrap:anywhere]">{value}</span>
                {copy && <CopyButton value={copy} size={12} label={`Copy ${label.toLowerCase()}`} />}
              </dd>
            </div>
          ))}
        </dl>
      </AccordionContent>
    </AccordionItem>
  );
}
