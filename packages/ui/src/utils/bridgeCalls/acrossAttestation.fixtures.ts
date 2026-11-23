import type { BridgeCall } from './view';

type Token = { chainId: string; token: string };
export type AcrossQuoteFixture = {
  calls: (BridgeCall & { data: string; value: string })[];
  attestation: {
    scheme: string;
    signer: string;
    signature: string;
    typedData: {
      types: Record<string, { name: string; type: string }[]>;
      primaryType: string;
      domain: { name: string; version: string; chainId: number; verifyingContract: string };
      message: {
        orderId: string;
        issuedAt: string;
        expiresAt: string;
        originValidUntil: string;
        origin: { token: Token; amount: string; depositor: string };
        destination: { token: Token; recipient: string; minAmount: string; actions: unknown[] };
        refundPolicy: { recipient: string; tokens: Token[] };
        funding: {
          caller: string;
          approvals: { chainId: string; token: string; spender: string; amount: string; index: string }[];
          transactions: { chainId: string; to: string; value: string; data: string; index: string }[];
          messages: unknown[];
        };
      };
    };
  };
};

// Live Across POST /v1/quotes responses (2026-11-20) requested with attestation: { verifier: zero }.
// Each attestation is as Across sent it; the calls are the quote's nextActions as the wallet receives them.
export const ACROSS_QUOTE_DEPOSITOR = '0x1111111111111111111111111111111111111111' as const;
// Between the last issuedAt and the first expiresAt of the quotes below.
export const ACROSS_QUOTES_LIVE_AT = Date.UTC(2026, 10, 20, 13, 30);

