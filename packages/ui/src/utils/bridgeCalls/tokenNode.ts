// A node that answers symbol() and decimals() for the tokens it is given, for tests.
import { createPublicClient, custom, encodeAbiParameters, stringToHex, type Address, type Hex } from 'viem';

export const SYMBOL = '0x95d89b41';
export const DECIMALS = '0x313ce567';

export type Answer = {
  symbol?: string;
  decimals?: bigint;
  code?: false;
  revert?: 'symbol' | 'decimals';
  hang?: true;
  /** Answers `symbol()` as a bytes32 word, like MKR, instead of a string. */
  bytes32?: true;
  /** Answers `symbol()` with these exact bytes. */
  symbolBytes?: Hex;
};

// The node's side of eth_call: viem encodes the request and decodes the answer as it would for a real one.
export function nodeFor(answers: Record<string, Answer>, asked: string[] = []) {
  const client = createPublicClient({
    transport: custom(
      {
        async request({ method, params }) {
          if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
          const { to, data } = (params as [{ to: Address; data: string }])[0];
          asked.push(`${to.toLowerCase()} ${data}`);
          const answer = answers[to.toLowerCase()];
          if (!answer || answer.code === false) return '0x';
          if (answer.hang) return new Promise(() => undefined);
          if (data === SYMBOL) {
            if (answer.revert === 'symbol') throw new Error('execution reverted');
            if (answer.symbolBytes) return answer.symbolBytes;
            if (answer.bytes32) return stringToHex(answer.symbol ?? '', { size: 32 });
            return encodeAbiParameters([{ type: 'string' }], [answer.symbol ?? '']);
          }
          if (answer.revert === 'decimals') throw new Error('execution reverted');
          return encodeAbiParameters([{ type: 'uint256' }], [answer.decimals ?? 0n]);
        },
      },
      { retryCount: 0 }
    ),
  });
  return () => client;
}
