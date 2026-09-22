'use client';

import { Code } from 'lucide-react';
import { AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion';
import { CopyButton } from '../CopyButton';
import { Eyebrow, PartyRow, Row, ValueAmount } from '../primitives';
import { useDecodedCalldata, type DecodeResult } from '../../hooks/useDecodedCalldata';
import { formatNativeValue } from '../../utils/displayFormat';
import { DecodedCalldataView, callLabel } from './DecodedCalldata';
import { identityKey } from '../../utils';
import type { TransactionData } from './types';

/**
 * Label for a step we couldn't decode. Only a value-bearing call with no calldata is a plain
 * native transfer — the absence of calldata alone doesn't make one, so an empty call stays
 * "Call N" rather than claiming to move funds.
 */
export function stepFallbackLabel(index: number, hasData: boolean, value: string | null): string {
  return !hasData && value ? 'Transfer' : `Call ${index + 1}`;
}

interface DecodeContext {
  chainId: number;
  apiKey?: string;
  resolvedAddresses?: Record<string, string>;
  resolvedAvatars?: Record<string, string>;
  mainnetRpcUrl?: string;
}

/** The single-transaction calldata card, folded behind the decoded call name. */
export function SingleCallData({
  to,
  data,
  decode,
  ...ctx
}: DecodeContext & { to: string; data: string; decode: DecodeResult }) {
  return (
    <AccordionItem value="calldata" className="border-border rounded-box overflow-hidden border">
      <AccordionTrigger className="items-center p-3 hover:no-underline">
        <span className="flex min-w-0 items-center gap-3">
          <span className="border-border bg-secondary rounded-chip flex size-7 flex-none items-center justify-center border">
            <Code className="text-muted-foreground size-3.5" strokeWidth={1.5} />
          </span>
          <span className="flex min-w-0 flex-col items-start">
            <Eyebrow>Calldata</Eyebrow>
            <span className="text-foreground text-value mt-1 truncate">{callLabel(decode, 'Contract call')}</span>
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
  displayContractAddress,
  ...ctx
}: Omit<DecodeContext, 'chainId'> & {
  transaction: TransactionData;
  index: number;
  nativeSymbol: string;
  nativeTokenPrice: number;
  displayContractAddress: (address: string | undefined, chainId: number | undefined) => string;
}) {
  const decode = useDecodedCalldata(transaction.to, transaction.data, transaction.chainId, ctx.apiKey);
  const value = formatNativeValue(transaction.value);
  const hasData = !!transaction.data && transaction.data !== '0x';

  return (
    <AccordionItem value={`transaction-${index}`} className="border-border rounded-box overflow-hidden border">
      <AccordionTrigger className="items-center p-3 hover:no-underline">
        <span className="flex min-w-0 items-center gap-2">
          <span className="bg-secondary text-foreground text-body-xs flex size-5 flex-none items-center justify-center rounded-full font-semibold">
            {index + 1}
          </span>
          <span className="text-foreground text-value truncate">
            {callLabel(decode, transaction.action ?? stepFallbackLabel(index, hasData, value))}
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
              value={displayContractAddress(transaction.to, transaction.chainId)}
              address={transaction.to}
              avatarUrl={
                transaction.to ? ctx.resolvedAvatars?.[identityKey(transaction.to, transaction.chainId)] : undefined
              }
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
