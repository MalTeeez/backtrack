/**
 * Where the user stood, and the map, from the minimap (automation plan section 10, Appendix A.6). The minimap is
 * north-up with the player arrow at a fixed point, so the position is the offset of the map under the arrow. A local
 * contrast normalization removes the team tint; a mask removes the icons, the zone borders, the arrows and the NAV
 * text. Normalized cross-correlation against the map tiles finds the offset, over the minimap zoom levels.
 */
import { using, type CV } from './cv.ts';
import { ARROW } from './hud.ts';
import { peakOffset } from './shell.ts';
import type { Gray8 } from './image.ts';
import { quadratic } from '../solver/camera.ts';
import type { MapId } from '../solver/types.ts';

/** The tile pyramid of a map (tools/fetch-map-data.ts): 256 px tiles over tileBounds, in game units. */
export interface MapInfo {
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  tileBounds: { minX: number; maxX: number; minY: number; maxY: number };
  tileSize: number; maxZoom: number;
}
/** Loads a tile as gray, or null when it is missing. The worker fetches, the tests read files. */
export type TileLoader = (map: MapId, z: number, x: number, y: number) => Promise<Gray8 | null>;

/**
 * The minimap zoom levels (m per minimap pixel at 2160p), measured on test-data/recording-test-clips/minimap/
 * (Bakurani: 0.196, 0.349, 0.782 and 2.64; capture-test-plan.md section 3.2), and on clip 1 (Ozeti: 0.505). The levels
 * seem to differ per map, so the search tries all of them on every map, and a wide range when none matches.
 */
export const MINIMAP_LEVELS = [0.196, 0.349, 0.505, 0.782, 2.64];
/** The scales of the search near the levels: 3 percent around each. */
export const levelScales = () => MINIMAP_LEVELS.flatMap((l) => [0.97 * l, l, 1.03 * l]);
/** The wide range, for a map whose levels are not known: 0.18 to 3 m/px in steps of 6 percent. */
export const wideScales = () => Array.from({ length: 49 }, (_, k) => 0.18 * 1.06 ** k);

export interface Template { g: Gray8; mask: Uint8Array; /** The arrow in the template (px). */ arrow: { x: number; y: number } }

/** sRGB to CIE L*a*b* (D65), with L, a, b scaled as OpenCV does for 8-bit images (L 0..255, a and b offset by 128). */
function lab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [(116 * y - 16) * 2.55, 500 * (x - y) + 128, 200 * (y - z) + 128];
}

/**
 * The template of several minimap crops (RGBA): their median in gray, and a mask of the map pixels. Icons, zone
 * borders and the hot zone differ in color from the median of the crop; arrows and black icons are very bright or very
 * dark; the NAV text sits at the bottom right. The mask of every crop counts, which also removes what moves.
 */
export function minimapTemplate(crops: { data: Uint8ClampedArray; w: number; h: number }[]): Template {
  const { w, h } = crops[0], n = w * h;
  const gray = new Uint8Array(n), mask = new Uint8Array(n).fill(1), vals = new Uint8Array(crops.length);
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < crops.length; k++) { const d = crops[k].data; vals[k] = 0.299 * d[4 * j] + 0.587 * d[4 * j + 1] + 0.114 * d[4 * j + 2]; }
    gray[j] = vals.slice().sort()[crops.length >> 1];
  }
  for (const c of crops) {
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let j = 0; j < n; j++) { const v = lab(c.data[4 * j], c.data[4 * j + 1], c.data[4 * j + 2]); L[j] = v[0]; A[j] = v[1]; B[j] = v[2]; }
    const med = (a: Float32Array) => a.slice().sort()[n >> 1];
    const ma = med(A), mb = med(B);
    const bad = new Uint8Array(n);
    for (let j = 0; j < n; j++) if (Math.hypot(A[j] - ma, B[j] - mb) > 18 || L[j] > 200 || L[j] < 25) bad[j] = 1;
    for (let y = Math.floor(0.88 * h); y < h; y++) bad.fill(1, y * w + Math.floor(w / 2), y * w + w);
    // grow the bad pixels by 3 px (a 7 x 7 kernel)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!bad[y * w + x]) continue;
      for (let dy = -3; dy <= 3; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < h) mask.fill(0, yy * w + Math.max(0, x - 3), yy * w + Math.min(w, x + 4));
      }
    }
  }
  const s = h / (1845 - 1470);
  return { g: { data: gray, w, h }, mask, arrow: { x: ARROW.x * s, y: ARROW.y * s } };
}

