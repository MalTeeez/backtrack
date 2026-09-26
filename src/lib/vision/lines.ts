/**
 * The pitch and roll of the reference camera from the vertical lines of many frames (automation plan section 6,
 * Appendix A.2). OpenCV.js has no LSD. Instead, peaks of the horizontal gradient link into near-vertical chains at half
 * size, and refine() moves each chain onto the subpixel peaks of the gradient at full size. Every line goes
 * into the reference camera with the rotation of its frame, where a vertical world line lies in a plane that holds the
 * world up vector u. A RANSAC over pairs of plane normals finds u. Two halves of the frames give a second opinion.
 */
import { fixedMask } from './hud.ts';
import { half, sample, type Gray8 } from './image.ts';
import { apply, bearing, cross, dot, eigenSym, norm, T, type Intrinsics, type Mat3, type V3 } from './rotation.ts';
import { D2R, R2D } from '../solver/camera.ts';
import { seeded } from '../solver/montecarlo.ts';

/** Counts of the last call of verticalSegments and its candidates at full size, for checks. */
export const segmentStats = { raw: 0, vertical: 0, unmasked: 0, refined: 0, fewRows: 0, rough: 0, short: 0 };
export const lastCandidates: number[][] = [];

/** A refined line segment in frame pixels at full size. */
export interface Segment { x1: number; y1: number; x2: number; y2: number; len: number; rms: number }

/**
 * Finds the candidates of one frame, which are near-vertical (within 20 deg), at least 70 px long, and outside the HUD.
 * On the half-size frame, the peaks of the horizontal gradient (across a near-vertical edge) link from row to row with
 * the same sign, like a line segment detector that only looks for vertical lines. Then refine() moves each chain onto
 * the edge at full size.
 */
export function verticalSegments(g: Gray8, maxTiltDeg = 20, minLen = 70): Segment[] {
  const h = half(g), mask = fixedMask(h.w, h.h), W = h.w, H = h.h, d = h.data;
  // the chains hold the label of each edge pixel and the points of each label
  const label = new Int32Array(W * H).fill(-1);
  const chains: { xs: number[]; ys: number[]; sign: number }[] = [];
  const gxAt = (i: number) => d[i - W + 1] + 2 * d[i + 1] + d[i + W + 1] - d[i - W - 1] - 2 * d[i - 1] - d[i + W - 1];
  const gyAt = (i: number) => d[i + W - 1] + 2 * d[i + W] + d[i + W + 1] - d[i - W - 1] - 2 * d[i - W] - d[i - W + 1];
  const gx = new Int16Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) gx[y * W + x] = gxAt(y * W + x);
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x, v = gx[i], a = Math.abs(v);
      if (a < 24 || !mask.data[i] || a < Math.abs(gx[i - 1]) || a <= Math.abs(gx[i + 1]) || a < 1.5 * Math.abs(gyAt(i))) continue;
      const sign = Math.sign(v);
      // join the chain of an edge pixel of the same sign one or two rows up, within one column
      let lab = -1;
      for (const up of [W, 2 * W]) {
        for (const dx of [0, -1, 1]) {
          const j = i - up + dx, l = label[j];
          if (l >= 0 && chains[l].sign === sign) { lab = l; break; }
        }
        if (lab >= 0) break;
      }
      if (lab < 0) { lab = chains.length; chains.push({ xs: [], ys: [], sign }); }
      label[i] = lab;
      chains[lab].xs.push(x); chains[lab].ys.push(y);
    }
  }
  const out: Segment[] = [];
  const tan = Math.tan(maxTiltDeg * D2R);
  Object.assign(segmentStats, { raw: chains.length, vertical: 0, unmasked: 0, refined: 0, fewRows: 0, rough: 0, short: 0 });
  lastCandidates.length = 0;
  for (const c of chains) {
    const n = c.ys.length, span = c.ys[n - 1] - c.ys[0];
    if (span < minLen / 2) continue;
    const my = c.ys.reduce((s, v) => s + v, 0) / n, mx = c.xs.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, syy = 0;
    for (let k = 0; k < n; k++) { sxy += (c.ys[k] - my) * (c.xs[k] - mx); syy += (c.ys[k] - my) ** 2; }
    const b = sxy / syy;
    if (Math.abs(b) > tan) continue;
    segmentStats.vertical++;
    const at = (y: number) => mx + b * (y - my);
    const [y1, y2] = [c.ys[0], c.ys[n - 1]];
    lastCandidates.push([2 * at(y1) + 0.5, 2 * y1 + 0.5, 2 * at(y2) + 0.5, 2 * y2 + 0.5]);
    segmentStats.unmasked++;
    const s = refine(g, 2 * at(y1) + 0.5, 2 * y1 + 0.5, 2 * at(y2) + 0.5, 2 * y2 + 0.5);
    if (s && s.len >= minLen) { out.push(s); segmentStats.refined++; } else if (s) segmentStats.short++;
  }
  return dedupe(out);
}

