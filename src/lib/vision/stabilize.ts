/**
 * The stabilization (automation plan section 5, Appendix A.1) finds the rotation of each frame of a section against a
 * reference frame, with a rotation-only camera model. OpenCV.js has no SIFT, so ORB finds the matches at half size
 * (section 5.1 allows it), and pyramidal Lucas-Kanade moves the matched points of the world to subpixel positions
 * before the final fit.
 *
 * Several motions share a frame: the world, the viewmodel (hands, weapon) and the HUD (which stands still). A RANSAC
 * over rotations finds up to three models. The world is the one highest in the frame among those with a fair share of
 * the matches (the hands sit low). HUD points (still in frames where the world turns) drop out of the features for a
 * second pass. A frame with few matches to the reference also chains through its neighbor.
 *
 * The work per frame (the features, and the rotation against another frame) is deterministic and without I/O. A Runner
 * does it in this thread or spreads it over a pool of workers (pool.ts).
 */
import { using, type CV } from './cv.ts';
import { fixedMask } from './hud.ts';
import { half, median, type Gray8 } from './image.ts';
import { angleBetween, apply, bearing, dot, fitRotation, I3, mul, rotationAngle, type Intrinsics, type Mat3, type V3 } from './rotation.ts';
import { D2R } from '../solver/camera.ts';
import { seeded, type Rng } from '../solver/montecarlo.ts';
import { timed, timedAsync } from './profile.ts';

export interface StabFrame {
  t: number;
  /** b_frame = R b_ref. Null when the frame has no world model. */
  R: Mat3 | null;
  /** The inliers of the world model after the refinement, and their RMS miss (px at full size). */
  inliers: number;
  fitPx: number;
  /** The inliers of every model found, with the world first. */
  models: number[];
  /** The frame came through a neighbor, not directly from the reference. */
  chained: boolean;
  /**
   * The frame is good enough to use, with at least 50 inliers and the rotation known to 0.1 px (its fit error over the
   * root of the inliers).
   */
  ok: boolean;
  /** The matched points of the world and of the other models, in frame pixels at full size, for the overlays. */
  world?: Float32Array;
  other?: Float32Array;
}

export interface Stabilization {
  /** The index of the reference frame. */
  ref: number;
  K: Intrinsics;
  frames: StabFrame[];
}

export const MIN_INLIERS = 50;
/**
 * The largest standard error of a rotation (px), which is the fit error over the root of the inliers. The plan proposes
 * a fit error of 1 px (section 2.2). On the 4K test clips, compression gives good frames of 300 inliers a fit of 1.1 to
 * 1.3 px, whose rotation is still known to 0.07 px.
 */
export const MAX_ROTATION_PX = 0.1;
const good = (inliers: number, fitPx: number) => inliers >= MIN_INLIERS && fitPx / Math.sqrt(inliers) <= MAX_ROTATION_PX;
/** A model that turns less than this (deg) stands still, like the HUD or a camera at rest. */
const STILL_DEG = 0.01;
const NFEATURES = 4000;

/** ORB keypoints (half size) and their 32-byte descriptors. Plain arrays, so they travel to other workers. */
export interface Feats { pts: Float32Array; desc: Uint8Array; n: number }

/** ORB keypoints and descriptors of a half-size frame, outside the fixed HUD mask. */
export function features(cv: CV, g: Gray8): Feats {
  const mask = fixedMask(g.w, g.h);
  return using((keep) => {
    const img = keep(cv.matFromArray(g.h, g.w, cv.CV_8UC1, g.data));
    const m = keep(cv.matFromArray(mask.h, mask.w, cv.CV_8UC1, mask.data));
    const kps = keep(new cv.KeyPointVector()), desc = keep(new cv.Mat()), det = keep(new cv.ORB(NFEATURES));
    det.detectAndCompute(img, m, kps, desc);
    const n = kps.size(), pts = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { const p = kps.get(i).pt; pts[2 * i] = p.x; pts[2 * i + 1] = p.y; }
    return { pts, desc: new Uint8Array(desc.data), n };
  });
}

/** The features without those within `r` px of the HUD points (all at half size). */
function withoutHud(f: Feats, hud: number[][], r = 12): Feats {
  const keep: number[] = [];
  for (let i = 0; i < f.n; i++) if (!hud.some(([x, y]) => Math.abs(f.pts[2 * i] - x) <= r && Math.abs(f.pts[2 * i + 1] - y) <= r)) keep.push(i);
  const pts = new Float32Array(keep.length * 2), desc = new Uint8Array(keep.length * 32);
  keep.forEach((i, k) => { pts[2 * k] = f.pts[2 * i]; pts[2 * k + 1] = f.pts[2 * i + 1]; desc.set(f.desc.subarray(32 * i, 32 * i + 32), 32 * k); });
  return { pts, desc, n: keep.length };
}