/** Local contrast normalization (A.6): (g - mean) / sqrt(variance + 4), both Gaussian with sigma s. Returns a CV_32F Mat. */
function normalize(cv: CV, src: CV, sigma: number, keep: <O extends { delete(): void }>(o: O) => O): CV {
  const out = keep(new cv.Mat());
  using((tmp) => {
    const f = tmp(new cv.Mat()), m = tmp(new cv.Mat()), v = tmp(new cv.Mat());
    src.convertTo(f, cv.CV_32F);
    cv.GaussianBlur(f, m, new cv.Size(0, 0), sigma);
    cv.subtract(f, m, f); // f is now g - mean
    cv.multiply(f, f, m);
    cv.GaussianBlur(m, v, new cv.Size(0, 0), sigma);
    cv.add(v, tmp(new cv.Mat(v.rows, v.cols, cv.CV_32F, new cv.Scalar(4))), v);
    cv.sqrt(v, v);
    cv.divide(f, v, out);
  });
  return out;
}

/** A mosaic of the tiles of a map at zoom z over a window (game units), with its origin and scale. */
export interface Mosaic { g: Gray8; x0: number; y0: number; pxPerUnit: number; tb: MapInfo['tileBounds'] }

const SPAN = 163.84;
export async function mosaic(load: TileLoader, map: MapId, info: MapInfo, z: number, win?: { cx: number; cy: number; r: number }): Promise<Mosaic> {
  const tb = info.tileBounds, px = (2 ** z * info.tileSize) / SPAN;
  const b = win ? { minX: win.cx - win.r, maxX: win.cx + win.r, minY: win.cy - win.r, maxY: win.cy + win.r } : info.bounds;
  const x0 = Math.floor((b.minX - tb.minX) * px), x1 = Math.ceil((b.maxX - tb.minX) * px);
  const y0 = Math.floor((tb.maxY - b.maxY) * px), y1 = Math.ceil((tb.maxY - b.minY) * px);
  const W = x1 - x0, H = y1 - y0, out = new Uint8Array(W * H), T = info.tileSize;
  const jobs: Promise<void>[] = [];
  for (let tx = Math.floor(x0 / T); tx <= Math.floor((x1 - 1) / T); tx++) {
    for (let ty = Math.floor(y0 / T); ty <= Math.floor((y1 - 1) / T); ty++) {
      jobs.push(load(map, z, tx, ty).then((t) => {
        if (!t) return;
        const X = tx * T - x0, Y = ty * T - y0;
        for (let y = Math.max(0, -Y); y < Math.min(T, H - Y); y++) {
          for (let x = Math.max(0, -X); x < Math.min(T, W - X); x++) out[(Y + y) * W + X + x] = t.data[y * t.w + x];
        }
      }));
    }
  }
  await Promise.all(jobs);
  return { g: { data: out, w: W, h: H }, x0, y0, pxPerUnit: px, tb };
}

export interface MinimapMatch { score: number; next: number; x: number; y: number; mpp: number }

/**
 * Matches the template against a mosaic at the scales `mpps` (m per minimap pixel at 2160p): the best score, the next
 * peak outside a small circle around it, and where the arrow is in game units.
 */
