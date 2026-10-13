/**
 * createSmartAccount given a stored record. viem runs for real; only the
 * network is faked, so the assertions are on the address and the deploy
 * calldata the account would actually use.
 */
import { createClient, custom, hexToBytes, type Hex } from 'viem';
import { base } from 'viem/chains';
import { toWebAuthnAccount } from 'viem/account-abstraction';
import { describe, expect, it } from 'vitest';
import { createSmartAccount } from './smartAccount.js';
import { accountRecordFactoryData, deriveAccountRecordV1 } from './accountRecord.js';
import { toJustanAccount } from './toJustanAccount.js';
import { PERMISSIONS_MANAGER_ADDRESS } from '../constants.js';

// factory.getAddress([PUBLIC_KEY, permissionsManager], 0) on Base
const PUBLIC_KEY =
    '0x885d083da109f4ea0b626025ee5886d869f51817afad5a380f2b1fa9a35bccf8d52b9347c47495158ef458c338cdd15f7a902d357541d0e19d0b19e8f7ea0fd8' as Hex;
const ADDRESS = '0x1f4201aED7443a59a3f849E6A07dbF438FFB6C62';

/** A chain where the account is not deployed yet, and that fails any contract read. */
function undeployedChainClient() {
    const methods: string[] = [];
    const client = createClient({
        chain: base,
        transport: custom({
            async request({ method }) {
                methods.push(method);
                if (method === 'eth_getCode') return '0x';
                if (method === 'eth_chainId') return '0x2105';
                throw new Error(`unexpected ${method}`);
            },
        }),
    });
    return { client, methods };
}

function signer() {
    return toWebAuthnAccount({ credential: { id: 'cred-1', publicKey: PUBLIC_KEY } });
}

describe('createSmartAccount with a record', () => {
    it("uses the record's address without asking the factory for one", async () => {
        const { client, methods } = undeployedChainClient();
        const record = deriveAccountRecordV1(PUBLIC_KEY);

        const account = await createSmartAccount(signer(), client as never, record);

        expect(await account.getAddress()).toBe(ADDRESS);
        expect(methods).not.toContain('eth_call');
    });

    it("deploys with the record's factory and createAccount calldata", async () => {
        const { client } = undeployedChainClient();
        const record = deriveAccountRecordV1(PUBLIC_KEY);

        const account = await createSmartAccount(signer(), client as never, record);

        await expect(account.getFactoryArgs()).resolves.toEqual({
            factory: record.factory,
            factoryData: accountRecordFactoryData(record),
        });
    });

    it('deploys with the same calldata the owners encode today, while nothing rotates', async () => {
        const { client } = undeployedChainClient();
        const record = deriveAccountRecordV1(PUBLIC_KEY);

        const fromRecord = await createSmartAccount(signer(), client as never, record);
        const fromOwners = await toJustanAccount({
            client: client as never,
            owners: [signer(), PERMISSIONS_MANAGER_ADDRESS],
            address: ADDRESS,
        });

        const recordArgs = await fromRecord.getFactoryArgs();
        const ownersArgs = await fromOwners.getFactoryArgs();

        // The same bytes: the owners path pads the checksummed address, so only
        // the hex letters' case differs.
        expect(recordArgs.factory).toBe(ownersArgs.factory);
        expect(hexToBytes(recordArgs.factoryData ?? '0x')).toEqual(hexToBytes(ownersArgs.factoryData ?? '0x'));
        expect(recordArgs.factoryData).toBeDefined();
    });
});
