import type { Page } from '@playwright/test';

import { ACCOUNT, Dapp, expect, HTTPS, KEYS_URL, keys, signOutKeysSession, test, type Dialog } from './fixtures';

/**
 * The SDK and the keys app together, through the playground, with a passkey
 * the test owns. Chromium only: the virtual authenticator is a CDP feature.
 *
 * Every request must settle. A dialog that neither answers nor closes leaves
 * the dApp waiting forever, and neither side times out, so each test bounds
 * how long the dApp may wait for its answer.
 */

/** How long a dApp may wait on a dialog before the test calls it a hang. */
const SETTLES = 15_000;

test.describe('connect', () => {
  test('signs in with the passkey and returns the account', async ({ dapp }) => {
    const dialog = await dapp.execute();
    await keys.account(dialog).click();
    await keys.button(dialog, 'Connect').click();

    await expect(dapp.result()).toHaveText(/^OK/, { timeout: SETTLES });
    await expect(dapp.response()).toContainText(new RegExp(ACCOUNT, 'i'));
  });

  test('a cached connection answers without opening a dialog', async ({ dapp, context }) => {
    const dialog = await dapp.execute();
    await keys.account(dialog).click();
    await keys.button(dialog, 'Connect').click();
    await expect(dapp.result()).toHaveText(/^OK/, { timeout: SETTLES });

    await dapp.page.reload();
    const opened: string[] = [];
    context.on('page', (page) => opened.push(page.url()));
    await dapp.open();
    await dapp.executeWithoutDialog();

    await expect(dapp.result()).toHaveText(/^OK/, { timeout: SETTLES });
    expect(opened).toEqual([]);
  });

  // The hang this suite was written for. An SDK holding an expired connection
  // sent wallet_connect encrypted over the old session, and keys had no screen
  // for it, so the dialog sat on the loading skeleton until site data was cleared.
  test('an expired connection shows the account screen instead of hanging', async ({ dapp }) => {
    const first = await dapp.execute();
    await keys.account(first).click();
    await keys.button(first, 'Connect').click();
    await expect(dapp.result()).toHaveText(/^OK/, { timeout: SETTLES });

    await dapp.expireConnection();
    const dialog = await dapp.execute();

    await expect(keys.accountScreen(dialog)).toBeVisible({ timeout: SETTLES });
    await keys.account(dialog).click();
    await approveIfAsked(dapp, dialog);
    await expect(dapp.result()).toHaveText(/^OK/, { timeout: SETTLES });
    await expect(dapp.response()).toContainText(new RegExp(ACCOUNT, 'i'));
  });
});

test.describe('sign', () => {
  test('signs a message after connecting', async ({ dapp }) => {
    await connect(dapp);

    await dapp.select('Signing', 'personal_sign');
    const dialog = await dapp.execute();
    await keys.button(dialog, 'Sign').click();

    await expect(dapp.result()).toHaveText(/^OK/, { timeout: SETTLES });
    await expect(dapp.response()).toContainText(/^0x[0-9a-f]+/i);
  });

  // Keys that still decrypt with no signed-in account behind them. The signing
  // modal needs an account, so without one the dialog sat on the skeleton.
  test('a keys session with no signed-in account asks to sign in first', async ({ dapp, context }) => {
    await connect(dapp);
    await signOutKeysSession(context);

    await dapp.select('Signing', 'personal_sign');
    const dialog = await dapp.execute();
    await expect(keys.accountScreen(dialog)).toBeVisible({ timeout: SETTLES });
    await keys.account(dialog).click();
    await keys.button(dialog, 'Sign').click();

    await expect(dapp.result()).toHaveText(/^OK/, { timeout: SETTLES });
  });
});

test.describe('back to back', () => {
  // The dialog closes itself a moment after a flow ends. A request sent in that
  // window reuses it, and the pending close must not take the new request with it.
  test('a sign right after the connect reuses the closing dialog and shows its screen', async ({ dapp }) => {
    const dialog = await dapp.execute();
    await keys.account(dialog).click();
    await keys.button(dialog, 'Connect').click();
    await expect(dapp.result()).toHaveText(/^OK/, { timeout: SETTLES });

    await dapp.select('Signing', 'personal_sign');
    const signer = await dapp.executeAfter(dialog);
    await keys.button(signer, 'Sign').click({ timeout: SETTLES });

    await expect(dapp.result()).toHaveText(/^OK/, { timeout: SETTLES });
  });
});