export const ACROSS_ATTESTED_QUOTES: Record<'erc20' | 'native' | 'robinhood', AcrossQuoteFixture> = {
  erc20: {
    calls: [
      {
        chainId: 8453,
        to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        value: '0',
        data: '0x095ea7b3000000000000000000000000794dbdbdbfd3f8a3b887f4513bf5ff29edd04a940000000000000000000000000000000000000000000000000000000000989680',
      },
      {
        chainId: 8453,
        to: '0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94',
        value: '0',
        data: '0x1e04ce08c9e948ec69724498f977735755b35b79f27c735002cc60ba92a3f6a5b80931f1000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000000989680',
      },
    ],
    attestation: {
      scheme: 'eip712',
      signer: '0x4115BD0fCb3d8909aB6359fF89091b7EaF56d4fe',
      typedData: {
        types: {
          Quote: [
            { name: 'orderId', type: 'bytes32' },
            { name: 'issuedAt', type: 'uint64' },
            { name: 'expiresAt', type: 'uint64' },
            { name: 'originValidUntil', type: 'uint64' },
            { name: 'origin', type: 'Origin' },
            { name: 'destination', type: 'Destination' },
            { name: 'refundPolicy', type: 'RefundPolicy' },
            { name: 'funding', type: 'Funding' },
          ],
          Token: [
            { name: 'chainId', type: 'uint256' },
            { name: 'token', type: 'bytes32' },
          ],
          Origin: [
            { name: 'token', type: 'Token' },
            { name: 'amount', type: 'uint256' },
            { name: 'depositor', type: 'bytes32' },
          ],
          Destination: [
            { name: 'token', type: 'Token' },
            { name: 'recipient', type: 'bytes32' },
            { name: 'minAmount', type: 'uint256' },
            { name: 'actions', type: 'RequestedAction[]' },
          ],
          RequestedAction: [
            { name: 'target', type: 'address' },
            { name: 'functionSignature', type: 'string' },
            { name: 'args', type: 'bytes' },
            { name: 'value', type: 'uint256' },
            { name: 'allowFailure', type: 'bool' },
            { name: 'substitutions', type: 'BalanceSubstitution[]' },
          ],
          BalanceSubstitution: [
            { name: 'token', type: 'address' },
            { name: 'balanceOwner', type: 'address' },
            { name: 'bps', type: 'uint16' },
            { name: 'appliesToValue', type: 'bool' },
            { name: 'calldataOffset', type: 'uint256' },
          ],
          RefundPolicy: [
            { name: 'recipient', type: 'bytes32' },
            { name: 'tokens', type: 'Token[]' },
          ],
          Funding: [
            { name: 'caller', type: 'bytes32' },
            { name: 'approvals', type: 'Approval[]' },
            { name: 'transactions', type: 'Transaction[]' },
            { name: 'messages', type: 'SignedMessage[]' },
          ],
          SignedMessage: [
            { name: 'chainId', type: 'uint256' },
            { name: 'digest', type: 'bytes32' },
            { name: 'index', type: 'uint256' },
          ],
          Approval: [
            { name: 'chainId', type: 'uint256' },
            { name: 'token', type: 'bytes32' },
            { name: 'spender', type: 'bytes32' },
            { name: 'amount', type: 'uint256' },
            { name: 'index', type: 'uint256' },
          ],
          Transaction: [
            { name: 'chainId', type: 'uint256' },
            { name: 'to', type: 'bytes32' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
            { name: 'index', type: 'uint256' },
          ],
        },
        primaryType: 'Quote',
        domain: {
          name: 'Across Quote',
          version: '3',
          chainId: 8453,
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        message: {
          orderId: '0xc9e948ec69724498f977735755b35b79f27c735002cc60ba92a3f6a5b80931f1',
          issuedAt: '1795179704',
          expiresAt: '1795182104',
          originValidUntil: '1795182703',
          origin: {
            token: { chainId: '8453', token: '0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
            amount: '10000000',
            depositor: '0x0000000000000000000000001111111111111111111111111111111111111111',
          },
          destination: {
            token: { chainId: '42161', token: '0x000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831' },
            recipient: '0x0000000000000000000000001111111111111111111111111111111111111111',
            minAmount: '9910089',
            actions: [],
          },
          refundPolicy: { recipient: '0x0000000000000000000000000000000000000000000000000000000000000000', tokens: [] },
          funding: {
            caller: '0x0000000000000000000000001111111111111111111111111111111111111111',
            approvals: [
              {
                chainId: '8453',
                token: '0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913',
                spender: '0x000000000000000000000000794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94',
                amount: '10000000',
                index: '0',
              },
            ],
            transactions: [
              {
                chainId: '8453',
                to: '0x000000000000000000000000794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94',
                value: '0',
                data: '0x1e04ce08c9e948ec69724498f977735755b35b79f27c735002cc60ba92a3f6a5b80931f1000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000000989680',
                index: '1',
              },
            ],
            messages: [],
          },
        },
      },
      signature:
        '0xe161db2f4905a8737fe485c9c6753a3105814d9f2eb28ed196524ab35375e5e3421b36fe5d1ece08aeb948b74b562267c7feb38d16c4dc84b6971cd3a76701721c',
    },
  },
  native: {
    calls: [
      {
        chainId: 8453,
        to: '0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94',
        value: '5000000000000000',
        data: '0x1e04ce082b32c6471a1e46b24a0fbe567df91db0efc99864cf9cedab6fce8870cee239be00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      },
    ],
    attestation: {
      scheme: 'eip712',
      signer: '0x4115BD0fCb3d8909aB6359fF89091b7EaF56d4fe',
      typedData: {
        types: {
          Quote: [
            { name: 'orderId', type: 'bytes32' },
            { name: 'issuedAt', type: 'uint64' },
            { name: 'expiresAt', type: 'uint64' },
            { name: 'originValidUntil', type: 'uint64' },
            { name: 'origin', type: 'Origin' },
            { name: 'destination', type: 'Destination' },
            { name: 'refundPolicy', type: 'RefundPolicy' },
            { name: 'funding', type: 'Funding' },
          ],
          Token: [
            { name: 'chainId', type: 'uint256' },
            { name: 'token', type: 'bytes32' },
          ],
          Origin: [
            { name: 'token', type: 'Token' },
            { name: 'amount', type: 'uint256' },
            { name: 'depositor', type: 'bytes32' },
          ],
          Destination: [
            { name: 'token', type: 'Token' },
            { name: 'recipient', type: 'bytes32' },
            { name: 'minAmount', type: 'uint256' },
            { name: 'actions', type: 'RequestedAction[]' },
          ],
          RequestedAction: [
            { name: 'target', type: 'address' },
            { name: 'functionSignature', type: 'string' },
            { name: 'args', type: 'bytes' },
            { name: 'value', type: 'uint256' },
            { name: 'allowFailure', type: 'bool' },
            { name: 'substitutions', type: 'BalanceSubstitution[]' },
          ],
          BalanceSubstitution: [
            { name: 'token', type: 'address' },
            { name: 'balanceOwner', type: 'address' },
            { name: 'bps', type: 'uint16' },
            { name: 'appliesToValue', type: 'bool' },
            { name: 'calldataOffset', type: 'uint256' },
          ],
          RefundPolicy: [
            { name: 'recipient', type: 'bytes32' },
            { name: 'tokens', type: 'Token[]' },
          ],
          Funding: [
            { name: 'caller', type: 'bytes32' },
            { name: 'approvals', type: 'Approval[]' },
            { name: 'transactions', type: 'Transaction[]' },
            { name: 'messages', type: 'SignedMessage[]' },
          ],
          SignedMessage: [
            { name: 'chainId', type: 'uint256' },
            { name: 'digest', type: 'bytes32' },
            { name: 'index', type: 'uint256' },
          ],
          Approval: [
            { name: 'chainId', type: 'uint256' },
            { name: 'token', type: 'bytes32' },
            { name: 'spender', type: 'bytes32' },
            { name: 'amount', type: 'uint256' },
            { name: 'index', type: 'uint256' },
          ],
          Transaction: [
            { name: 'chainId', type: 'uint256' },
            { name: 'to', type: 'bytes32' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
            { name: 'index', type: 'uint256' },
          ],
        },
        primaryType: 'Quote',
        domain: {
          name: 'Across Quote',
          version: '3',
          chainId: 8453,
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        message: {
          orderId: '0x2b32c6471a1e46b24a0fbe567df91db0efc99864cf9cedab6fce8870cee239be',
          issuedAt: '1795179705',
          expiresAt: '1795182105',
          originValidUntil: '1795182701',
          origin: {
            token: { chainId: '8453', token: '0x0000000000000000000000000000000000000000000000000000000000000000' },
            amount: '5000000000000000',
            depositor: '0x0000000000000000000000001111111111111111111111111111111111111111',
          },
          destination: {
            token: { chainId: '42161', token: '0x0000000000000000000000000000000000000000000000000000000000000000' },
            recipient: '0x0000000000000000000000001111111111111111111111111111111111111111',
            minAmount: '4972917598016540',
            actions: [],
          },
          refundPolicy: {
            recipient: '0x0000000000000000000000001111111111111111111111111111111111111111',
            tokens: [
              { chainId: '8453', token: '0x0000000000000000000000000000000000000000000000000000000000000000' },
              { chainId: '8453', token: '0x0000000000000000000000004200000000000000000000000000000000000006' },
            ],
          },
          funding: {
            caller: '0x0000000000000000000000001111111111111111111111111111111111111111',
            approvals: [],
            transactions: [
              {
                chainId: '8453',
                to: '0x000000000000000000000000794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94',
                value: '5000000000000000',
                data: '0x1e04ce082b32c6471a1e46b24a0fbe567df91db0efc99864cf9cedab6fce8870cee239be00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
                index: '0',
              },
            ],
            messages: [],
          },
        },
      },
      signature:
        '0xdc341ab24e4470088c0677ee122adcb863c3ba9d80797a5132da397335462b7054f8c0ae7229c6e90eba2600472656d000669be5656bc66baf9aa0c0c8dfa31d1b',
    },
  },
  robinhood: {
    calls: [
      {
        chainId: 8453,
        to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        value: '0',
        data: '0x095ea7b3000000000000000000000000794dbdbdbfd3f8a3b887f4513bf5ff29edd04a940000000000000000000000000000000000000000000000000000000002faf080',
      },
      {
        chainId: 8453,
        to: '0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94',
        value: '0',
        data: '0x1e04ce0811b6c567ecf89c9e72d5c9895687acd961d0c4ca7c5c0be1c8e28000eedd17a4000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000002faf080',
      },
    ],
    attestation: {
      scheme: 'eip712',
      signer: '0x4115BD0fCb3d8909aB6359fF89091b7EaF56d4fe',
      typedData: {
        types: {
          Quote: [
            { name: 'orderId', type: 'bytes32' },
            { name: 'issuedAt', type: 'uint64' },
            { name: 'expiresAt', type: 'uint64' },
            { name: 'originValidUntil', type: 'uint64' },
            { name: 'origin', type: 'Origin' },
            { name: 'destination', type: 'Destination' },
            { name: 'refundPolicy', type: 'RefundPolicy' },
            { name: 'funding', type: 'Funding' },
          ],
          Token: [
            { name: 'chainId', type: 'uint256' },
            { name: 'token', type: 'bytes32' },
          ],
          Origin: [
            { name: 'token', type: 'Token' },
            { name: 'amount', type: 'uint256' },
            { name: 'depositor', type: 'bytes32' },
          ],
          Destination: [
            { name: 'token', type: 'Token' },
            { name: 'recipient', type: 'bytes32' },
            { name: 'minAmount', type: 'uint256' },
            { name: 'actions', type: 'RequestedAction[]' },
          ],
          RequestedAction: [
            { name: 'target', type: 'address' },
            { name: 'functionSignature', type: 'string' },
            { name: 'args', type: 'bytes' },
            { name: 'value', type: 'uint256' },
            { name: 'allowFailure', type: 'bool' },
            { name: 'substitutions', type: 'BalanceSubstitution[]' },
          ],
          BalanceSubstitution: [
            { name: 'token', type: 'address' },
            { name: 'balanceOwner', type: 'address' },
            { name: 'bps', type: 'uint16' },
            { name: 'appliesToValue', type: 'bool' },
            { name: 'calldataOffset', type: 'uint256' },
          ],
          RefundPolicy: [
            { name: 'recipient', type: 'bytes32' },
            { name: 'tokens', type: 'Token[]' },
          ],
          Funding: [
            { name: 'caller', type: 'bytes32' },
            { name: 'approvals', type: 'Approval[]' },
            { name: 'transactions', type: 'Transaction[]' },
            { name: 'messages', type: 'SignedMessage[]' },
          ],
          SignedMessage: [
            { name: 'chainId', type: 'uint256' },
            { name: 'digest', type: 'bytes32' },
            { name: 'index', type: 'uint256' },
          ],
          Approval: [
            { name: 'chainId', type: 'uint256' },
            { name: 'token', type: 'bytes32' },
            { name: 'spender', type: 'bytes32' },
            { name: 'amount', type: 'uint256' },
            { name: 'index', type: 'uint256' },
          ],
          Transaction: [
            { name: 'chainId', type: 'uint256' },
            { name: 'to', type: 'bytes32' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
            { name: 'index', type: 'uint256' },
          ],
        },
        primaryType: 'Quote',
        domain: {
          name: 'Across Quote',
          version: '3',
          chainId: 8453,
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        message: {
          orderId: '0x11b6c567ecf89c9e72d5c9895687acd961d0c4ca7c5c0be1c8e28000eedd17a4',
          issuedAt: '1795179706',
          expiresAt: '1795182106',
          originValidUntil: '1795182702',
          origin: {
            token: { chainId: '8453', token: '0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
            amount: '50000000',
            depositor: '0x0000000000000000000000001111111111111111111111111111111111111111',
          },
          destination: {
            token: { chainId: '4663', token: '0x000000000000000000000000d0601ce157db5bdc3162bbac2a2c8af5320d9eec' },
            recipient: '0x0000000000000000000000001111111111111111111111111111111111111111',
            minAmount: '334882914395428028',
            actions: [],
          },
          refundPolicy: {
            recipient: '0x0000000000000000000000001111111111111111111111111111111111111111',
            tokens: [{ chainId: '8453', token: '0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913' }],
          },
          funding: {
            caller: '0x0000000000000000000000001111111111111111111111111111111111111111',
            approvals: [
              {
                chainId: '8453',
                token: '0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913',
                spender: '0x000000000000000000000000794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94',
                amount: '50000000',
                index: '0',
              },
            ],
            transactions: [
              {
                chainId: '8453',
                to: '0x000000000000000000000000794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94',
                value: '0',
                data: '0x1e04ce0811b6c567ecf89c9e72d5c9895687acd961d0c4ca7c5c0be1c8e28000eedd17a4000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000002faf080',
                index: '1',
              },
            ],
            messages: [],
          },
        },
      },
      signature:
        '0x0afddcb2374de7c70b6573cf385e03253ec57239ff27651c7eed5c37943054d416ceeb0a9092b5b9b104114c10c65195b19d84baeaab63cfe13bac2de6afc35c1c',
    },
  },
};
