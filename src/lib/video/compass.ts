/**
 * Reads the compass heading of WARDOGS from a video frame: the box at the top middle of the screen with the heading as
 * three digits ("196 S"). The digits are white with a dark outline and sit on anything from bright sky to dark ground,
 * so the reader looks at edges, not brightness: each digit becomes a small grid of edge strengths that it compares
 * with a template per digit. The font is proportional (a 1 is narrower) and the number starts at a fixed left edge,
 * so the reader walks from that edge, with each digit as wide as its own advance, and keeps the best few readings of
 * the digits so far (a beam search). It tries small shifts, because the box moves by a pixel or two with the UI.
 * The templates and advances come from tools/make-compass-templates.ts. Deterministic, without DOM access.
 */
import { ADVANCE, LABEL_TEMPLATES, TEMPLATES } from './compassTemplates.ts';

/** A grayscale image: one byte per pixel, row by row. */
export interface Gray { data: ArrayLike<number>; w: number; h: number }

// the layout in the pixels of a 3840 x 2160 frame, relative to the region: the region is 180 x 70 px, its left edge
// 90 px left of the middle and its top 35 px down; the number starts at x 44 and fills y 22 to 50 of it
const REGION = { dx: -90, y: 35, w: 180, h: 70 };
export const DIGITS = { x: 44, y: 22, h: 28 };
// the direction letters (N, NE, ... NW) after the number end at the same place, whatever their width
export const LETTERS = { x: 94, w: 48 };

/** The direction labels of the compass, one per 45 deg sector centered on its direction. */
export const LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export const labelOf = (heading: number) => Math.round(((heading % 360) + 360) % 360 / 45) % 8;
/** Whether a heading fits a label, with a degree of slack at the edges of its sector (the number is rounded). */
const fitsLabel = (heading: number, label: number) => [heading - 1, heading, heading + 1].some((h) => labelOf(h) === label);
export const GRID = { cols: 10, rows: 16 };
export const SHIFT = 4;
const BEAM = 3;
/** How many readings of all three digits the beam keeps for the check against the letters. */
const FINAL = 6;

/** The part of a frame that holds the compass box, in frame pixels. The UI scales with the frame height. */
export function compassRegion(frameW: number, frameH: number) {
  const s = frameH / 2160;
  return { x: Math.round(frameW / 2 + REGION.dx * s), y: Math.round(REGION.y * s), w: Math.round(REGION.w * s), h: Math.round(REGION.h * s), s };
}

/** Edge strength at each pixel: the sum of the brightness steps to the right and down neighbors. */
export function edges(g: Gray): Float32Array {
  const e = new Float32Array(g.w * g.h);
  for (let y = 0; y < g.h - 1; y++) for (let x = 0; x < g.w - 1; x++) {
    const i = y * g.w + x, v = g.data[i];
    e[i] = Math.abs(g.data[i + 1] - v) + Math.abs(g.data[i + g.w] - v);
  }
  return e;
}

/**
 * The dark ring of the digits: how much darker each pixel is than the brightest pixel near it (within 2 px at 2160p).
 * The outline of a digit is always darker than its white fill next to it, on bright sky and on dark ground alike,
 * while the flat parts of the background and of the fill give almost nothing.
 */
export function ring(g: Gray, s: number): Float32Array {
  const r = Math.max(1, Math.round(2 * s)), w = g.w, h = g.h;
  const rowMax = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, g.data[y * w + k]);
    rowMax[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, rowMax[k * w + x]);
    out[y * w + x] = m - g.data[y * w + x];
  }
  return out;
}

/**
 * The white fill of the digits: how much brighter each pixel is than the darkest pixel near it (within 2 px at
 * 2160p). It shows the gaps inside the digits that tell a 6, an 8, a 9 and a 0 apart.
 */
export function fill(g: Gray, s: number): Float32Array {
  const inv = { data: Array.from(g.data, (v) => 255 - v), w: g.w, h: g.h };
  return ring(inv, s);
}

/** The channels the reader compares: the edges, the dark ring and the white fill (see there). */
export const channels = (g: Gray, s: number) => [edges(g), ring(g, s), fill(g, s)];

/**
 * The features of a digit cell: from x (in 2160p pixels from the left of the region) and `width` wide, the mean of
 * each channel over a grid of GRID cells, each channel scaled to zero mean and unit length (so only the shape counts,
 * not the contrast), side by side and scaled to unit length together.
 */
