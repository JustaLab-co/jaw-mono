'use client';

import { useMemo } from 'react';
import { buildQrPath } from '../../utils/qrPath';

/**
 * Edge of the centre overlay, as a fraction of the code's width.
 *
 * At 0.26 the overlay covers ~6.8% of the code's area, still far inside what
 * level 'H' error correction absorbs (~30%). Wide enough that the caller can
 * spend some of it on padding and still leave a legible image.
 */
const CENTER_FRACTION = 0.26;

export interface QrCodeProps {
  /** The payload. For the receive screen this is an EIP-681 URI. */
  value: string;
  /** Rendered edge length in px. The SVG scales to it, so any size stays crisp. */
  size?: number;
  /**
   * Laid over the middle of the finished code, given the overlay's size in px.
   *
   * An overlay, not a hole: the code is encoded once from `value` alone, so
   * something arriving late (the ENS avatar resolves after the dialog opens)
   * appears on top without re-encoding the code under a camera already pointed
   * at it. Error correction absorbs the occlusion.
   */
  renderCenter?: (sizePx: number) => React.ReactNode;
  /** Accessible name. Describes the code rather than reading the URI aloud. */
  label?: string;
}

/**
 * The receive QR, drawn as an SVG path built from `qrcode-generator`'s module
 * matrix (see `utils/qrPath`).
 *
 * Rendering it here rather than using the library's own `createSvgTag` keeps its
 * markup out of the DOM: no `dangerouslySetInnerHTML`, and no inline styles of
 * its making.
 */
export function QrCode({ value, size = 220, renderCenter, label }: QrCodeProps) {
  const { path, count } = useMemo(() => buildQrPath(value), [value]);

  const overlayPx = Math.round(size * CENTER_FRACTION);

  return (
    <div className="relative" style={{ width: size, height: size }}>
      {/* Authored in module units and scaled by the viewBox, so the path is
          independent of the pixel size and a resize re-encodes nothing. */}
      <svg
        viewBox={`0 0 ${count} ${count}`}
        width={size}
        height={size}
        role="img"
        aria-label={label ?? 'QR code for this address'}
        // Adjacent modules must not leave hairline seams between them, which is
        // what a scanner reads as a broken module.
        shapeRendering="crispEdges"
        // No colour of its own: the modules paint in the inherited currentColor,
        // so whoever supplies the plate decides the contrast. Setting a themed
        // colour here is what inverted the code in dark mode.
        className="block"
      >
        <path d={path} fill="currentColor" />
      </svg>
      {renderCenter && (
        <div
          className="pointer-events-none absolute left-1/2 top-1/2"
          style={{
            width: overlayPx,
            height: overlayPx,
            // Centred by translate rather than inset-0 so the box is exactly the
            // overlay, which is what bounds what goes inside it.
            transform: 'translate(-50%, -50%)',
          }}
        >
          {renderCenter(overlayPx)}
        </div>
      )}
    </div>
  );
}