/**
 * Moves a candidate onto the edge. Every 2 rows along it, it finds the subpixel peak of the horizontal gradient within
 * 3 px. Then it fits a line x = a + b y through the peaks, without the ones that miss by more than 1 px.
 */
function refine(g: Gray8, x1: number, y1: number, x2: number, y2: number): Segment | null {
  if (y2 < y1) [x1, y1, x2, y2] = [x2, y2, x1, y1];
  const slope = (x2 - x1) / (y2 - y1 || 1);
  const pts: [number, number, number][] = []; // y, x, sign
  const gx = (x: number, y: number) => sample(g, x + 1, y) - sample(g, x - 1, y);
  for (let y = y1; y <= y2; y += 2) {
    const xc = x1 + slope * (y - y1);
    let best = -1, bv = 0;
    const v: number[] = [];
    for (let d = -3; d <= 3; d++) v.push(gx(xc + d, y));
    for (let k = 0; k < v.length; k++) if (Math.abs(v[k]) > bv) { bv = Math.abs(v[k]); best = k; }
    if (best <= 0 || best >= v.length - 1 || !(bv > 6)) continue;
    // a parabola through the peak and its neighbors
    const [l, m, r] = [Math.abs(v[best - 1]), bv, Math.abs(v[best + 1])], den = l - 2 * m + r;
    pts.push([y, xc + best - 3 + (den < 0 ? (0.5 * (l - r)) / den : 0), Math.sign(v[best])]);
  }
  // an edge is dark to bright (or the other way) along its whole length, so it takes the sign of most rows
  const sign = Math.sign(pts.reduce((s, p) => s + p[2], 0)) || 1;
  const n0 = Math.floor((y2 - y1) / 2) + 1;
  let use = pts.filter((p) => p[2] === sign).map(([y, x]): [number, number] => [y, x]), fit = { a: 0, b: 0 };
  for (let it = 0; it < 3; it++) {
    if (use.length < Math.max(8, 0.5 * n0)) { segmentStats.fewRows++; return null; }
    const my = use.reduce((s, p) => s + p[0], 0) / use.length, mx = use.reduce((s, p) => s + p[1], 0) / use.length;
    let sxy = 0, syy = 0;
    for (const [y, x] of use) { sxy += (y - my) * (x - mx); syy += (y - my) ** 2; }
    const b = sxy / syy;
    fit = { a: mx - b * my, b };
    // the first limit is loose, because the first fit still holds the rows that missed the edge
    use = use.filter(([y, x]) => Math.abs(x - (fit.a + fit.b * y)) < [2.5, 1.5, 1][it]);
  }
  if (use.length < Math.max(8, 0.5 * n0)) return null;
  const rms = Math.sqrt(use.reduce((s, [y, x]) => s + (x - (fit.a + fit.b * y)) ** 2, 0) / use.length);
  if (rms > 0.7) { segmentStats.rough++; return null; }
  const ya = use[0][0], yb = use[use.length - 1][0];
  const xa = fit.a + fit.b * ya, xb = fit.a + fit.b * yb;
  return { x1: xa, y1: ya, x2: xb, y2: yb, len: Math.hypot(xb - xa, yb - ya), rms };
}

