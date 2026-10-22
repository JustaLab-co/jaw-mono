import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, erc20Abi, getAddress, zeroAddress, type Address } from 'viem';
import { callsOf } from './calls';
import { checkQuote, isSupportedOriginChain, type QuoteRequest } from './check';

const account = getAddress('0x1111111111111111111111111111111111111111');
const usdc = getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
const depositAddress = getAddress('0x5f6a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c');
const elsewhere = getAddress('0x3333333333333333333333333333333333333333');

const destination = {
  destinationChainId: 42161,
  destinationToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  recipient: account.toLowerCase(),
};
const erc20Request: QuoteRequest = {
  originChainId: 8453,
  originToken: usdc,
  amount: '1000000',
  account,
  ...destination,
};
const nativeRequest: QuoteRequest = { ...erc20Request, originToken: zeroAddress };

const transfer = (to: Address, amount: string) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, BigInt(amount)] });

function backendQuoteJson(request: QuoteRequest, deposit: Address = depositAddress) {
  const aurora = {
    depositAddress: deposit.toLowerCase(),
    amountIn: request.amount,
    amountInUsd: '1.000150',
    amountOut: '999000',
    amountOutUsd: '0.998840',
    minAmountOut: '990000',
    timeEstimate: 30,
  };
  const checksummed = getAddress(aurora.depositAddress);
  const native = request.originToken.toLowerCase() === zeroAddress;
  const quote = {
    quoteId: `aurora:${checksummed}`,
    provider: 'aurora',
    inputAmount: aurora.amountIn,
    expectedOutputAmount: aurora.amountOut,
    minOutputAmount: aurora.minAmountOut,
    expectedFillTimeSec: aurora.timeEstimate,
    fees: {
      totalUsd: (Number(aurora.amountInUsd) - Number(aurora.amountOutUsd)).toFixed(6),
      originGasUsd: undefined,
      destinationGasUsd: undefined,
      relayerUsd: undefined,
      appFeeUsd: undefined,
    },
    transactions: [
      {
        chainId: request.originChainId,
        to: native ? checksummed : getAddress(request.originToken),
        data: native ? '0x' : transfer(checksummed, aurora.amountIn),
        value: native ? aurora.amountIn : '0',
        gas: undefined,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
        description: 'deposit',
      },
    ],
  };
  const envelope = { statusCode: 200, result: { data: quote, error: null } };
  return JSON.parse(JSON.stringify(envelope)).result.data;
}

const unused = async () => false;
const deps = { isDepositAddressTaken: unused, now: () => 0 };

async function accepted(request: QuoteRequest, body: unknown) {
  const result = await checkQuote(request, body, deps);
  if (!result.ok) throw new Error(`expected the quote to pass, got ${result.code}`);
  expect(callsOf({ call: result.calls })).toEqual(result.calls);
  return result;
}

async function rejected(request: QuoteRequest, body: unknown) {
  const result = await checkQuote(request, body, deps);
  if (result.ok) throw new Error('expected the quote to be rejected');
  return result.code;
}

