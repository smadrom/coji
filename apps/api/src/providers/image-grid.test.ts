import { describe, expect, test } from 'bun:test';
import { Jimp } from 'jimp';
import { splitInto4 } from './image-grid.ts';

/** Build a 2x2 grid: 4 distinct quadrant colours + a white seam cross. */
async function makeGrid(size = 120): Promise<Uint8Array> {
  const img = new Jimp({ width: size, height: size, color: 0x000000ff });
  const half = size / 2;
  const seamLo = Math.floor(half) - 2;
  const seamHi = Math.floor(half) + 2;
  const colours = {
    tl: [200, 40, 40],
    tr: [40, 200, 40],
    bl: [40, 40, 200],
    br: [200, 200, 40],
  } as const;
  const d = img.bitmap.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const seam = (x >= seamLo && x <= seamHi) || (y >= seamLo && y <= seamHi);
      let c: readonly [number, number, number];
      if (seam) c = [255, 255, 255];
      else if (x < half && y < half) c = colours.tl;
      else if (x >= half && y < half) c = colours.tr;
      else if (x < half) c = colours.bl;
      else c = colours.br;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  }
  return new Uint8Array(await img.getBuffer('image/png'));
}

/** Average RGB of a PNG buffer. */
async function avgColour(bytes: Uint8Array): Promise<[number, number, number]> {
  const img = await Jimp.read(Buffer.from(bytes));
  const d = img.bitmap.data;
  let r = 0;
  let g = 0;
  let b = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i] ?? 0;
    g += d[i + 1] ?? 0;
    b += d[i + 2] ?? 0;
  }
  return [r / n, g / n, b / n];
}

const isWhitish = ([r, g, b]: [number, number, number]) => r > 220 && g > 220 && b > 220;

describe('splitInto4', () => {
  test('crops a grid into 4 quadrants with the seam removed', async () => {
    const grid = await makeGrid(120);
    const quads = await splitInto4(grid);
    expect(quads).toHaveLength(4);

    const colours = await Promise.all(quads.map(avgColour));
    // None of the quadrants is dominated by the white seam.
    for (const c of colours) expect(isWhitish(c)).toBe(false);

    // Each quadrant's dominant channel matches its source colour.
    const [tl, tr, bl, br] = colours as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    expect(tl[0]).toBeGreaterThan(tl[1]); // TL red-dominant
    expect(tr[1]).toBeGreaterThan(tr[0]); // TR green-dominant
    expect(bl[2]).toBeGreaterThan(bl[0]); // BL blue-dominant
    expect(br[0]).toBeGreaterThan(br[2]); // BR yellow (r,g > b)
    expect(br[1]).toBeGreaterThan(br[2]);
  });

  test('quadrants are smaller than half the source (inset applied)', async () => {
    const grid = await makeGrid(120);
    const quads = await splitInto4(grid);
    const dims = await Promise.all(
      quads.map(async (q) => {
        const im = await Jimp.read(Buffer.from(q));
        return `${im.bitmap.width}x${im.bitmap.height}`;
      }),
    );
    // All four crops are identical in size, and smaller than half the source.
    expect(new Set(dims).size).toBe(1);
    const first = await Jimp.read(Buffer.from(quads[0] as Uint8Array));
    expect(first.bitmap.width).toBeLessThan(60);
    expect(first.bitmap.height).toBeLessThan(60);
  });
});
