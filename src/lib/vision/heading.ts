/**
 * The heading of the reference camera (automation plan section 7). Every compass reading of a frame, with the yaw of
 * that frame against the reference from the stabilization, gives an interval for the reference heading, because the
 * display shows whole degrees. The intervals of all frames overlap in a narrow band once the display changes during the
 * section. A reading that disagrees with most others (a misread) drops out.
 */
import { wrap360 } from '../solver/camera.ts';
import { cameraToWorld, frameCamera, type Mat3 } from './rotation.ts';

/**
 * How the game turns a heading into its display. With `round` it shows 197 from 196.5 on, with `floor` from 197.0 on.
 * The capture test decides it (capture-test-plan.md section 3.3). The label strip reads 0.27 to 0.29 deg above the
 * truncated fusion on clip 1 (shot 2) and clip 2, and 0.77 to 0.79 above the rounded one. This points to truncation if
 * the strip has a small offset of its own, and truncation fits an integer cast in the game.
 */
export type Rounding = 'round' | 'floor';
export const ROUNDING: Rounding = 'floor';

export interface HeadingFit {
  /** The reference heading (deg), the band it lies in, and the frames that agree with it. */
  heading: number; lo: number; hi: number; sigma: number;
  used: number; readings: number;
}

/** The yaw (deg) of a frame against the reference camera, which is its heading when the reference faces 0. */
export const yawOf = (pitch: number, roll: number, R: Mat3) => {
  const h = frameCamera(cameraToWorld(0, pitch, roll), R).h;
  return h > 180 ? h - 360 : h;
};

/**
 * Fuses the readings. Each reading is the displayed number and the yaw of its frame. The band that the most intervals
 * cover wins. Its middle is the heading, and the heading counts as uniform over the band (sigma = width / sqrt(12)).
 */
export function fuseHeading(readings: { shown: number; yaw: number }[], rounding: Rounding = ROUNDING): HeadingFit | null {
  if (!readings.length) return null;
  const [off0, off1] = rounding === 'round' ? [-0.5, 0.5] : [0, 1];
  // intervals of the reference heading, unwrapped near the first one
  const first = readings[0].shown - readings[0].yaw;
  const iv = readings.map((r) => {
    let lo = r.shown + off0 - r.yaw;
    lo += Math.round((first - lo) / 360) * 360;
    return [lo, lo + (off1 - off0)] as [number, number];
  });
  // a sweep finds the part that the most intervals cover
  const ev = iv.flatMap(([a, b]) => [[a, 1], [b, -1]] as [number, number][]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  let n = 0, bestN = 0, lo = 0, hi = 0;
  for (let k = 0; k < ev.length; k++) {
    n += ev[k][1];
    if (n > bestN) { bestN = n; lo = ev[k][0]; hi = ev[k + 1]?.[0] ?? lo; }
  }
  const width = Math.max(hi - lo, 1e-3);
  return { heading: wrap360((lo + hi) / 2), lo, hi, sigma: width / Math.sqrt(12), used: bestN, readings: readings.length };
}

/**
 * The heading from the compass label strip (Appendix A.4), which has a label every 15 deg at 14.77 px per degree
 * (2160p). It is the fallback and the absolute check of the rounding rule. It reads to about +/-0.3 deg, and it does not
 * work on bright sky.
 */
export function stripHeading(g: { data: ArrayLike<number>; w: number; h: number }, shown: number): number | null {
  const s = g.h / 2160, k = 14.767 * s, cx = g.w / 2;
  const y0 = Math.round(30 * s), y1 = Math.round(110 * s), band = y1 - y0;
  // rows 30 to 110, minus a blur (sigma 6), summed over rows 22 to 58 of the band
  const col = new Float64Array(g.w);
  const sig = 6 * s, r = Math.ceil(3 * sig), wts = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sig * sig)));
  const wsum = wts.reduce((a, b) => a + b, 0);
  for (let yy = Math.round(22 * s); yy < Math.round(58 * s) && yy < band; yy++) {
    const y = y0 + yy;
    for (let x = r; x < g.w - r; x++) {
      // a 2-D blur is a 1-D blur twice. The vertical part matters little on a thin band, so this blurs along x only.
      let b = 0;
      for (let i = -r; i <= r; i++) b += wts[i + r] * g.data[y * g.w + x + i];
      col[x] += Math.abs(g.data[y * g.w + x] - b / wsum);
    }
  }
  const sum = (a: number, b: number) => { let t = 0; for (let x = Math.max(0, Math.round(a)); x < Math.min(g.w, Math.round(b)); x++) t += col[x]; return t; };
  let best: { h: number; score: number } | null = null;
  for (let h = shown - 1.5; h <= shown + 1.5; h += 0.01) {
    let score = 0;
    for (let L = Math.ceil((shown - 45) / 15) * 15; L <= shown + 45; L += 15) {
      const x = cx + k * (L - h);
      if (Math.abs(x - cx) < 110 * s || x < cx - 770 * s || x > cx + 780 * s) continue;
      score += sum(x - 26 * s, x + 27 * s) - 0.5 * (sum(x - 60 * s, x - 30 * s) + sum(x + 30 * s, x + 60 * s));
    }
    if (!best || score > best.score) best = { h, score };
  }
  return best && best.score > 0 ? wrap360(best.h) : null;
}
