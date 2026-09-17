'use client';

import { SUPPORTED_CHAINS } from '@jaw.id/core';
import { ShellDialog } from '../ShellDialog';
import { DialogAppHeader } from '../DialogAppHeader';
import { Button } from '../ui/button';
import { CopyButton } from '../CopyButton';
import { IdentityAvatar } from '../IdentityAvatar';
import { QrCode } from './QrCode';
import { ChainStack } from './ChainStack';
import { ChainIcon } from './ChainIcon';
import { useChainIcons } from '../../hooks/useChainIcons';
import { useReverseIdentity } from '../../hooks/useReverseIdentity';
import { eip681Uri } from '../../utils/eip681';
import { isSafeImageUrl } from '../../utils/safeUrl';
import type { AddFundsDialogProps } from './types';

/**
 * The Add Funds screen: where to send funds, and on which chains.
 *
 * Receive-only by design. There is no fiat rail, no third-party frame, and
 * nothing here reads a balance — the money usually arrives after the user has
 * closed this and gone to an exchange, so a "waiting" state would mostly be
 * wrong. Closing is the normal finish, which is why the only action is Done.
 */
export const AddFundsDialog = ({
  open,
  onOpenChange,
  address,
  chainId,
  mainnetRpcUrl,
  apiKey,
  appName,
  appLogoUrl,
  origin,
  onDone,
}: AddFundsDialogProps) => {
  const chainName = SUPPORTED_CHAINS.find((c) => c.id === chainId)?.name ?? `Chain ${chainId}`;

  // The same all-chain fetch the stack uses, so the header badge costs nothing.
  // `useChainIconURI` asks for one chain, and the capabilities cache keys on the
  // params, so it never shared the stack's entry: opening the screen cost two
  // round trips where one carries every icon.
  const icons = useChainIcons(apiKey);
  const chainIcon = <ChainIcon icon={icons[chainId]} size={24} />;

  // The address renders immediately and the name replaces it if it resolves.
  // Never gated on resolution: a slow or failing lookup must not hold up the
  // one thing the user came here for.
  //
  // `plainName` for the clipboard, `name` for the screen: off mainnet the hook
  // suffixes the display name with `@<chainlabel>`, and `alice.eth@base`
  // resolves nowhere for a sender pasting it into a send field.
  const { name, plainName, avatar } = useReverseIdentity(address, chainId, mainnetRpcUrl);

  // ENS records are attacker-controlled, so the scheme is checked before the URL
  // reaches an <img src>: `isSafeImageUrl` allows only https and data:image.
  const safeAvatar = isSafeImageUrl(avatar) ? avatar : null;

  return (
    <ShellDialog open={open} onOpenChange={onOpenChange} onClose={onDone}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-none px-6 pt-6">
          <DialogAppHeader
            appName={appName}
            appLogoUrl={appLogoUrl}
            origin={origin ?? ''}
            chainName={chainName}
            chainIcon={chainIcon}
          />

          {/* "Receive on" + the chains the address works on. The stack sits on
              the same line as the words it completes, so it reads as one
              sentence rather than a control the user should operate. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <h2 className="text-foreground text-title">Receive on</h2>
            <ChainStack activeChainId={chainId} apiKey={apiKey} />
          </div>
        </div>

        <div className="jaw-scroll min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="flex flex-col items-center gap-4">
            {/* Actually white, with actually dark modules, in both themes.
                `bg-background` + `text-foreground` inverted the code in dark
                mode (light modules on a dark plate), which is out of spec: the
                format expects dark on light and plenty of scanners refuse the
                inverse. `text-black` sets the currentColor the modules paint
                with, so the code stays standard whatever the surface does.

                The padding IS the quiet zone: `buildQrPath` emits no margin and
                the viewBox is the module matrix exactly, so nothing else
                supplies one. ISO/IEC 18004 wants 4 modules, and at 196px over
                41 modules (4.78px each) p-4 gave only 3.35 — p-5 gives 4.18.

                The border stays. It sits outside those 4.18 modules of white,
                so it takes nothing from the quiet zone, and light mode needs it:
                `--jaw-color-popover` is pure white there, so an unbordered white
                plate has no edge at all. */}
            <div className="rounded-card border-border border bg-white p-5 text-black">
              {/* The account's ENS avatar in the middle when it has one, and a
                  solid code when it does not. Modules are only cleared when
                  something is there to fill them — an empty hole reads as a
                  rendering fault, which is why nothing was placed here before.
                  The avatar earns the space because it identifies whose account
                  this is at the moment someone is about to send to it. */}
              <QrCode
                value={eip681Uri(address, chainId)}
                size={196}
                label={`QR code to receive on ${chainName}`}
                renderCenter={
                  safeAvatar
                    ? (px) => (
                        <IdentityAvatar
                          src={safeAvatar}
                          // No fallback, and the white plate belongs to the
                          // image rather than to a wrapper: if the image fails
                          // the centre must be empty rather than showing an
                          // identicon that looks like part of the code, and a
                          // wrapper carrying `bg-white` left a blank white
                          // square sitting on the code instead.
                          fallback={null}
                          // The white border IS the plate: it reads as a quiet
                          // ring between the avatar and the modules, and it is
                          // what hides the modules behind a transparent avatar.
                          // Without it the avatar sits edge to edge on the code
                          // and looks pasted on rather than placed. `bg-white`
                          // covers the same area while the image is loading.
                          //
                          // A border rather than padding because CSS tightens
                          // the radius across it: the image's own corners curve
                          // inside the plate's, which is the nested-radius pair,
                          // on one element. `border-solid` is explicit because
                          // preflight is disabled here, so an unstyled border
                          // would be invisible in a non-Tailwind host.
                          //
                          // Square-ish, not round: the plate sits on a grid of
                          // squares, so a rounded square belongs to the code's
                          // own geometry where a circle fights it.
                          className="rounded-chip border-solid border-white bg-white object-cover"
                          style={{ width: px, height: px, borderWidth: Math.max(3, Math.round(px * 0.12)) }}
                        />
                      )
                    : undefined
                }
              />
            </div>

            <div className="flex w-full flex-col items-center gap-1">
              {/* The ENS name when we have one, above the address it stands
                  for. The address stays visible either way: it is what makes
                  the name checkable. */}
              {name && (
                <p className="text-foreground text-value flex min-w-0 items-center gap-1.5">
                  {/* IdentityAvatar, not a bare <img>: it carries the
                      no-referrer policy these URLs need (an ENS record must not
                      receive the wallet page URL, api-key included) and falls
                      back cleanly when the image fails. */}
                  {/* `size-blob` is the inline account-avatar token (15px).
                      This said `size-blob-sm`, which is not in the size scale at
                      all — it only looked right while the raw <img> also carried
                      width/height attributes to constrain it. */}
                  {safeAvatar && (
                    <IdentityAvatar src={safeAvatar} fallback={null} className="size-blob flex-none rounded-full" />
                  )}
                  <span className="truncate">{name}</span>
                  {/* Copies the name, not the address. A sender pasting into a
                      wallet that resolves ENS wants the name; one pasting into
                      an exchange wants the hex below. Both are one tap. */}
                  <CopyButton value={plainName ?? name} size={13} className="flex-none" label="Copy name" />
                </p>
              )}
              {/* The full address, not a truncated one. Truncation is fine
                  where an address only identifies an account, but here the user
                  is checking what they are about to send money to, and a
                  middle-elided address hides exactly where an attacker would
                  differ. Mono so the characters line up for that check. */}
              <p className="text-muted-foreground text-body-xs flex min-w-0 items-start gap-1.5 font-mono">
                <span className="select-all break-all text-center">{address}</span>
                <CopyButton value={address} size={13} className="mt-0.5 flex-none" label="Copy address" />
              </p>
            </div>
          </div>
        </div>

        <div className="border-border/40 flex-none border-t px-6 pb-5 pt-3">
          <Button onClick={onDone} className="rounded-box text-button h-10 w-full font-semibold focus-visible:ring-1">
            Done
          </Button>
        </div>
      </div>
    </ShellDialog>
  );
};

export * from './types';
