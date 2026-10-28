import {
  type PermissionsConfig,
  type OrphanedPermission,
  whyOwnerCannotFundSession,
  whySpenderCannotPay,
  parseGrantedPermission,
  droppedCheckers,
  whyCheckersDropped,
} from '@jaw.id/agent';
import { apiKeyFor } from './api-key.js';
import { loadConfig } from './config.js';
import { getBridge } from './bridge-singleton.js';
import { generateSessionKey, saveKeystore } from './keystore.js';
import { saveSessionConfig } from './session-config.js';
import { usdcBaseUnits } from '../x402/balance.js';

export interface SessionGrantInput {
  chainId: number;
  /** Already resolved and checked against the grant ceiling. */
  permissions: PermissionsConfig;
  expiryDays: number;
  /** Turns on the owner-funds check before the grant and the spender-funded check after it. */
  x402: boolean;
  reuseKey: `0x${string}` | null;
  orphaned: OrphanedPermission[];
  /** The key the bridge opens with. */
  apiKey?: string;
  /** Re-read after the bridge, which can write a new key to config. */
  apiKeyFlag?: string;
  /** Called right before the browser opens. */
  onBrowser?: () => void;
  /** Called with the wallet URL when a new browser session is opened. */
  onUrl?: (url: string) => void;
}

export interface SessionGrantResult {
  ownerAddress: string;
  sessionAddress: `0x${string}`;
  permissionId: string;
  chainId: number;
  expiry: number;
  mode: 'eip7702';
  /** Why the session cannot pay for its own first operation, or null. Only checked under x402. */
  unfunded: string | null;
}

/** A refusal meant for the person running the grant, as opposed to a failure. */
export class SessionGrantRefusal extends Error {}

/**
 * Generates or reuses the session key, has the owner grant it the permissions
 * through the browser, and saves the keystore and session config. Writes
 * nothing to stdout.
 */
