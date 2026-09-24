/** Gray images for the detection. Deterministic, without I/O. */

export interface Gray8 { data: Uint8Array; w: number; h: number }
export interface GrayF { data: Float32Array; w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** A mask image: 1 where the pixel counts, 0 where it does not. */
export type Mask = Gray8;

/** Half the size, each pixel the mean of 2 x 2. */
export function half(g: Gray8): Gray8 {
  const w = g.w >> 1, h = g.h >> 1, out = new Uint8Array(w * h), s = g.data, W = g.w;
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * W, r1 = r0 + W;
    for (let x = 0; x < w; x++) out[y * w + x] = (s[r0 + 2 * x] + s[r0 + 2 * x + 1] + s[r1 + 2 * x] + s[r1 + 2 * x + 1] + 2) >> 2;
  }
  return { data: out, w, h };
}

/** The value at a subpixel position, bilinear. Outside the image: NaN. */
export function sample(g: { data: ArrayLike<number>; w: number; h: number }, x: number, y: number): number {
  if (x < 0 || y < 0 || x > g.w - 1 || y > g.h - 1) return NaN;
  const x0 = Math.min(g.w - 2, Math.floor(x)), y0 = Math.min(g.h - 2, Math.floor(y)), fx = x - x0, fy = y - y0, i = y0 * g.w + x0;
  return (g.data[i] * (1 - fx) + g.data[i + 1] * fx) * (1 - fy) + (g.data[i + g.w] * (1 - fx) + g.data[i + g.w + 1] * fx) * fy;
}

/** The median of the values of a list. */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
}
