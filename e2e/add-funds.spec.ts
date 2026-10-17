import type { Page } from '@playwright/test';
import { parseEther, toHex } from 'viem';

import { Dapp, expect, test, type Network, type Passkey } from './fixtures';

/**
 * A request the account cannot pay for offers Add funds instead of a dead
 * "Insufficient Funds" button, and leaving Add Funds ends the request with a
 * message the dApp can act on.
 *
 * What "short" means is decided by the mocked chain alone: the balance the
 * account reports and whether the bundler accepts the userOp. Nothing here
 * waits on timing to tell the two outcomes apart.
 */

/** How long a dApp may wait on a dialog before the test calls it a hang. */
const SETTLES = 15_000;

const ADD_FUNDS_REJECTION = 'Insufficient funds. The user opened Add funds; retry after the deposit.';

/** The playground's default wallet_sendCalls: 0.01 ETH to the zero address. */
const VALUE = parseEther('0.01');
const GAS_PRICE = 1_000_000_000n;
const GAS = { callGasLimit: 100_000n, verificationGasLimit: 400_000n, preVerificationGas: 50_000n };
const FEE = (GAS.callGasLimit + GAS.verificationGasLimit + GAS.preVerificationGas) * GAS_PRICE;

const ETH = {
  uid: 'ethereum',
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000000',
  interop: true,
  decimals: 18,
  feeToken: true,
};

/**
 * A chain where the account holds `balance` wei and ETH is the only fee token,
 * so no ERC-20 can step in. The bundler refuses the userOp with AA21 when the
 * balance can't cover the value and the fee, as a real one does.
 */
function holdings(network: Network, balance: bigint) {
  network.answers = ({ method }) => {
    if (method === 'wallet_getCapabilities') {
      return { result: { '0xaa36a7': { feeToken: { supported: true, tokens: [ETH] } } } };
    }
    if (method === 'eth_getBalance') return { result: toHex(balance) };
    if (method === 'eth_gasPrice') return { result: toHex(GAS_PRICE) };
    if (method !== 'eth_estimateUserOperationGas') return undefined;
    if (balance < VALUE + FEE) return { error: { code: -32500, message: "AA21 didn't pay prefund" } };
    return {
      result: {
        callGasLimit: toHex(GAS.callGasLimit),
        verificationGasLimit: toHex(GAS.verificationGasLimit),
        preVerificationGas: toHex(GAS.preVerificationGas),
      },
    };
  };
}

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test.describe('add funds, app-specific', () => {
  /**
   * The SDK's own dialog in the playground page. The passkey's account is seeded
   * on the playground origin, where app-specific keeps it, and the credential's
   * rpId is the shared localhost, so the same authenticator signs here.
   */
  async function connect(dapp: Dapp, passkey: Passkey) {
    await dapp.page.goto('/core?mode=app-specific');
    await dapp.page.evaluate(
      ({ credentialId, publicKey }) =>
        localStorage.setItem(
          'jaw:passkey:accounts',
          JSON.stringify([
            { credentialId, publicKey, username: 'e2e', creationDate: new Date().toISOString(), isImported: false },
          ])
        ),
      { credentialId: passkey.credentialId, publicKey: passkey.publicKey }
    );
    await dapp.open('/core?mode=app-specific');
    await dapp.executeWithoutDialog();
    await dapp.page.getByText('e2e', { exact: true }).click();
    await expect(dapp.result()).toHaveText(/^OK/, { timeout: SETTLES });
  }

  /** Runs a playground method with its default parameters. Its dialog opens in the page. */
  async function run(dapp: Dapp, category: string, method: string) {
    await dapp.select(category, method);
    await dapp.executeWithoutDialog();
  }

  /** The playground's Response panel shows the error's message only; unit tests pin the 4001. */
  async function rejected(dapp: Dapp, message: string) {
    await expect(dapp.result()).toHaveText(/^Error/, { timeout: SETTLES });
    await expect(dapp.response()).toHaveText(message);
  }

  test('a short request offers Add funds, and Done ends it so the dApp retries', async ({ dapp, network, passkey }) => {
    holdings(network, 0n);
    await connect(dapp, passkey);
    await run(dapp, 'Transaction', 'wallet_sendCalls');
    const page = dapp.page;

    await expect(button(page, 'Add funds')).toBeEnabled({ timeout: SETTLES });
    await expect(button(page, 'Insufficient Funds')).toHaveCount(0);

    await button(page, 'Add funds').click();
    await expect(page.getByText(passkey.account, { exact: true })).toBeVisible();
    await expect(page.getByLabel('Accepted on Sepolia', { exact: true })).toBeVisible();
    // Still pending: Add Funds ends the request only when the user leaves it.
    await expect(dapp.response()).toHaveText('Executing…');

    await button(page, 'Done').click();
    await rejected(dapp, ADD_FUNDS_REJECTION);
  });

  test('leaving Add Funds with Escape ends the request the same way', async ({ dapp, network, passkey }) => {
    holdings(network, 0n);
    await connect(dapp, passkey);
    await run(dapp, 'Transaction', 'wallet_sendCalls');

    await button(dapp.page, 'Add funds').click({ timeout: SETTLES });
    await expect(button(dapp.page, 'Done')).toBeVisible();
    await dapp.page.keyboard.press('Escape');
    await rejected(dapp, ADD_FUNDS_REJECTION);
  });

  test('cancelling a short request rejects it as usual', async ({ dapp, network, passkey }) => {
    holdings(network, 0n);
    await connect(dapp, passkey);
    await run(dapp, 'Transaction', 'wallet_sendCalls');
    await expect(button(dapp.page, 'Add funds')).toBeEnabled({ timeout: SETTLES });

    await button(dapp.page, 'Cancel').last().click();
    await rejected(dapp, 'User rejected the request');
  });

  test('a request the account can pay shows Confirm and no Add funds', async ({ dapp, network, passkey }) => {
    holdings(network, parseEther('1'));
    await connect(dapp, passkey);
    await run(dapp, 'Transaction', 'wallet_sendCalls');

    await expect(button(dapp.page, 'Confirm')).toBeEnabled({ timeout: SETTLES });
    await expect(button(dapp.page, 'Add funds')).toHaveCount(0);

    // Nothing is sent: the request ends the usual way.
    await button(dapp.page, 'Cancel').last().click();
    await rejected(dapp, 'User rejected the request');
  });

  test('a grant the account cannot pay gas for offers Add funds, and X ends it', async ({ dapp, network, passkey }) => {
    holdings(network, 0n);
    await connect(dapp, passkey);
    await run(dapp, 'Permission', 'wallet_grantPermissions');

    await button(dapp.page, 'Add funds').click({ timeout: SETTLES });
    await expect(button(dapp.page, 'Done')).toBeVisible();
    await button(dapp.page, 'Cancel').first().click();
    await rejected(dapp, ADD_FUNDS_REJECTION);
  });
});