/** Matches a to b, and returns the pairs of indices that pass the ratio test. */
function match(cv: CV, a: Feats, b: Feats, ratio = 0.8): [number, number][] {
  if (!a.n || !b.n) return [];
  return using((keep) => {
    const da = keep(cv.matFromArray(a.n, 32, cv.CV_8UC1, a.desc)), db = keep(cv.matFromArray(b.n, 32, cv.CV_8UC1, b.desc));
    const bf = keep(new cv.BFMatcher(cv.NORM_HAMMING, false));
    const res = keep(new cv.DMatchVectorVector());
    bf.knnMatch(da, db, res, 2);
    const out: [number, number][] = [];
    for (let i = 0; i < res.size(); i++) {
      const m = res.get(i);
      if (m.size() >= 2 && m.get(0).distance < ratio * m.get(1).distance) out.push([m.get(0).queryIdx, m.get(0).trainIdx]);
      else if (m.size() === 1) out.push([m.get(0).queryIdx, m.get(0).trainIdx]);
    }
    return out;
  });
}

interface Model { R: Mat3; inl: number[] }

/** Up to `count` rotation models b = R a, each by RANSAC on what the models before it left. */
export function ransacModels(a: V3[], b: V3[], thrDeg: number, rng: Rng, count = 3, iters = 400): Model[] {
  const cos = Math.cos(thrDeg * D2R), left = new Set(a.map((_, i) => i)), out: Model[] = [];
  const inliers = (R: Mat3, from: number[]) => from.filter((i) => dot(apply(R, a[i]), b[i]) > cos);
  for (let m = 0; m < count && left.size >= 8; m++) {
    const idx = [...left];
    let best: number[] = [];
    for (let k = 0; k < iters; k++) {
      const i = idx[Math.floor(rng() * idx.length)], j = idx[Math.floor(rng() * idx.length)];
      if (i === j || angleBetween(a[i], a[j]) < 0.5) continue;
      const R = fitRotation([a[i], a[j]], [b[i], b[j]]);
      const inl = inliers(R, idx);
      if (inl.length > best.length) best = inl;
    }
    if (best.length < 8) break;
    // refit on the inliers, twice, as the inliers of the refit may grow
    let R = fitRotation(best.map((i) => a[i]), best.map((i) => b[i]));
    best = inliers(R, idx);
    R = fitRotation(best.map((i) => a[i]), best.map((i) => b[i]));
    best = inliers(R, idx);
    out.push({ R, inl: best });
    for (const i of best) left.delete(i);
  }
  return out;
}

/**
 * Picks the world among the models. Of the models with a fair share of the matches, the world is the one highest in
 * the frame (the prototype rule). The hands and the weapon sit low, and a model of a few HUD points does not count.
 */
function pickWorld(models: Model[], ys: (i: number) => number): Model | null {
  const most = Math.max(0, ...models.map((m) => m.inl.length));
  const cand = models.filter((m) => m.inl.length >= Math.max(20, 0.3 * most)).map((m) => ({ m, y: median(m.inl.map(ys)) }));
  return cand.sort((p, q) => p.y - q.y)[0]?.m ?? null;
}

/** The rotation of one frame against another, and what the other models show (for the HUD and the overlays). */
export interface Relative {
  R: Mat3; inliers: number; fitPx: number; models: number[];
  /** The indices of the features of frame j that stand still in another model. */
  still: number[];
  world: Float32Array; other: Float32Array;
}

/**
 * The rotation of frame i against frame j (b_i = R b_j). It finds the ORB matches and the world model by RANSAC, then
 * refits on the world points that Lucas-Kanade moved to subpixel positions. `f` is the focal length at full size, for
 * the fit in pixels.
 */
