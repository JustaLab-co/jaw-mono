import { describe, expect, it } from 'vitest';
import qrcode from 'qrcode-generator';
import { buildQrPath } from './qrPath';
import { eip681Uri } from './eip681';

const ADDRESS = '0x1111111111111111111111111111111111111111';

/** Every `M<col>,<row>` in a path, as a set of "col,row" keys. */
function modules(path: string): Set<string> {
  return new Set([...path.matchAll(/M(\d+),(\d+)/g)].map((m) => `${m[1]},${m[2]}`));
}

describe('eip681Uri', () => {
  it('puts the chain in the payload, not just in the label', () => {
    expect(eip681Uri(ADDRESS, 8453)).toBe(`ethereum:${ADDRESS}@8453`);
  });
});

describe('buildQrPath', () => {
  it('encodes to a square matrix of odd extent', () => {
    const { count } = buildQrPath(eip681Uri(ADDRESS, 8453));
    // QR versions are 21 + 4n modules per side, so always odd and at least 21.
    expect(count).toBeGreaterThanOrEqual(21);
    expect(count % 2).toBe(1);
  });

  it('draws modules', () => {
    const { path } = buildQrPath(eip681Uri(ADDRESS, 8453));
    expect(modules(path).size).toBeGreaterThan(100);
  });

  // The three finder patterns are what a scanner locks onto first. Their outer
  // corners are always dark, so a path missing them is unscannable.
  it('keeps the finder patterns in all three corners', () => {
    const { path, count } = buildQrPath(eip681Uri(ADDRESS, 8453));
    const drawn = modules(path);
    expect(drawn.has('0,0')).toBe(true);
    expect(drawn.has(`${count - 1},0`)).toBe(true);
    expect(drawn.has(`0,${count - 1}`)).toBe(true);
  });

  // A different chain has to produce a different code, or the payload's whole
  // point (the scanner picking the network) is lost.
  it('changes the code when the chain changes', () => {
    const base = buildQrPath(eip681Uri(ADDRESS, 8453));
    const optimism = buildQrPath(eip681Uri(ADDRESS, 10));
    expect(optimism.path).not.toBe(base.path);
  });

  // The centre logo is laid over the finished code, never cut out of it: the
  // ENS avatar resolves after the dialog opens, and a reserved hole meant
  // re-encoding the code under a camera already pointed at it.
  it('is complete: the same payload always gives the same code', () => {
    const value = eip681Uri(ADDRESS, 8453);
    expect(buildQrPath(value)).toEqual(buildQrPath(value));
  });

  // Everything above is symmetric under a transpose or a mirror: corners, a
  // count, a module total, and a central band all survive swapping the axes, so
  // `M${row},${col}` in place of `M${col},${row}` passed the whole file while
  // producing an unscannable code. The matrix itself is the only oracle, so it
  // is re-encoded here and compared cell by cell.
  it('draws each module at its own coordinate, x then y', () => {
    const value = eip681Uri(ADDRESS, 8453);
    const { path, count } = buildQrPath(value);
    const drawn = modules(path);

    const qr = qrcode(0, 'H');
    qr.addData(value);
    qr.make();
    expect(qr.getModuleCount()).toBe(count);

    // The teeth: a matrix that happened to equal its own transpose would make
    // the comparison below pass either way round.
    let asymmetric = 0;
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col) !== qr.isDark(col, row)) asymmetric++;
      }
    }
    expect(asymmetric).toBeGreaterThan(0);

    const wrong: string[] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        // `M<col>,<row>`: the path is in SVG coordinates, where x comes first,
        // and `isDark` takes the row first.
        if (drawn.has(`${col},${row}`) !== qr.isDark(row, col)) wrong.push(`${col},${row}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('leaves no gap in the middle', () => {
    const { path, count } = buildQrPath(eip681Uri(ADDRESS, 8453));
    const drawn = modules(path);
    const middle = (count - 1) / 2;

    // Not every centre module is dark, but a cleared square would leave a run
    // of ~9 blank rows through the middle. One dark module in the central band
    // is enough to show nothing was cut out.
    let darkInBand = 0;
    for (let row = middle - 4; row <= middle + 4; row++) {
      for (let col = middle - 4; col <= middle + 4; col++) {
        if (drawn.has(`${col},${row}`)) darkInBand++;
      }
    }
    expect(darkInBand).toBeGreaterThan(0);
  });
});
