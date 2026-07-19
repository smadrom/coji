/**
 * Split a single generated image into a 2x2 grid of 4 quadrant frames.
 *
 * Strategy (per the product decision): instead of generating 4 separate frames
 * — where feeding frame 0 back as a reference makes the model reproduce the same
 * angle — we generate ONE image that is a 2x2 contact sheet of 4 different shots
 * of the same person, then crop it into 4 frames. One generation → guaranteed
 * same person, genuinely different angles, and a single (cheaper) provider call.
 *
 * Cropping combines two cheap, model-free passes (jimp, pure JS):
 *   1. gutter-detection — find the most uniform row/column near the centre (a
 *      seam/divider the model may have drawn) and cut there, not at the exact
 *      geometric middle;
 *   2. inset — trim a few % off every quadrant edge to remove the seam and any
 *      thin border artifacts.
 */
import { Jimp } from 'jimp';

const INSET_FRAC = 0.03; // trim this fraction off each outer edge
const GUTTER_HALF_FRAC = 0.015; // half-width of the cut removed around the seam
const SEARCH_FRAC = 0.1; // search the seam within ±10% of the centre

interface Bitmap {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** Mean luminance variance of a vertical column — low = uniform (a seam). */
function columnUniformity(bmp: Bitmap, x: number): number {
  const { data, width, height } = bmp;
  let sum = 0;
  let sumSq = 0;
  for (let y = 0; y < height; y++) {
    const i = (y * width + x) * 4;
    const lum = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
    sum += lum;
    sumSq += lum * lum;
  }
  const mean = sum / height;
  return sumSq / height - mean * mean; // variance
}

/** Mean luminance variance of a horizontal row — low = uniform (a seam). */
function rowUniformity(bmp: Bitmap, y: number): number {
  const { data, width } = bmp;
  let sum = 0;
  let sumSq = 0;
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const lum = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
    sum += lum;
    sumSq += lum * lum;
  }
  const mean = sum / width;
  return sumSq / width - mean * mean;
}

/** Find the seam coordinate: argmin uniformity within ±SEARCH_FRAC of centre. */
function findSeam(size: number, score: (k: number) => number): number {
  const centre = Math.floor(size / 2);
  const win = Math.max(1, Math.floor(size * SEARCH_FRAC));
  let best = centre;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let k = centre - win; k <= centre + win; k++) {
    if (k <= 0 || k >= size - 1) continue;
    const s = score(k);
    if (s < bestScore) {
      bestScore = s;
      best = k;
    }
  }
  return best;
}

/** Crop `bytes` into [top-left, top-right, bottom-left, bottom-right] PNGs. */
export async function splitInto4(bytes: Uint8Array): Promise<Uint8Array[]> {
  const img = await Jimp.read(Buffer.from(bytes));
  const bmp = img.bitmap as Bitmap;
  const W = bmp.width;
  const H = bmp.height;

  const seamX = findSeam(W, (x) => columnUniformity(bmp, x));
  const seamY = findSeam(H, (y) => rowUniformity(bmp, y));

  const insetX = Math.round(W * INSET_FRAC);
  const insetY = Math.round(H * INSET_FRAC);
  const gutterX = Math.round(W * GUTTER_HALF_FRAC);
  const gutterY = Math.round(H * GUTTER_HALF_FRAC);

  // Available width/height of each side, dropping the inset (outer) and the
  // gutter (inner seam). Use the SMALLER side so all 4 panels are identical in
  // size — and anchor each crop to its OUTER corner so the inner seam strip is
  // the part that gets dropped (that dark sliver near the centre).
  const leftW = seamX - gutterX - insetX;
  const rightW = W - insetX - (seamX + gutterX);
  const topH = seamY - gutterY - insetY;
  const botH = H - insetY - (seamY + gutterY);
  const panelW = Math.max(1, Math.min(leftW, rightW));
  const panelH = Math.max(1, Math.min(topH, botH));

  // Outer-anchored origins (TL, TR, BL, BR) — all crops are panelW × panelH.
  const origins: Array<{ x: number; y: number }> = [
    { x: insetX, y: insetY },
    { x: W - insetX - panelW, y: insetY },
    { x: insetX, y: H - insetY - panelH },
    { x: W - insetX - panelW, y: H - insetY - panelH },
  ];

  const out: Uint8Array[] = [];
  for (const o of origins) {
    const quad = img
      .clone()
      .crop({ x: Math.max(0, o.x), y: Math.max(0, o.y), w: panelW, h: panelH });
    const buf = await quad.getBuffer('image/png');
    out.push(new Uint8Array(buf));
  }
  return out;
}