export async function grantSession(input: SessionGrantInput): Promise<SessionGrantResult> {
  const { chainId, permissions, x402, orphaned } = input;
  const config = loadConfig();
  const expiry = Math.floor(Date.now() / 1000) + input.expiryDays * 86400;
  const privateKeyHex = input.reuseKey ?? generateSessionKey();

  const { privateKeyToAccount } = await import('viem/accounts');
  const localAccount = privateKeyToAccount(privateKeyHex);

  input.onBrowser?.();

  // EIP-7702 keeps the session address equal to the session key EOA, with
  // the delegation riding the first userOp. That is what lets the account
  // holding the USDC be the same one the ERC-20 paymaster charges for the
  // ops it sends; the factory's counterfactual address was a second one
  // that never held anything.
  const mode = 'eip7702' as const;

  const bridge = await getBridge({
    keysUrl: config.keysUrl,
    apiKey: input.apiKey,
    chainId,
    ens: config.ens,
    onUrl: input.onUrl,
  });

  // Everything from here to the grant is inside the block that closes the
  // bridge. It used to start further down, and the two steps above it can
  // both throw: the refusal when no key came back, and building the account.
  // Either one left the socket open and the browser still showing a paired
  // page, with nothing to tell it otherwise.
  let sessionAddress: `0x${string}`;
  // Kept whole rather than narrowed on the way in. The response carries the
  // permission as the contract stores it, and every view on the permission
  // manager takes that struct: narrowing to the id here was what left the
  // CLI unable to ask the chain anything about its own permission.
  let granted: unknown;
  let dropped: ReturnType<typeof droppedCheckers> = [];
  let unrevoked: string | undefined;
  try {
    // Read off disk after the bridge rather than reused from the snapshot
    // taken before it. The bridge is what fills in a key on a machine that
    // had none, and what replaces one the deployment has rotated since;
    // reusing the snapshot would leave the account building its rpcUrl and
    // paymaster url from a key that is no longer the right one, and logging
    // its issuance against it.
    const resolvedApiKey = apiKeyFor(loadConfig(), input.apiKeyFlag);
    if (!resolvedApiKey) {
      throw new SessionGrantRefusal(
        'Connected, but no API key came back and none is configured. ' +
          'Set one with `jaw config set apiKey <key>` and run this again.'
      );
    }

    const { Account } = await import('@jaw.id/core');
    const pm = config.paymasters?.[chainId];
    const account = await Account.fromLocalAccount(
      {
        chainId,
        apiKey: resolvedApiKey,
        paymasterUrl: pm?.url,
        paymasterContext: pm?.context,
      },
      localAccount,
      { eip7702: true }
    );
    sessionAddress = account.address;

    if (x402) {
      const blocked = await whyOwnerCannotFundSession({
        chainId,
        request: (m, p) => bridge.request(m, p),
        readBalance: usdcBaseUnits,
      });
      if (blocked) throw new SessionGrantRefusal(blocked);
    }

    granted = await bridge.request('wallet_grantPermissions', [
      {
        spender: sessionAddress,
        expiry,
        permissions,
        chainId,
        // The session account sends every op the permission authorises, and
        // the ERC-20 paymaster charges the sender, so its first one has
        // nothing to be charged. The wallet rides a small transfer along in
        // this same transaction; it decides the amount.
        capabilities: { prefundSpender: true },
      },
    ]);

    // A wallet from before checkers grants a checked call with none, a wider rule than the one
    // asked for. Revoked on the bridge that is still open, rather than saved as the session.
    dropped = droppedCheckers(permissions, parseGrantedPermission(granted));
    if (dropped.length > 0) {
      try {
        await bridge.request('wallet_revokePermissions', [{ id: (granted as { permissionId: string }).permissionId }]);
      } catch (err) {
        unrevoked = err instanceof Error ? err.message : String(err);
      }
      if (unrevoked === undefined) {
        throw new SessionGrantRefusal(`${whyCheckersDropped(dropped)} It was revoked, and no session was saved.`);
      }
    }
  } finally {
    bridge.close();
  }

  const grantResponse = granted as { permissionId: string; account: string };
  // Undefined from a wallet whose response does not carry the struct. The
  // session is then saved without it, and its policy falls back to the
  // config defaults instead of the grant's own caps.
  const permission = parseGrantedPermission(granted);

  saveKeystore(privateKeyHex, sessionAddress);
  saveSessionConfig({
    ownerAddress: grantResponse.account,
    sessionAddress,
    permissionId: grantResponse.permissionId,
    chainId,
    expiry,
    mode,
    ...(permission ? { permission } : {}),
    ...(orphaned.length > 0 ? { orphanedPermissions: orphaned } : {}),
  });

  // Saved only so `jaw session revoke` can reach it: the id lives nowhere else.
  if (dropped.length > 0) {
    throw new SessionGrantRefusal(
      `${whyCheckersDropped(dropped)} Revoking it failed (${unrevoked}), so it is saved as the session ` +
        'until you run `jaw session revoke`. Run it now: until then the session key can make those calls unchecked.'
    );
  }

  // The grant asked the wallet to seed the spender. Check that it did.
  //
  // An unsupported capability is ignored rather than refused, so a wallet
  // that does not implement `prefundSpender` leaves the session unable to pay
  // for anything, and says nothing about it. The failure then surfaces at the
  // first operation, in an error about sizing a paymaster approval, long after
  // the user has left this screen. Only under x402: the wallet seeds in
  // whatever token the permission names, and that preset is the one grant
  // that always names USDC. A calls-only permission is correctly seeded with
  // nothing, and warning there would send someone to move real funds for no
  // reason.
  const unfunded = x402
    ? await whySpenderCannotPay({ chainId, spender: sessionAddress, readBalance: usdcBaseUnits })
    : null;

  return {
    ownerAddress: grantResponse.account,
    sessionAddress,
    permissionId: grantResponse.permissionId,
    chainId,
    expiry,
    mode,
    unfunded,
  };
}

/** The part of a replaced session worth keeping: enough to revoke it later. */
export function orphanOf(session: {
  permissionId: string;
  chainId: number;
  expiry: number | null;
}): OrphanedPermission {
  return { id: session.permissionId, chainId: session.chainId, expiry: session.expiry };
}