export function relative(cv: CV, fj: Feats, fi: Feats, gj: Gray8, gi: Gray8, Kh: Intrinsics, f: number, seed: number): Relative | null {
  const rng = seeded(seed);
  const pairs = timed('stab: match', () => match(cv, fj, fi));
  const bj = (k: number) => bearing(Kh, fj.pts[2 * k], fj.pts[2 * k + 1]), bi = (k: number) => bearing(Kh, fi.pts[2 * k], fi.pts[2 * k + 1]);
  const a = pairs.map(([pj]) => bj(pj)), b = pairs.map(([, pi]) => bi(pi));
  const models = timed('stab: RANSAC', () => ransacModels(a, b, 0.1, rng));
  const world = pickWorld(models, (k) => fi.pts[2 * pairs[k][1] + 1]);
  if (!world) return null;
  const refined = timed('stab: LK refine', () => refine(cv, gj, gi, Kh, world.inl.map((k) => [fj.pts[2 * pairs[k][0]], fj.pts[2 * pairs[k][0] + 1]]), world.R, rng));
  const still = models.filter((m) => m !== world && rotationAngle(m.R) < STILL_DEG).flatMap((m) => m.inl.map((k) => pairs[k][0]));
  const ptsOf = (ks: number[]) => Float32Array.from(ks.flatMap((k) => [fi.pts[2 * pairs[k][1]] * 2 + 0.5, fi.pts[2 * pairs[k][1] + 1] * 2 + 0.5]));
  const others = models.filter((m) => m !== world);
  return {
    R: refined?.R ?? world.R, inliers: refined?.n ?? world.inl.length, fitPx: (refined?.rmsDeg ?? 0.1) * D2R * f,
    models: [world, ...others].map((m) => m.inl.length), still, world: ptsOf(world.inl), other: ptsOf(others.flatMap((m) => m.inl)),
  };
}

/** Does the work per frame, here (localRunner) or in a pool of workers (pool.ts). */
export interface StabRunner {
  /** The features of each half-size frame. */
  features(halves: Gray8[]): Promise<Feats[]>;
  /** The rotation of frame i against frame j for each job. */
  relative(jobs: { i: number; j: number }[], feats: Feats[], halves: Gray8[], Kh: Intrinsics, f: number): Promise<(Relative | null)[]>;
}

export const localRunner = (cv: CV): StabRunner => ({
  features: async (halves) => halves.map((g) => features(cv, g)),
  relative: async (jobs, feats, halves, Kh, f) => jobs.map(({ i, j }) => relative(cv, feats[j], feats[i], halves[j], halves[i], Kh, f, seedOf(i, j))),
});
/** A seed per pair of frames, so the result does not depend on which worker runs it. */
export const seedOf = (i: number, j: number) => 1 + i * 7919 + j * 104729;

export interface StabOptions {
  /** The frames (first and last index) of the section, which the reference may come from. Frames around it chain in. */
  section?: [number, number];
}

/** Below this many direct inliers, a frame also tries the chain through its neighbor, and takes the better one. */
const CHAIN_BELOW = 150;

/**
 * Finds the rotation of every frame against the reference, which is the frame of the section with the most features.
 * The first pass finds the HUD, the points that stand still in frames where the world turns. The second pass leaves
 * them out.
 */
export async function stabilize(run: StabRunner, frames: { t: number; gray: Gray8 }[], K: Intrinsics, o: StabOptions = {}): Promise<Stabilization> {
  const halves = timed('stab: half size', () => frames.map((f) => half(f.gray)));
  const Kh: Intrinsics = { f: K.f / 2, cx: (K.cx + 0.5) / 2 - 0.5, cy: (K.cy + 0.5) / 2 - 0.5 };
  let feats = await timedAsync('stab: ORB', () => run.features(halves));
  const [s0, s1] = o.section ?? [0, frames.length - 1];
  let ref = s0;
  for (let i = s0; i <= s1; i++) if (feats[i].n > feats[ref].n) ref = i;
  const first = await pass(run, frames, halves, feats, ref, K, Kh);
  if (!first.hud.length) return first.result;
  feats = feats.map((f) => withoutHud(f, first.hud));
  return (await pass(run, frames, halves, feats, ref, K, Kh)).result;
}

