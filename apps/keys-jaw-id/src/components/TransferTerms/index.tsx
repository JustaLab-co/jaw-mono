import { formatUnits } from 'viem';
import type { Gas, TransferView } from '../../lib/approval-decision';

const usdc = (units: string) => formatUnits(BigInt(units), 6);

export function GasLine({ gas }: { gas: Gas }) {
  return (
    <p className="text-muted-foreground text-sm">
      Gas, paid in USDC: about {usdc(gas.estimate)} USDC, at most {usdc(gas.max)} USDC
    </p>
  );
}

/** The server's preview, as served: the name the agent gave beside the address it resolved to. */
export function TransferTerms({ preview }: { preview: TransferView['preview'] }) {
  return (
    <>
      <p className="text-sm">
        Send <span className="font-semibold">{usdc(preview.amount)} USDC</span> from this account
      </p>
      <p className="text-muted-foreground break-all text-sm">
        To: {preview.name && <span className="font-semibold">{preview.name} </span>}
        <span className="font-mono">{preview.to}</span>
      </p>
      <p className="text-muted-foreground text-sm">
        Token <span className="font-mono">{preview.token}</span>
      </p>
      <GasLine gas={preview.gas} />
    </>
  );
}