test.describe('errors: the dApp always gets an answer', () => {
  test('closing the account screen rejects the connect', async ({ dapp }) => {
    const dialog = await dapp.execute();
    await keys.close(dialog).click();

    await expect(dapp.result()).toHaveText(/^Error/, { timeout: SETTLES });
    await expect(dapp.response()).toContainText(/reject/i);
  });

  test('closing the popup window rejects the connect', async ({ dapp }) => {
    test.skip(HTTPS, 'the embedded dialog has no window to close');
    const dialog = await dapp.execute();
    await expect(keys.accountScreen(dialog)).toBeVisible({ timeout: SETTLES });
    await (dialog as Page).close();

    await expect(dapp.result()).toHaveText(/^Error/, { timeout: SETTLES });
  });

  // Nobody answers the passkey prompt, so the ceremony runs to its 60s timeout.
  test('a passkey prompt that times out keeps the dialog open, and closing it rejects', async ({ dapp, passkey }) => {
    test.slow();
    const dialog = await dapp.execute();
    await expect(keys.accountScreen(dialog)).toBeVisible({ timeout: SETTLES });
    await passkey.refuse();
    await keys.account(dialog).click();

    // The user can still pick another account or give up: nothing was answered yet.
    await expect(keys.accountScreen(dialog)).toBeVisible();
    await expect(dapp.result()).toHaveCount(0);
    await keys.close(dialog).click();
    await expect(dapp.result()).toHaveText(/^Error/, { timeout: SETTLES });
  });

  test('the RPC failing during sign-in does not leave the dApp waiting', async ({ dapp, network }) => {
    const dialog = await dapp.execute();
    await expect(keys.accountScreen(dialog)).toBeVisible({ timeout: SETTLES });
    network.rpcDown = true;
    await keys.account(dialog).click();

    // The sign-in reached the RPC and got the failure, and the dialog is still usable.
    await expect.poll(() => network.rpcFailures, { timeout: SETTLES }).toBeGreaterThan(0);
    await expect(keys.account(dialog)).toBeVisible({ timeout: SETTLES });
    await expect(dapp.result()).toHaveCount(0);
    await keys.close(dialog).click();
    await expect(dapp.result()).toHaveText(/^Error/, { timeout: SETTLES });
  });

  test('cancelling the signature rejects it', async ({ dapp }) => {
    await connect(dapp);

    await dapp.select('Signing', 'personal_sign');
    const dialog = await dapp.execute();
    await keys.button(dialog, 'Cancel').last().click();

    await expect(dapp.result()).toHaveText(/^Error/, { timeout: SETTLES });
    await expect(dapp.response()).toContainText(/reject/i);
  });

  test('an unreachable keys app fails the request instead of hanging', async ({ dapp, context }) => {
    test.slow();
    await context.route(`${KEYS_URL}/**`, (route) => route.abort());
    await dapp.executeWithoutDialog();

    // The handshake gives up (the iframe falls back to a popup that cannot load
    // either, and the popup waits 60s); the dApp must hear about it.
    await expect(dapp.result()).toHaveText(/^Error/, { timeout: 90_000 });
  });
});

/**
 * Approves the Connect screen when there is one. The embedded dialog skips it
 * for the account the dApp is already connected as ("Continue as"): the
 * passkey is the approval, and the connect resolves right after it.
 */
async function approveIfAsked(dapp: Dapp, dialog: Dialog) {
  const connect = keys.button(dialog, 'Connect');
  await expect
    .poll(async () => (await connect.isVisible()) || (await dapp.result().count()) > 0, { timeout: SETTLES })
    .toBe(true);
  if (await connect.isVisible()) await connect.click();
}

/** Connects and waits for the dialog to close, so the next request starts clean. */
async function connect(dapp: Dapp) {
  const dialog = await dapp.execute();
  await keys.account(dialog).click();
  await keys.button(dialog, 'Connect').click();
  await expect(dapp.result()).toHaveText(/^OK/, { timeout: SETTLES });
  await dapp.closed(dialog);
}
