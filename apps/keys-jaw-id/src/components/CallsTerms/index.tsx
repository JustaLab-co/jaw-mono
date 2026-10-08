import { formatEther } from 'viem';
import type { CallWarning, CallsView } from '../../lib/approval-decision';
import { GasLine } from '../TransferTerms';

function warningText(warning: CallWarning) {
  switch (warning.code) {
    case 'unknown_function':
      return 'No known function matches this call. Check the raw calldata against where it came from.';
    case 'short_calldata':
      return 'The calldata is shorter than a function selector.';
    case 'token_approval':
      return `Lets ${warning.spender} spend ${warning.unlimited ? 'an unlimited amount' : `${warning.amount} base units`} of the token at this address.`;
  }
}

/** The server's preview, as served: each call decoded where an ABI matched, raw otherwise. */
export function CallsTerms({ preview }: { preview: CallsView['preview'] }) {
  return (
    <>
      <p className="text-sm">
        Run {preview.calls.length === 1 ? 'this call' : `these ${preview.calls.length} calls`} from this account,
        together
      </p>
      {preview.calls.map((call, i) => (
        <div key={i} data-testid="approval-call" className="flex flex-col gap-1 rounded border p-3">
          <p className="text-muted-foreground break-all text-xs">
            To <span className="font-mono">{call.to}</span>
          </p>
          {BigInt(call.value) > 0n && <p className="text-sm">Sends {formatEther(BigInt(call.value))} ETH</p>}
          {call.function ? (
            <>
              <p className="font-mono text-sm">{call.function}</p>
              {call.args?.map((arg) => (
                <p key={arg.name} className="text-muted-foreground break-all font-mono text-xs">
                  {arg.name}: {arg.value}
                </p>
              ))}
            </>
          ) : (
            <pre className="bg-muted whitespace-pre-wrap break-all rounded p-2 text-xs">{call.data}</pre>
          )}
          {call.warnings.map((warning) => (
            <p key={warning.code} className="text-destructive text-sm">
              {warningText(warning)}
            </p>
          ))}
        </div>
      ))}
      <GasLine gas={preview.gas} />
    </>
  );
}