/** One pass matches every frame against the reference (in parallel), then runs the chains where that match is weak. */
async function pass(run: StabRunner, frames: { t: number }[], halves: Gray8[], feats: Feats[], ref: number, K: Intrinsics, Kh: Intrinsics) {
  const out: StabFrame[] = frames.map((f) => ({ t: f.t, R: null, inliers: 0, fitPx: Infinity, models: [], chained: false, ok: false }));
  out[ref] = { ...out[ref], R: I3, inliers: feats[ref].n, fitPx: 0, models: [feats[ref].n], ok: true };
  const others = frames.map((_, i) => i).filter((i) => i !== ref);
  const direct = await timedAsync('stab: against the reference', () => run.relative(others.map((i) => ({ i, j: ref })), feats, halves, Kh, K.f));
  const byFrame = new Map(others.map((i, k) => [i, direct[k]]));
  const stillCount = new Map<number, number>();
  let turning = 0;
  const set = (i: number, r: Relative, chained: boolean) => {
    out[i] = { t: out[i].t, R: r.R, inliers: r.inliers, fitPx: r.fitPx, models: r.models, chained, ok: good(r.inliers, r.fitPx), world: r.world, other: r.other };
  };
  for (const i of others) {
    const r = byFrame.get(i);
    if (!r) continue;
    set(i, r, false);
    if (rotationAngle(r.R) > 0.1) { turning++; for (const k of r.still) stillCount.set(k, (stillCount.get(k) ?? 0) + 1); }
  }
  // a weak frame chains through its neighbor toward the reference. All such pairs run at once, then the results apply
  // outward from the reference, so each neighbor has its rotation. A neighbor that is not good sends the frame to the
  // next good one.
  const order = [...Array.from({ length: frames.length - ref - 1 }, (_, k) => ref + 1 + k), ...Array.from({ length: ref }, (_, k) => ref - 1 - k)];
  const toward = (i: number) => (i > ref ? i - 1 : i + 1);
  const weak = order.filter((i) => !((byFrame.get(i)?.inliers ?? 0) >= CHAIN_BELOW) && toward(i) !== ref);
  const adj = await timedAsync('stab: chains', () => run.relative(weak.map((i) => ({ i, j: toward(i) })), feats, halves, Kh, K.f));
  const chain = new Map(weak.map((i, k) => [i, adj[k]]));
  for (const i of weak) {
    const r = byFrame.get(i);
    let n = toward(i), c = chain.get(i) ?? null;
    if (!out[n].ok) {
      while (n !== ref && !out[n].ok) n = toward(n);
      if (n === ref) continue;
      [c] = await timedAsync('stab: chains', () => run.relative([{ i, j: n }], feats, halves, Kh, K.f));
    }
    if (c && c.inliers > (r?.inliers ?? 0)) set(i, { ...c, R: mul(c.R, out[n].R!) }, true);
  }
  const hud = [...stillCount].filter(([, c]) => c >= Math.max(2, turning / 3)).map(([k]) => [feats[ref].pts[2 * k], feats[ref].pts[2 * k + 1]]);
  return { result: { ref, K, frames: out } as Stabilization, hud };
}

/**
 * Moves the world points of frame j into frame i with Lucas-Kanade, from where the rotation R puts them, and fits the
 * rotation again on the tracked points with a tight threshold (0.06 deg at half size, about 1.7 px at full size).
 */
function refine(cv: CV, gj: Gray8, gi: Gray8, K: Intrinsics, pts: number[][], R: Mat3, rng: Rng): { R: Mat3; n: number; rmsDeg: number } | null {
  if (pts.length < 8) return null;
  return using((keep) => {
    const prev = keep(cv.matFromArray(gj.h, gj.w, cv.CV_8UC1, gj.data));
    const next = keep(cv.matFromArray(gi.h, gi.w, cv.CV_8UC1, gi.data));
    const guess = pts.map(([x, y]) => {
      const b = apply(R, bearing(K, x, y));
      return [K.cx + (K.f * b[0]) / b[2], K.cy + (K.f * b[1]) / b[2]];
    });
    const p0 = keep(cv.matFromArray(pts.length, 1, cv.CV_32FC2, pts.flat()));
    const p1 = keep(cv.matFromArray(pts.length, 1, cv.CV_32FC2, guess.flat()));
    const status = keep(new cv.Mat()), err = keep(new cv.Mat());
    const crit = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 20, 0.01);
    cv.calcOpticalFlowPyrLK(prev, next, p0, p1, status, err, new cv.Size(15, 15), 1, crit, cv.OPTFLOW_USE_INITIAL_FLOW);
    const a: V3[] = [], b: V3[] = [];
    for (let k = 0; k < pts.length; k++) {
      if (!status.data[k]) continue;
      a.push(bearing(K, pts[k][0], pts[k][1]));
      b.push(bearing(K, p1.data32F[2 * k], p1.data32F[2 * k + 1]));
    }
    const [m] = ransacModels(a, b, 0.03 * 2, rng, 1, 200);
    if (!m) return null;
    const miss = m.inl.map((k) => angleBetween(apply(m.R, a[k]), b[k]));
    return { R: m.R, n: m.inl.length, rmsDeg: Math.sqrt(miss.reduce((s, x) => s + x * x, 0) / miss.length) };
  });
}