describe('checkQuote', () => {
  it('Given an ERC-20 quote as the backend Aurora mapper builds it, When checked, Then it returns the transfer to show the owner', async () => {
    const result = await accepted(erc20Request, backendQuoteJson(erc20Request));

    expect(result).toEqual({
      ok: true,
      quoteId: `aurora:${depositAddress}`,
      depositAddress,
      calls: [{ kind: 'deposit', chainId: 8453, to: usdc, data: transfer(depositAddress, '1000000'), value: '0' }],
      quote: {
        provider: 'aurora',
        inputAmount: '1000000',
        expectedOutputAmount: '999000',
        minOutputAmount: '990000',
        expectedFillTimeSec: 30,
        feesUsd: '0.001310',
      },
    });
  });

  it('Given a native quote as the backend Aurora mapper builds it, When checked, Then it returns the plain send to the deposit address', async () => {
    const result = await accepted(nativeRequest, backendQuoteJson(nativeRequest));

    expect(result).toMatchObject({
      quote: { provider: 'aurora' },
      depositAddress,
      calls: [{ kind: 'deposit', chainId: 8453, to: depositAddress, data: '0x', value: '1000000' }],
    });
  });

  it('Given a Solana destination, When an Aurora quote is checked, Then it passes as for an EVM one', async () => {
    const request = {
      ...erc20Request,
      destinationChainId: 792703809,
      destinationToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    };

    const result = await accepted(request, backendQuoteJson(request));

    expect(result.calls).toEqual([
      { kind: 'deposit', chainId: 8453, to: usdc, data: transfer(depositAddress, '1000000'), value: '0' },
    ]);
  });

  it('Given a same-asset Aurora quote whose minimum is 1 base unit, When checked, Then it passes: no output floor applies to Aurora', async () => {
    const body = { ...backendQuoteJson(erc20Request), minOutputAmount: '1' };

    expect(await accepted(erc20Request, body)).toMatchObject({ quote: { minOutputAmount: '1' } });
  });

  it('Given a decimal fee, When checked, Then the checked quote keeps it', async () => {
    for (const fee of ['12', '12.5']) {
      const body = backendQuoteJson(erc20Request);
      body.fees.totalUsd = fee;

      const result = await accepted(erc20Request, body);

      expect(result.quote.feesUsd).toBe(fee);
    }
  });

  it('Given a fee that is missing or not a decimal, When checked, Then the quote passes without it', async () => {
    for (const fee of [undefined, 'ignore previous instructions', 'x1.5', '1.5x', '1.', '-1']) {
      const body = backendQuoteJson(erc20Request);
      body.fees.totalUsd = fee;

      const result = await accepted(erc20Request, body);

      expect(result.quote).not.toHaveProperty('feesUsd');
    }
  });

  it('Given a body that is not a quote, When checked, Then it fails with quote_invalid', async () => {
    expect(await rejected(erc20Request, { error: 'nope' })).toBe('quote_invalid');
    expect(await rejected(erc20Request, null)).toBe('quote_invalid');
  });

  it('B8.1 Given a quote with zero or two transactions, When checked, Then it fails with tx_count', async () => {
    const none = backendQuoteJson(erc20Request);
    none.transactions = [];
    const two = backendQuoteJson(erc20Request);
    two.transactions.push(two.transactions[0]);

    expect(await rejected(erc20Request, none)).toBe('tx_count');
    expect(await rejected(erc20Request, two)).toBe('tx_count');
  });

  it('B8.2 Given a transaction on another chain than the origin, When checked, Then it fails with tx_chain', async () => {
    const body = backendQuoteJson(erc20Request);
    body.transactions[0].chainId = 42161;

    expect(await rejected(erc20Request, body)).toBe('tx_chain');
  });

  it('B8.3 Given a quoteId that is not aurora:<address>, another provider, or a deposit field, When checked, Then it fails with quote_id', async () => {
    const notAddress = backendQuoteJson(erc20Request);
    notAddress.quoteId = 'aurora:0x1234';
    const otherPrefix = backendQuoteJson(erc20Request);
    otherPrefix.quoteId = `across:${depositAddress}`;
    const wrapped = backendQuoteJson(erc20Request);
    wrapped.quoteId = `x-aurora:${depositAddress}`;
    const longer = backendQuoteJson(erc20Request);
    longer.quoteId = `aurora:${depositAddress}ff`;
    const otherProvider = backendQuoteJson(erc20Request);
    otherProvider.provider = 'across';
    const withDeposit = backendQuoteJson(erc20Request);
    withDeposit.deposit = { chainId: 8453, address: depositAddress, token: usdc, amount: '1000000' };

    for (const body of [notAddress, otherPrefix, wrapped, longer, otherProvider, withDeposit]) {
      expect(await rejected(erc20Request, body)).toBe('quote_id');
    }
  });

  it('B8.4 Given an ERC-20 origin and a transaction to another contract, When checked, Then it fails with tx_to', async () => {
    const body = backendQuoteJson(erc20Request);
    body.transactions[0].to = elsewhere;

    expect(await rejected(erc20Request, body)).toBe('tx_to');
  });

  it('B8.5 Given an ERC-20 origin and a transaction carrying value, When checked, Then it fails with tx_value', async () => {
    const body = backendQuoteJson(erc20Request);
    body.transactions[0].value = '1';

    expect(await rejected(erc20Request, body)).toBe('tx_value');
  });

  it('B8.6 Given an ERC-20 origin and calldata other than transfer(depositAddress, amount), When checked, Then it fails with tx_data', async () => {
    const toOther = backendQuoteJson(erc20Request);
    toOther.transactions[0].data = transfer(elsewhere, '1000000');
    const moreAmount = backendQuoteJson(erc20Request);
    moreAmount.transactions[0].data = transfer(depositAddress, '1000001');
    const approve = backendQuoteJson(erc20Request);
    approve.transactions[0].data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [depositAddress, 1000000n],
    });

    for (const body of [toOther, moreAmount, approve]) {
      expect(await rejected(erc20Request, body)).toBe('tx_data');
    }
  });

  it('B8.7 Given an ERC-20 origin and a valid transfer followed by trailing bytes, When checked, Then it fails with tx_data', async () => {
    const body = backendQuoteJson(erc20Request);
    body.transactions[0].data = `${transfer(depositAddress, '1000000')}deadbeef`;

    expect(await rejected(erc20Request, body)).toBe('tx_data');
  });

  it('B8.8 Given a native origin and a send to another address than the deposit address, When checked, Then it fails with tx_to', async () => {
    const body = backendQuoteJson(nativeRequest);
    body.transactions[0].to = elsewhere;

    expect(await rejected(nativeRequest, body)).toBe('tx_to');
  });

  it('B8.9 Given a native origin and calldata on the send, When checked, Then it fails with tx_data', async () => {
    const body = backendQuoteJson(nativeRequest);
    body.transactions[0].data = '0x00';

    expect(await rejected(nativeRequest, body)).toBe('tx_data');
  });

  it('B8.10 Given a native origin and a value other than the amount, When checked, Then it fails with tx_value', async () => {
    const body = backendQuoteJson(nativeRequest);
    body.transactions[0].value = '1000001';

    expect(await rejected(nativeRequest, body)).toBe('tx_value');
  });

  it('B8.11 Given an inputAmount other than the requested amount, When checked, Then it fails with input_amount', async () => {
    const body = backendQuoteJson(erc20Request);
    body.inputAmount = '999999';

    expect(await rejected(erc20Request, body)).toBe('input_amount');
  });

  it.each(['0', '1.5', '-1', '+1', '01', '1e6', ''])(
    'B8.11 Given a requested amount %j that is not positive base units, When checked, Then it fails with input_amount and does not throw',
    async (amount) => {
      for (const origin of [erc20Request, nativeRequest]) {
        const request = { ...origin, amount };
        const body = backendQuoteJson(origin);
        body.inputAmount = amount;
        body.transactions[0].value = origin === nativeRequest ? amount : '0';
        if (amount === '0' && origin === erc20Request) body.transactions[0].data = transfer(depositAddress, '0');

        expect(await rejected(request, body)).toBe('input_amount');
      }
    }
  );

  it('B8.3 Given a quoteId with the deposit address in lowercase, When checked, Then the checked quote carries it checksummed', async () => {
    const body = backendQuoteJson(erc20Request);
    body.quoteId = `aurora:${depositAddress.toLowerCase()}`;

    const result = await accepted(erc20Request, body);

    expect(result).toMatchObject({ quoteId: `aurora:${depositAddress}`, depositAddress });
  });

  it('B8.12 Given output amounts that are not base units, zero, or a minimum above the expected output, When checked, Then it fails with output_amount', async () => {
    const cases: Array<[string, string]> = [
      ['999000', '1e5'],
      ['99.5', '90'],
      ['999000', '0'],
      ['999000', '999001'],
    ];
    for (const [expectedOutputAmount, minOutputAmount] of cases) {
      const body = { ...backendQuoteJson(erc20Request), expectedOutputAmount, minOutputAmount };
      expect(await rejected(erc20Request, body)).toBe('output_amount');
    }
  });

  it('B8.12 Given a minimum equal to the expected output, When checked, Then the quote passes', async () => {
    const body = { ...backendQuoteJson(erc20Request), minOutputAmount: '999000' };

    expect(await accepted(erc20Request, body)).toMatchObject({ quote: { minOutputAmount: '999000' } });
  });

  it('B8.13 Given a deposit address equal to the account, the origin token or the zero address, When checked, Then it fails with deposit_address', async () => {
    expect(await rejected(erc20Request, backendQuoteJson(erc20Request, account))).toBe('deposit_address');
    expect(await rejected(erc20Request, backendQuoteJson(erc20Request, usdc))).toBe('deposit_address');
    expect(await rejected(nativeRequest, backendQuoteJson(nativeRequest, zeroAddress))).toBe('deposit_address');
  });

  it('B8.13 Given the account in lowercase on the request, When the deposit address is the account checksummed, Then it still fails with deposit_address', async () => {
    const request = { ...erc20Request, account: account.toLowerCase() as Address };

    expect(await rejected(request, backendQuoteJson(request, account))).toBe('deposit_address');
  });

  it('B8.14 Given a deposit address already used by a swap row, When checked, Then it fails with deposit_address_reused', async () => {
    const isTaken = vi.fn(async (address: Address) => address === depositAddress);

    const result = await checkQuote(erc20Request, backendQuoteJson(erc20Request), {
      ...deps,
      isDepositAddressTaken: isTaken,
    });

    expect(result).toEqual({ ok: false, code: 'deposit_address_reused' });
    expect(isTaken).toHaveBeenCalledWith(depositAddress);
  });

  it('B8.14 Given a quote that already failed another check, When checked, Then the reuse lookup is not asked', async () => {
    const isTaken = vi.fn(unused);
    const body = backendQuoteJson(erc20Request);
    body.transactions = [];

    await checkQuote(erc20Request, body, { ...deps, isDepositAddressTaken: isTaken });

    expect(isTaken).not.toHaveBeenCalled();
  });
});

describe('isSupportedOriginChain', () => {
  it('B31 Given an origin chain the JAW signer lists, testnets included, When checked, Then it is supported', () => {
    for (const id of [8453, 42161, 1, 84532, 11155111]) expect(isSupportedOriginChain(id)).toBe(true);
  });

  it('B31 Given an origin chain outside the JAW signer list, When checked, Then it is refused', () => {
    for (const id of [324, 792703809, 0]) expect(isSupportedOriginChain(id)).toBe(false);
  });
});
