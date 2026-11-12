// @vitest-environment jsdom
// The grant screen's line for each call checker: our rule in words, or a custom check. The chain is
// read only for what the request doesn't already say, and nothing waits on it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { concat, type Hex } from 'viem';

import type { CallPermission, CheckerView } from '../components/PermissionDialog/types';

const getCode = vi.fn();
const readContract = vi.fn();
vi.mock('../utils/publicClient', () => ({
  jawRpcUrl: () => 'https://rpc.example',
  getPublicClient: () => ({ getCode, readContract }),
}));
const resolveCalldataDescriptor = vi.fn();
vi.mock('../utils/clearSigning', () => ({
  getDefaultDescriptorSource: () => ({}),
  resolveCalldataDescriptor: (...args: unknown[]) => resolveCalldataDescriptor(...args),
}));

const { useCheckerViews } = await import('./useCheckerViews');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// packages/core/vectors/checker-calls.json: addresses the deployed factory returned for these settings.
const ONLY_LANDLORD = {
  checker: '0x4f8365A8A4C6FD48e6f95FA3a089C654061DF765',
  template: '0x6cA4dcc0D7F56b17ACfc167f3F62650C36Be296A',
  settings:
    '0xa9059cbb000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000001a4d',
};
const UP_TO_100 = {
  checker: '0xF2D7a1eE699ad34eE8BE9b23CdAFC1551D8ea664',
  template: '0x3AB44b0ad082A2643Ab807c99e738D3e4C7BA60c',
  settings:
    '0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000056bc75e2d63100000',
};
const LANDLORD = '0x0000000000000000000000000000000000001a4d';
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const cloneCode = (template: string, settings: string) =>
  concat(['0x363d3d373d3d3d363d73', template as Hex, '0x5af43d82803e903d91602b57fd5bf3', settings as Hex]);

const transferCall = (checker: string, checkerDeploy?: { template: string; settings: string }): CallPermission => ({
  target: TOKEN,
  selector: '0xa9059cbb',
  functionSignature: 'transfer(address,uint256)',
  checker,
  ...(checkerDeploy ? { checkerDeploy } : {}),
});

let root: Root | null = null;
let viewOf: ((call: CallPermission) => CheckerView | undefined) | null = null;

function Probe({ calls }: { calls: CallPermission[] }) {
  viewOf = useCheckerViews(calls, { chainId: 84532, apiKey: 'test', nativeSymbol: 'ETH' });
  return null;
}

async function render(calls: CallPermission[]) {
  const created = createRoot(document.createElement('div'));
  root = created;
  await act(async () => created.render(createElement(Probe, { calls })));
}

/** The view the hook gave `call` on its last render. */
function view(call: CallPermission) {
  if (!viewOf) throw new Error('the hook has not rendered');
  return viewOf(call);
}

beforeEach(() => {
  getCode.mockReset();
  readContract.mockReset();
  resolveCalldataDescriptor.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  viewOf = null;
});

describe('a checker the grant is about to deploy', () => {
  it('states its rule from the request, without reading its code', async () => {
    const { checker, ...deploy } = ONLY_LANDLORD;
    const call = transferCall(checker, deploy);
    await render([call]);

    expect(view(call)).toEqual({ tone: 'rule', parts: ['To must be ', { address: LANDLORD }] });
    expect(getCode).not.toHaveBeenCalled();
  });
});

describe('a checker that is already deployed', () => {
  it('reads its code and states its rule, with the cap in the token’s units', async () => {
    getCode.mockResolvedValue(cloneCode(UP_TO_100.template, UP_TO_100.settings));
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === 'decimals' ? 18 : 'TKN'
    );
    const call = transferCall(UP_TO_100.checker);
    await render([call]);

    expect(getCode).toHaveBeenCalledWith({ address: UP_TO_100.checker });
    expect(view(call)).toEqual({ tone: 'rule', parts: ['Amount at most 100 TKN per call'] });
  });

  it('gives no view while its code is still being read, so the plain checker line stays', async () => {
    getCode.mockReturnValue(new Promise(() => undefined));
    const call = transferCall(UP_TO_100.checker);
    await render([call]);

    expect(view(call)).toBeUndefined();
  });

  it('calls a checker with any other code a custom check', async () => {
    getCode.mockResolvedValue('0x6080604052');
    const call = transferCall('0x9999999999999999999999999999999999999999');
    await render([call]);

    expect(view(call)).toEqual({ tone: 'custom' });
  });

  it('keeps the plain checker line when its code can’t be read', async () => {
    getCode.mockRejectedValue(new Error('offline'));
    const call = transferCall(UP_TO_100.checker);
    await render([call]);

    expect(view(call)).toBeUndefined();
  });
});

describe('the name the rule gives the argument', () => {
  it('uses the contract’s clear-signing label when the signature has no names', async () => {
    resolveCalldataDescriptor.mockResolvedValue({
      formatKey: 'transfer(address to,uint256 value)',
      format: { fields: [{ path: 'to', label: 'Recipient' }] },
    });
    const { checker, ...deploy } = ONLY_LANDLORD;
    const call = transferCall(checker, deploy);
    await render([call]);

    expect(view(call)).toEqual({ tone: 'rule', parts: ['Recipient must be ', { address: LANDLORD }] });
  });
});