export function matchMinimap(cv: CV, t: Template, m: Mosaic, mpps: number[], frameScale = 1): MinimapMatch | null {
  let best: MinimapMatch | null = null;
  using((keep) => {
    const img = keep(cv.matFromArray(m.g.h, m.g.w, cv.CV_8UC1, m.g.data));
    const tpl = keep(cv.matFromArray(t.g.h, t.g.w, cv.CV_8UC1, t.g.data));
    const msk = keep(cv.matFromArray(t.g.h, t.g.w, cv.CV_8UC1, t.mask));
    // template px to mosaic px; the crop scales with the frame height, so its meters per pixel do too
    const scaleOf = (mpp: number) => ((mpp / frameScale) * m.pxPerUnit) / 100;
    // the mosaic normalizes with the same ground distance as the template (6 template px), in a few steps of sigma,
    // one normalized mosaic at a time (each is as large as the mosaic in floats)
    const bucket = (mpp: number) => Math.round(Math.log(Math.max(1, 6 * scaleOf(mpp))) / Math.log(1.25));
    const groups = new Map<number, number[]>();
    for (const mpp of mpps) groups.set(bucket(mpp), [...(groups.get(bucket(mpp)) ?? []), mpp]);
    for (const [b, list] of groups) using((k1) => {
      const N = normalize(cv, img, 1.25 ** b, k1);
      for (const mpp of list) using((k2) => {
        const k = scaleOf(mpp);
        const tw = Math.round(t.g.w * k), th = Math.round(t.g.h * k);
        if (tw < 16 || th < 16 || tw >= m.g.w || th >= m.g.h) return;
        const ts = k2(new cv.Mat()), ms = k2(new cv.Mat());
        cv.resize(tpl, ts, new cv.Size(tw, th), 0, 0, cv.INTER_AREA);
        cv.resize(msk, ms, new cv.Size(tw, th), 0, 0, cv.INTER_NEAREST);
        const tn = normalize(cv, ts, Math.max(1, 6 * k), k2);
        const mf = k2(new cv.Mat());
        ms.convertTo(mf, cv.CV_32F);
        const tm = k2(new cv.Mat());
        cv.multiply(tn, mf, tm);
        const res = k2(new cv.Mat());
        cv.matchTemplate(N, tm, res, cv.TM_CCORR_NORMED);
        const mm = cv.minMaxLoc(res);
        if (best && mm.maxVal <= best.score) return;
        // the peak to a fraction of a mosaic pixel: at zoom 6 a pixel is a meter, as much as a walk of a second
        const px = mm.maxLoc.x, py = mm.maxLoc.y, v = (x: number, y: number) => res.floatAt(Math.max(0, Math.min(res.rows - 1, y)), Math.max(0, Math.min(res.cols - 1, x)));
        const sx = px + peakOffset(v(px - 1, py), mm.maxVal, v(px + 1, py)), sy = py + peakOffset(v(px, py - 1), mm.maxVal, v(px, py + 1));
        // the next peak: the best value outside a circle around the best one
        const r = Math.round(30 * k) + 5;
        cv.circle(res, mm.maxLoc, r, new cv.Scalar(-1), -1);
        const next = cv.minMaxLoc(res).maxVal;
        const ax = m.x0 + sx + t.arrow.x * k, ay = m.y0 + sy + t.arrow.y * k;
        best = { score: mm.maxVal, next, x: m.tb.minX + ax / m.pxPerUnit, y: m.tb.maxY - ay / m.pxPerUnit, mpp };
      });
    });
  });
  return best;
}

/**
 * The walking path from positions over time: a quadratic in time per axis, by least squares, twice, the second time
 * without positions more than 3 robust sigmas off (a minimap match on the wrong spot). A walk over the few seconds of
 * a flight is smooth. Null with fewer than 4 positions.
 */
export function smoothPath(pts: { t: number; x: number; y: number }[]): ((t: number) => { x: number; y: number }) | null {
  const fit = (ps: typeof pts) => {
    if (ps.length < 4) return null;
    const t0 = ps[0].t, cx = quadratic(ps.map((p) => p.t - t0), ps.map((p) => p.x)), cy = quadratic(ps.map((p) => p.t - t0), ps.map((p) => p.y));
    return cx && cy ? (t: number) => ({ x: cx[0] + cx[1] * (t - t0) + cx[2] * (t - t0) ** 2, y: cy[0] + cy[1] * (t - t0) + cy[2] * (t - t0) ** 2 }) : null;
  };
  const first = fit(pts);
  if (!first) return null;
  const off = pts.map((p) => { const q = first(p.t); return Math.hypot(p.x - q.x, p.y - q.y); });
  const lim = 3 * 1.4826 * [...off].sort((a, b) => a - b)[off.length >> 1];
  return fit(pts.filter((_, k) => off[k] <= Math.max(lim, 0.01))) ?? first;
}
