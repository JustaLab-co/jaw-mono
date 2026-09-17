import qrcode from 'qrcode-generator';

export interface QrPath {
  /** SVG path data in module units, one subpath per dark module. */
  path: string;
  /** Modules per side, which is also the viewBox extent. */
  count: number;
}

/**
 * Encodes `value` and returns one `<path>` covering every dark module.
 *
 * A single path rather than a rect per module because a 41x41 code is over 1600
 * elements, and the dialog re-renders on every ENS resolution and theme change.
 *
 * Error correction is fixed at 'H': a phone camera reads this off a screen at an
 * angle, often smaller than intended, and anything laid over the middle eats
 * part of the budget.
 *
 * The code is always complete. Nothing is cleared for a centre logo, because
 * clearing depends on knowing whether a logo will arrive: the ENS avatar
 * resolves after the dialog opens, so a reserved hole meant re-encoding the code
 * under a camera already pointed at it. A logo is laid over the finished code
 * instead, which error correction absorbs exactly as it would a cleared square.
 */
export function buildQrPath(value: string): QrPath {
  // typeNumber 0 lets the library pick the smallest version that fits.
  const qr = qrcode(0, 'H');
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();

  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col},${row}h1v1h-1z`;
    }
  }

  return { path, count };
}