export function cellFeatures(chans: Float32Array[], g: Gray, s: number, x: number, dy: number, width: number): Float32Array {
  const n = GRID.cols * GRID.rows, out = new Float32Array(n * chans.length);
  chans.forEach((c, i) => out.set(channelFeatures(c, g, s, x, dy, width), i * n));
  const norm = Math.sqrt(chans.length);
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function channelFeatures(e: Float32Array, g: Gray, s: number, x: number, dy: number, width: number): Float32Array {
  const x0 = x * s, cw = width * s, y0 = (DIGITS.y + dy) * s, h = DIGITS.h * s;
  const f = new Float32Array(GRID.cols * GRID.rows);
  for (let r = 0; r < GRID.rows; r++) for (let c = 0; c < GRID.cols; c++) {
    const xa = Math.floor(x0 + (c * cw) / GRID.cols), xb = Math.max(xa + 1, Math.floor(x0 + ((c + 1) * cw) / GRID.cols));
    const ya = Math.floor(y0 + (r * h) / GRID.rows), yb = Math.max(ya + 1, Math.floor(y0 + ((r + 1) * h) / GRID.rows));
    let sum = 0, n = 0;
    for (let y = Math.max(0, ya); y < Math.min(g.h, yb); y++) for (let xx = Math.max(0, xa); xx < Math.min(g.w, xb); xx++) { sum += e[y * g.w + xx]; n++; }
    f[r * GRID.cols + c] = n ? sum / n : 0;
  }
  let mean = 0;
  for (const v of f) mean += v;
  mean /= f.length;
  let norm = 0;
  for (let i = 0; i < f.length; i++) { f[i] -= mean; norm += f[i] * f[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= norm;
  return f;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** How far (2160p px) a digit may sit off its place: the spacing between two digits varies a little. */
export const NUDGE = 2;

/**
 * How well digit d fits near x: the best correlation of a cell as wide as the digit with its template, within NUDGE
 * of x, and where that is.
 */
function fit(e: Float32Array[], g: Gray, s: number, x: number, dy: number, d: number, memo: Map<string, number>) {
  let best = { corr: -2, x };
  for (let n = -NUDGE; n <= NUDGE; n++) {
    // the shifts and the beam ask for the same cell many times, so each read keeps what it computed
    const key = `${x + n}|${dy}|${d}`;
    let corr = memo.get(key);
    if (corr == null) memo.set(key, (corr = dot(cellFeatures(e, g, s, x + n, dy, ADVANCE[d]), TEMPLATES[d])));
    if (corr > best.corr) best = { corr, x: x + n };
  }
  return best;
}

export interface CompassReading { heading: number; corr: number; margin: number }

/** The lowest mean correlation and lead over the next reading for a reading to count. Below them, it is null. */
export const MIN_CORR = 0.6, MIN_MARGIN = 0.02;

/** The three digits that fit best from the left edge at a shift, and the next best readings, by mean correlation. */
function beam(e: Float32Array[], g: Gray, s: number, dx: number, dy: number, memo: Map<string, number>) {
  let paths = [{ digits: [] as number[], x: DIGITS.x + dx, sum: 0 }];
  for (let k = 0; k < 3; k++) {
    const next: typeof paths = [];
    for (const p of paths) for (let d = 0; d < 10; d++) {
      const f = fit(e, g, s, p.x, dy, d, memo);
      next.push({ digits: [...p.digits, d], x: f.x + ADVANCE[d], sum: p.sum + f.corr });
    }
    paths = next.sort((a, b) => b.sum - a.sum).slice(0, k === 2 ? FINAL : BEAM);
  }
  return paths;
}

/**
 * Reads the heading from the region image (see compassRegion) of a frame, with `s` its scale against 2160 px. Null
 * when the digits are not clear enough (motion blur, the box hidden) or do not make a heading.
 */
export function readCompass(g: Gray, s: number, limits = { corr: MIN_CORR, margin: MIN_MARGIN }): CompassReading | null {
  return readChannels(channels(g, s), g, s, limits);
}

/** The direction label the letters show, or null when they are not clear. */
export function readLabel(e: Float32Array[], g: Gray, s: number): number | null {
  if (!LABEL_TEMPLATES.length) return null;
  const scores = LABELS.map(() => -2);
  for (let dy = -SHIFT; dy <= SHIFT; dy++) for (let dx = -SHIFT; dx <= SHIFT; dx++) {
    const f = cellFeatures(e, g, s, LETTERS.x + dx, dy, LETTERS.w);
    LABEL_TEMPLATES.forEach((t, k) => { scores[k] = Math.max(scores[k], dot(f, t)); });
  }
  const order = scores.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0]);
  return order[0][0] >= LABEL_MIN_CORR && order[0][0] - order[1][0] >= LABEL_MIN_MARGIN ? order[0][1] : null;
}
/** How clear the letters must be to check the number against them. */
export const LABEL_MIN_CORR = 0.5, LABEL_MIN_MARGIN = 0.05;

/**
 * The best reading of the three digits that fits the direction letters (when they are clear), with its lead over the
 * next such reading. The letters rule out a reading one digit off, like 127 for 327: those lie in another sector.
 */
function readChannels(e: Float32Array[], g: Gray, s: number, limits: { corr: number; margin: number }): CompassReading | null {
  if (!TEMPLATES.length) return null;
  const memo = new Map<string, number>(), label = readLabel(e, g, s);
  // the best mean correlation of each heading over all shifts
  const byHeading = new Map<number, number>();
  for (let dy = -SHIFT; dy <= SHIFT; dy++) for (let dx = -SHIFT; dx <= SHIFT; dx++) {
    for (const p of beam(e, g, s, dx, dy, memo)) {
      const heading = p.digits[0] * 100 + p.digits[1] * 10 + p.digits[2], corr = p.sum / 3;
      if (heading >= 360 || (label != null && !fitsLabel(heading, label))) continue;
      if (corr > (byHeading.get(heading) ?? -2)) byHeading.set(heading, corr);
    }
  }
  const [best, next] = [...byHeading.entries()].sort((a, b) => b[1] - a[1]);
  if (!best) return null;
  const reading = { heading: best[0], corr: best[1], margin: best[1] - (next ? next[1] : -1) };
  return reading.corr >= limits.corr && reading.margin >= limits.margin ? reading : null;
}