/** Hough finds an edge more than once. Of the segments that lie on the same line, this keeps the longest. */
function dedupe(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of [...segs].sort((a, b) => b.len - a.len)) {
    const same = out.some((o) => {
      const at = (y: number) => o.x1 + ((o.x2 - o.x1) * (y - o.y1)) / (o.y2 - o.y1);
      const overlap = Math.min(o.y2, s.y2) - Math.max(o.y1, s.y1);
      return overlap > 0 && Math.abs(at(s.y1) - s.x1) < 3 && Math.abs(at(s.y2) - s.x2) < 3;
    });
    if (!same) out.push(s);
  }
  return out;
}

export interface LineFit {
  /** The pitch and roll of the reference camera (deg), and their standard deviations. */
  pitch: number; roll: number; pitchSigma: number; rollSigma: number;
  /** The lines used and found, and the frames they came from. */
  used: number; total: number; frames: number;
  /** The pitch and roll of the two halves of the frames, when both had enough lines. */
  halves?: { pitch: number; roll: number }[];
  /** The world up vector in the reference camera. */
  u: V3;
  /** The lines used, in the reference camera as pairs of bearings, for the overlay. */
  lines: { a: V3; b: V3; frame: number }[];
}

interface Line { n: V3; len: number; a: V3; b: V3; frame: number }

/** The inlier limit of a line against u (deg), A.2. */
const LINE_DEG = 0.15;

/**
 * Finds the world up vector from plane normals. A RANSAC over pairs, scored by the length of the inliers, comes first,
 * then the smallest eigenvector of the length-weighted normals.
 */
function fitUp(lines: Line[], seed = 1): { u: V3; inl: Line[] } | null {
  if (lines.length < 2) return null;
  const rng = seeded(seed), sin = Math.sin(LINE_DEG * D2R);
  const up = (u: V3): V3 => (u[1] > 0 ? [-u[0], -u[1], -u[2]] : u);
  let best: { u: V3; score: number } | null = null;
  for (let k = 0; k < 2000; k++) {
    const i = Math.floor(rng() * lines.length), j = Math.floor(rng() * lines.length);
    if (i === j) continue;
    const c = cross(lines[i].n, lines[j].n);
    if (Math.hypot(...c) < 1e-6) continue;
    const u = up(norm(c));
    // a vertical world line leans toward image up, so u must point up in the image
    if (Math.abs(u[1]) < 0.3) continue;
    const score = lines.reduce((s, l) => s + (Math.abs(dot(l.n, u)) < sin ? l.len : 0), 0);
    if (!best || score > best.score) best = { u, score };
  }
  if (!best) return null;
  let u = best.u, inl: Line[] = [];
  for (let it = 0; it < 2; it++) {
    inl = lines.filter((l) => Math.abs(dot(l.n, u)) < sin);
    if (inl.length < 2) return null;
    const M = new Array(9).fill(0);
    for (const l of inl) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r * 3 + c] += l.len * l.n[r] * l.n[c];
    const { values, vectors } = eigenSym(M, 3);
    const k = values.indexOf(Math.min(...values));
    u = up(norm([vectors[k], vectors[3 + k], vectors[6 + k]]));
  }
  return { u, inl };
}

const anglesOfUp = (u: V3) => ({ pitch: Math.asin(Math.max(-1, Math.min(1, u[2]))) * R2D, roll: Math.atan2(u[0], -u[1]) * R2D });

/**
 * The pitch and roll of the reference camera from the segments of several frames, each with the rotation of its frame
 * (b_frame = R b_ref).
 */
