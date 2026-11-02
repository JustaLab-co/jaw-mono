import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import { decodeWithAbi } from './useDecodedCalldata';

const abi4 = parseAbi(['function depositErc20(address depositor, address token, uint256 amount, bytes32 id)']);
const abi3 = parseAbi(['function depositErc20(address depositor, address token, bytes32 id)']);

const data = encodeFunctionData({
  abi: abi4,
  functionName: 'depositErc20',
  args: [
    '0xfAbc9dDe6d43b39E087122A80f05E80615110b65',
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    2000000n,
    '0x10483249e9edca4aa45c8cf3ed823f1a87145e338bf684c9cfe4daf1285546d3',
  ],
});

describe('decodeWithAbi', () => {
  it('uses the overload the selector names, not the first one with the same name', () => {
    const decoded = decodeWithAbi([...abi3, ...abi4], data);
    expect(decoded?.signature).toBe('depositErc20(address, address, uint256, bytes32)');
    expect(decoded?.params.map((p) => [p.type, p.value])).toEqual([
      ['address', '0xfAbc9dDe6d43b39E087122A80f05E80615110b65'],
      ['address', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
      ['uint256', '2000000'],
      ['bytes32', '0x10483249e9edca4aa45c8cf3ed823f1a87145e338bf684c9cfe4daf1285546d3'],
    ]);
  });

  it('returns null when the calldata carries bytes the signature does not encode', () => {
    expect(decodeWithAbi(abi4, `${data}00`)).toBeNull();
  });

  it('returns null when no ABI entry has the selector', () => {
    expect(decodeWithAbi(abi3, data)).toBeNull();
  });
});