export function fitPitchRoll(K: Intrinsics, frames: { segs: Segment[]; R: Mat3 }[]): LineFit | null {
  const lines: Line[] = [];
  frames.forEach(({ segs, R }, frame) => {
    const Rt: Mat3 = T(R);
    for (const s of segs) {
      const a = apply(Rt, bearing(K, s.x1, s.y1)), b = apply(Rt, bearing(K, s.x2, s.y2));
      lines.push({ n: norm(cross(a, b)), len: s.len, a, b, frame });
    }
  });
  // the game camera does not roll. Thus the level fit comes first, and the fit with a roll only wins when it explains
  // clearly more of the lines. Otherwise, a slanted structure like a crane arm pulls a roll into the fit.
  const fit = (ls: Line[], seed = 1) => {
    const level = fitLevel(ls), free = fitUp(ls, seed);
    const score = (f: { inl: Line[] } | null) => (f ? f.inl.reduce((s, l) => s + l.len, 0) : 0);
    return free && score(free) > ROLL_GAIN * score(level) ? free : level;
  };
  const all = fit(lines);
  if (!all) return null;
  const { pitch, roll } = anglesOfUp(all.u);
  // the error from the misses of the lines, through the pitch sensitivity of each line. A line of one building shows
  // in every frame, so the lines are not independent, and the error counts them once per frame.
  const nf = new Set(all.inl.map((l) => l.frame)).size;
  const miss = all.inl.map((l) => dot(l.n, all.u));
  const rms = Math.sqrt(miss.reduce((s, x) => s + x * x, 0) / miss.length);
  const P = pitch * D2R, sens = all.inl.reduce((s, l) => s + (l.n[1] * Math.sin(P) + l.n[2] * Math.cos(P)) ** 2, 0);
  let pitchSigma = (rms / Math.sqrt(Math.max(sens, 1e-12) / Math.max(1, nf))) * R2D;
  let rollSigma = (rms / Math.sqrt(all.inl.length / Math.max(1, nf))) * R2D;
  // split the frames into two halves in time. A large difference between them is a sign of a bad fit (section 6).
  const used = [...new Set(lines.map((l) => l.frame))].sort((a, b) => a - b);
  let halves: LineFit['halves'];
  if (used.length >= 2) {
    const mid = used[Math.floor(used.length / 2)];
    const parts = [lines.filter((l) => l.frame < mid), lines.filter((l) => l.frame >= mid)].map((ls) => fit(ls, 2));
    if (parts.every((p) => p && p.inl.length >= 5)) {
      halves = parts.map((p) => anglesOfUp(p!.u));
      pitchSigma = Math.max(pitchSigma, Math.abs(halves[0].pitch - halves[1].pitch) / 2);
      rollSigma = Math.max(rollSigma, Math.abs(halves[0].roll - halves[1].roll) / 2);
    }
  }
  return {
    pitch, roll, pitchSigma, rollSigma, used: all.inl.length, total: lines.length, frames: used.length, halves, u: all.u,
    lines: all.inl.map((l) => ({ a: l.a, b: l.b, frame: l.frame })),
  };
}

/** How much more line length a fit with a roll must explain than the level fit to win. */
const ROLL_GAIN = 1.3;

/**
 * Fits the level camera (no roll). Each line gives a pitch of its own, tan p = n_y / n_z. The fit takes the pitch that
 * most line length agrees with (within LINE_DEG), then runs weighted least squares on those lines.
 */
function fitLevel(lines: Line[]): { u: V3; inl: Line[] } | null {
  if (lines.length < 2) return null;
  const sin = Math.sin(LINE_DEG * D2R);
  const f = (l: Line, p: number) => -l.n[1] * Math.cos(p) + l.n[2] * Math.sin(p);
  let best = { p: 0, score: -1 };
  for (let deg = -30; deg <= 80; deg += 0.02) {
    const p = deg * D2R;
    let score = 0;
    for (const l of lines) if (Math.abs(f(l, p)) < sin) score += l.len;
    if (score > best.score) best = { p, score };
  }
  let p = best.p, inl: Line[] = [];
  for (let it = 0; it < 3; it++) {
    inl = lines.filter((l) => Math.abs(f(l, p)) < sin);
    if (inl.length < 2) return null;
    // one Newton step on the length-weighted squares
    let g = 0, h = 0;
    for (const l of inl) { const d = l.n[1] * Math.sin(p) + l.n[2] * Math.cos(p); g += l.len * f(l, p) * d; h += l.len * d * d; }
    if (h > 0) p -= g / h;
  }
  return { u: [0, -Math.cos(p), Math.sin(p)], inl };
}
