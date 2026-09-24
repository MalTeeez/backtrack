/**
 * Shell detection (automation plan section 8, Appendix A.3). The frames of the section, warped into the reference
 * camera, give a median background. The shell is a small dark blob in background minus frame; large moving areas
 * (the hands) and the edges of near objects (which move by parallax) count against a candidate. The candidates link
 * frame by frame with a local motion check, not a global path: frame timing errors and a fast shell near the camera
 * would break a global one. The shell leads its smoke trail, and its mark is the dark core of the blob.
 */
import { using, type CV } from './cv.ts';
import { fixedMask } from './hud.ts';
import { sample, type Gray8 } from './image.ts';
import type { Pool } from './pool.ts';
import { gpuCandidates, gpuDevice } from './gpu.ts';
import { profile, timed } from './profile.ts';
import { mul, refToFrame, toRef, type Intrinsics, type Mat3 } from './rotation.ts';
export { refToFrame, toRef };

/** A candidate: frame index, position in the reference camera (px), score. */
export interface Candidate { i: number; x: number; y: number; score: number }

export interface Track {
  /** Per frame of the section (null where the track has no mark): the mark in the reference camera and in the frame. */
  marks: ({ ref: { x: number; y: number }; frame: { x: number; y: number }; score: number; jump: boolean } | null)[];
  candidates: number;
}

/** The candidates of the last run, for checks. */
export const lastCandidates: { list: Candidate[] } = { list: [] };

/**
 * The subpixel offset of a peak from its two neighbors (a parabola), within half a pixel. Whole pixels would turn the
 * direction of a step of 3 px by up to 20 deg, and the linking checks directions.
 */
export const peakOffset = (l: number, m: number, r: number) => {
  const den = l - 2 * m + r;
  return den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
};

/** A step shorter than this (px) has no direction: the marks are only good to about a pixel. */
const SMALL_STEP_PX = 4;
/** How near (px) to a point of the viewmodel a candidate may not be. */
const VIEWMODEL_PX = 12;

export const SHELL = { minScore: 6, perFrame: 40, border: 8, window: 15, firstStep: 400, turnDeg: 30, stepMin: 0.3, stepMax: 4 };

/**
 * The rows a band needs around it: the largest reach of the filters of A.3 (the blur of sigma 25 of the large moving
 * areas: 3 sigma), in whole blocks of 8 rows, so the 1/8 size of that blur lines up with the whole frame.
 */
const MARGIN = 96;

/** One band of rows of the reference camera, with the rows of each frame it needs (HUD pixels already 0). */
export interface BandJob {
  y0: number; y1: number; W: number; H: number; K: Intrinsics;
  frames: ({ rows: Uint8Array; sy0: number; sh: number; R: Mat3 } | null)[];
}

/**
 * The candidates of every frame, in reference pixels at full size; the dark core of each mark follows in linkTrack.
 * The work goes in bands of rows, each band with a margin that holds the reach of every filter, so the bands give the
 * same candidates as the whole frame: in this thread, or one band per worker of a pool. A search at half size would be
 * 4 times faster, but it lost the small far shell of clip 1 shot 2 and the blurred marks near the impact of shot 1.
 * Frames without a rotation are left out.
 */
export async function shellCandidates(cv: CV, frames: { gray: Gray8; R: Mat3 | null; other?: Float32Array }[], K: Intrinsics, pool?: Pool, useGpu = true): Promise<{ cands: Candidate[]; valid: boolean[] }> {
  let tt = performance.now();
  const lap = (k: string) => { const now = performance.now(); profile[`shell: ${k}`] = (profile[`shell: ${k}`] ?? 0) + now - tt; tt = now; };
  const { w: W, h: H } = frames[0].gray;
  const hud = staticMask(frames);
  lap('mask');
  let found: Candidate[] | null = null;
  // the GPU when there is one; else the bands on the pool or here
  const dev = useGpu ? await gpuDevice() : null;
  if (dev) {
    found = await gpuCandidates(dev, frames.map((f) => {
      if (!f.R || !hud) return f.R ? f.gray : null;
      const d = f.gray.data.slice();
      for (let j = 0; j < d.length; j++) if (hud[j]) d[j] = 0;
      return { data: d, w: W, h: H };
    }), frames.map((f) => f.R), K, fixedMask(W, H), SHELL).catch((e) => { console.warn('[shell] GPU failed, CPU instead', e); return null; });
    lap('gpu');
  }
  if (!found) {
    const jobs = bandJobs(frames, K, hud, pool ? Math.min(Math.ceil(H / 64), 2 * pool.size) : 1);
    lap('bands');
    found = (pool ? await Promise.all(jobs.map((j) => pool.run<Candidate[]>('shellBand', { job: j }))) : jobs.map((j) => bandCandidates(cv, j))).flat();
    lap('bands on the CPU');
  }
  const cands: Candidate[] = [];
  frames.forEach((f, i) => {
    if (!f.R) return;
    // not on the viewmodel: the points of the other motions of the stabilization (hands, weapon), in the frame
    const other = f.other;
    const onViewmodel = (c: Candidate) => {
      if (!other) return false;
      const p = refToFrame(K, f.R!, c);
      for (let k = 0; k < other.length; k += 2) if (Math.abs(other[k] - p.x) < VIEWMODEL_PX && Math.abs(other[k + 1] - p.y) < VIEWMODEL_PX) return true;
      return false;
    };
    cands.push(...found.filter((c) => c.i === i).sort((u, v) => v.score - u.score).filter((c) => !onViewmodel(c)).slice(0, SHELL.perFrame));
  });
  lap('merge');
  lastCandidates.list = cands;
  return { cands, valid: frames.map((f) => !!f.R) };
}

/** Bands of whole blocks of 8 rows (two per worker, so a slow band does not hold up the rest), with their frame rows. */
function bandJobs(frames: { gray: Gray8; R: Mat3 | null }[], K: Intrinsics, hud: Uint8Array | null, n: number): BandJob[] {
  const { w: W, h: H } = frames[0].gray, step = Math.ceil(H / n / 8) * 8, jobs: BandJob[] = [];
  for (let y0 = 0; y0 < H; y0 += step) {
    const y1 = Math.min(H, y0 + step), m0 = Math.max(0, y0 - MARGIN), m1 = Math.min(H, y1 + MARGIN);
    jobs.push({
      y0, y1, W, H, K,
      frames: frames.map((f) => {
        if (!f.R) return null;
        // the rows of the frame that the band of the reference camera shows, and 2 more for the bilinear warp
        const ys = [[0, m0], [W - 1, m0], [0, m1 - 1], [W - 1, m1 - 1], [W / 2, m0], [W / 2, m1 - 1]].map(([x, y]) => refToFrame(K, f.R!, { x, y }).y);
        const sy0 = Math.max(0, Math.floor(Math.min(...ys)) - 2), sy1 = Math.min(H, Math.ceil(Math.max(...ys)) + 3);
        if (sy1 <= sy0) return null;
        const rows = f.gray.data.slice(sy0 * W, sy1 * W);
        if (hud) for (let j = 0; j < rows.length; j++) if (hud[sy0 * W + j]) rows[j] = 0;
        return { rows, sy0, sh: sy1 - sy0, R: f.R };
      }),
    });
  }
  return jobs;
}

/** The candidates of one band (all frames): warp, median background, texture, and the score of each frame (A.3). */
export function bandCandidates(cv: CV, job: BandJob): Candidate[] {
  const { y0, y1, W, H, K } = job, m0 = Math.max(0, y0 - MARGIN), m1 = Math.min(H, y1 + MARGIN), BH = m1 - m0;
  const mask = fixedMask(W, H);
  const warped = job.frames.map((f) => {
    if (!f) return null;
    return using((keep) => {
      const src = keep(cv.matFromArray(f.sh, W, cv.CV_8UC1, f.rows)), dst = keep(new cv.Mat());
      // the frame rows from sy0 on, into the band rows from m0 on
      const M = mul(mul([1, 0, 0, 0, 1, -m0, 0, 0, 1], toRef(K, f.R)), [1, 0, 0, 0, 1, f.sy0, 0, 0, 1]);
      cv.warpPerspective(src, dst, keep(cv.matFromArray(3, 3, cv.CV_64F, M)), new cv.Size(W, BH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
      return { data: new Uint8Array(dst.data), w: W, h: BH };
    });
  });
  const bg = median(warped.filter((x): x is Gray8 => !!x));
  const out: Candidate[] = [];
  using((keep) => {
    const bgM = keep(cv.matFromArray(BH, W, cv.CV_8UC1, bg.data));
    // texture: the gradient of the background, blurred and dilated
    const bgF = keep(new cv.Mat()), gx = keep(new cv.Mat()), gy = keep(new cv.Mat()), mag = keep(new cv.Mat()), tex = keep(new cv.Mat());
    bgM.convertTo(bgF, cv.CV_32F);
    cv.Sobel(bgF, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(bgF, gy, cv.CV_32F, 0, 1, 3);
    cv.magnitude(gx, gy, mag);
    cv.GaussianBlur(mag, tex, new cv.Size(0, 0), 2);
    cv.dilate(tex, tex, keep(cv.Mat.ones(9, 9, cv.CV_8U)));
    const kw = keep(cv.Mat.ones(SHELL.window, SHELL.window, cv.CV_8U));
    warped.forEach((wg, i) => {
      if (!wg) return;
      using((k2) => {
        const wm = k2(cv.matFromArray(BH, W, cv.CV_8UC1, wg.data)), wF = k2(new cv.Mat());
        wm.convertTo(wF, cv.CV_32F);
        const diff = k2(new cv.Mat()), d = k2(new cv.Mat());
        cv.subtract(bgF, wF, diff);
        cv.GaussianBlur(diff, d, new cv.Size(0, 0), 1.5);
        // large moving areas: |diff| blurred with sigma 25, done at 1/8 size
        const ad = k2(new cv.Mat()), small = k2(new cv.Mat()), big = k2(new cv.Mat());
        cv.absdiff(bgF, wF, ad);
        cv.resize(ad, small, new cv.Size(Math.round(W / 8), Math.round(BH / 8)), 0, 0, cv.INTER_AREA);
        cv.GaussianBlur(small, small, new cv.Size(0, 0), 25 / 8);
        cv.resize(small, big, new cv.Size(W, BH), 0, 0, cv.INTER_LINEAR);
        const score = k2(new cv.Mat());
        cv.addWeighted(d, 1, big, -1.5, 0, score);
        cv.addWeighted(score, 1, tex, -0.25, 0, score);
        const peak = k2(new cv.Mat());
        cv.dilate(score, peak, kw);
        const sc = score.data32F as Float32Array, p = peak.data32F as Float32Array, b = SHELL.border;
        for (let y = Math.max(b, y0); y < Math.min(H - b, y1); y++) {
          const r = (y - m0) * W;
          for (let x = b; x < W - b; x++) {
            const v = sc[r + x];
            if (v <= SHELL.minScore || v !== p[r + x] || !mask.data[y * W + x] || !wg.data[r + x]) continue;
            out.push({ i, x: x + peakOffset(sc[r + x - 1], v, sc[r + x + 1]), y: y + peakOffset(sc[r + x - W], v, sc[r + x + W]), score: v });
          }
        }
      });
    });
  });
  return out;
}

/**
 * The HUD and screen overlays (an FPS counter) of a section: pixels with texture that stay the same in every frame
 * while the camera turns. Null when the camera turns less than about 3 px, as then they do not move in the warp either.
 */
function staticMask(frames: { gray: Gray8; R: Mat3 | null }[]): Uint8Array | null {
  const Rs = frames.map((f) => f.R).filter((R): R is Mat3 => !!R);
  const turn = Math.max(0, ...Rs.map((R) => Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2)))));
  if (turn < 0.002) return null;
  const { w: W, h: H } = frames[0].gray, n = W * H;
  const lo = new Uint8Array(n).fill(255), hi = new Uint8Array(n);
  for (const f of frames) {
    const d = f.gray.data;
    for (let j = 0; j < n; j++) { const v = d[j]; if (v < lo[j]) lo[j] = v; if (v > hi[j]) hi[j] = v; }
  }
  const g = frames[0].gray.data, still = new Uint8Array(n);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const j = y * W + x;
    if (hi[j] - lo[j] < 12 && Math.abs(g[j + 1] - g[j - 1]) + Math.abs(g[j + W] - g[j - W]) > 30) still[j] = 1;
  }
  // grow it by 6 px, so the text and its outline go
  const out = new Uint8Array(n), R = 6;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!still[y * W + x]) continue;
    for (let dy = -R; dy <= R; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      out.fill(1, yy * W + Math.max(0, x - R), yy * W + Math.min(W, x + R + 1));
    }
  }
  return out;
}

/** The per-pixel median of gray images. */
function median(imgs: Gray8[]): Gray8 {
  const { w, h } = imgs[0], n = imgs.length, out = new Uint8Array(w * h), buf = new Uint8Array(n);
  const hist = new Uint16Array(256);
  for (let j = 0; j < w * h; j++) {
    let k = 0;
    for (let i = 0; i < n; i++) { const v = imgs[i].data[j]; if (v) buf[k++] = v; }
    if (!k) continue;
    // a counting median: at most a few dozen values of 0 to 255
    if (k <= 12) { const a = buf.subarray(0, k).sort(); out[j] = a[k >> 1]; continue; }
    hist.fill(0);
    for (let i = 0; i < k; i++) hist[buf[i]]++;
    let c = 0, v = 0;
    const half = k >> 1;
    for (; v < 256; v++) { c += hist[v]; if (c > half) break; }
    out[j] = v;
  }
  return { data: out, w, h };
}

/**
 * Links the candidates frame by frame (A.3): from each of the 10 strongest, walk forward and back. The first step
 * accepts a candidate within 400 px; later steps keep the direction within 30 deg and a length of 0.3 to 4 times the
 * last step, scaled by the frame times. The longest chain wins. Then each point moves to the blob that leads along the
 * motion, and the mark is the dark core.
 */
export function linkTrack(cands: Candidate[], times: number[], valid: boolean[], frames: { gray: Gray8; R: Mat3 | null }[], K: Intrinsics): Track {
  const byFrame = new Map<number, Candidate[]>();
  for (const c of cands) byFrame.set(c.i, [...(byFrame.get(c.i) ?? []), c]);
  const n = times.length;
  const walk = (pts: Map<number, Candidate>, step: 1 | -1) => {
    for (;;) {
      const keys = [...pts.keys()];
      const last = step > 0 ? Math.max(...keys) : Math.min(...keys);
      // up to two frames without a picture (no rotation) are stepped over
      let i = last + step;
      while (i >= 0 && i < n && !valid[i] && Math.abs(i - last) <= 2) i += step;
      if (i < 0 || i >= n) return;
      const here = byFrame.get(i);
      if (!here?.length) return;
      const L = pts.get(last)!;
      const before = keys.filter((k) => (step > 0 ? k < last : k > last)).sort((u, v) => (step > 0 ? v - u : u - v))[0];
      const prev = before != null ? pts.get(before) : undefined;
      let ok: Candidate[];
      if (prev) {
        const vx = L.x - prev.x, vy = L.y - prev.y, vl = Math.hypot(vx, vy);
        const expect = (vl * Math.abs(times[i] - times[last])) / Math.abs(times[last] - times[before!]);
        ok = here.filter((c) => {
          const dx = c.x - L.x, dy = c.y - L.y, dl = Math.hypot(dx, dy);
          // a step of a few pixels has no direction to keep: then only its length counts
          // (a far shell that picks up speed takes a step of 9 px after steps of 1 px in clip 1 shot 2)
          if (vl < SMALL_STEP_PX) return dl < Math.max(4 * SMALL_STEP_PX, SHELL.stepMax * expect);
          // the motion so far points the way the walk goes, forward or back; a short step gets room for the half
          // pixel its ends can be off
          const turn = Math.cos(Math.min(Math.PI / 2, (SHELL.turnDeg * Math.PI) / 180 + Math.atan2(0.5, Math.min(dl, vl))));
          return dl > SHELL.stepMin * expect && dl < SHELL.stepMax * expect && dx * vx + dy * vy > turn * dl * vl;
        });
      } else ok = here.filter((c) => Math.hypot(c.x - L.x, c.y - L.y) < SHELL.firstStep);
      if (!ok.length) return;
      // among the strong ones, the one furthest along the motion: the shell leads its smoke
      const top = Math.max(...ok.map((c) => c.score));
      const strong = ok.filter((c) => c.score > 0.6 * top);
      let pick: Candidate;
      if (prev) {
        // furthest along the motion forward in time, also on a walk back
        const vx = (L.x - prev.x) * step, vy = (L.y - prev.y) * step, along = (c: Candidate) => (c.x - L.x) * vx + (c.y - L.y) * vy;
        pick = strong.reduce((a, b) => (along(b) > along(a) ? b : a));
      } else pick = ok.reduce((a, b) => (b.score > a.score ? b : a));
      pts.set(i, pick);
    }
  };
  let best = new Map<number, Candidate>();
  const total = (m: Map<number, Candidate>) => [...m.values()].reduce((s, c) => s + c.score, 0);
  for (const c of [...cands].sort((a, b) => b.score - a.score).slice(0, 30)) {
    const pts = new Map([[c.i, c]]);
    walk(pts, 1); walk(pts, -1); walk(pts, 1); walk(pts, -1);
    if (pts.size > best.size || (pts.size === best.size && total(pts) > total(best))) best = pts;
  }
  const marks: Track['marks'] = Array(n).fill(null);
  if (best.size < 2) return { marks, candidates: cands.length };
  const all = [...best.keys()].sort((a, b) => a - b);
  const kept = new Set(trimEnds(all, (k) => best.get(k)!, times)), ks = all;
  const first = best.get(ks[0])!, lastC = best.get(ks[ks.length - 1])!;
  const gl = Math.hypot(lastC.x - first.x, lastC.y - first.y) || 1, g = [(lastC.x - first.x) / gl, (lastC.y - first.y) / gl];
  for (const i of ks) {
    const q = best.get(i)!;
    // the leading blob: near, on the line of motion, at least half as strong, furthest along the whole motion
    const along = (c: Candidate) => (c.x - q.x) * g[0] + (c.y - q.y) * g[1];
    const near = (byFrame.get(i) ?? []).filter((c) => Math.hypot(c.x - q.x, c.y - q.y) < 250 && c.score > 0.5 * q.score && Math.abs((c.x - q.x) * -g[1] + (c.y - q.y) * g[0]) < 12);
    const p = near.reduce((a, b) => (along(b) > along(a) ? b : a), q);
    const core = timed('shell: dark core', () => darkCore(frames, K, i, p.x, p.y));
    if (!core) continue;
    marks[i] = { ref: core, frame: refToFrame(K, frames[i].R!, core), score: p.score, jump: !kept.has(i) };
  }
  return { marks, candidates: cands.length };
}

/** A step counts as a jump when its speed differs from the trend of its neighbors by this factor (as motion.ts). */
const JUMP_RATIO = 2.2;
/** ... and by more than this many pixels, which the marks themselves can be off. */
const JUMP_PX = 6;

/**
 * The marks of a track without those past a jump at either end: the speed of a step against the trend of the three
 * steps before it (at the end) or after it (at the start). Past a jump, the frame time is off (the recording skipped
 * or repeated frames, as in clip 1 shot 1) or the linking went on into something else: the mark stays in the track
 * (the impact follows the whole track) but gives no sighting.
 */
export function trimEnds(ks: number[], at: (k: number) => { x: number; y: number }, times: number[]): number[] {
  const speed = (i: number) => { const p = at(ks[i]), q = at(ks[i + 1]); return Math.hypot(q.x - p.x, q.y - p.y) / (times[ks[i + 1]] - times[ks[i]]); };
  /** The speed step i should have, from steps j (log-linear in time, as the shell speeds up near the camera). */
  const trend = (i: number, js: number[]) => {
    const mid = (k: number) => (times[ks[k]] + times[ks[k + 1]]) / 2;
    const pts = js.map((j) => [mid(j), Math.log(Math.max(speed(j), 1e-3))]);
    const mt = pts.reduce((a, p) => a + p[0], 0) / pts.length, ml = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const b = pts.reduce((a, p) => a + (p[0] - mt) * (p[1] - ml), 0) / (pts.reduce((a, p) => a + (p[0] - mt) ** 2, 0) || 1);
    return Math.exp(ml + b * (mid(i) - mt));
  };
  const jump = (i: number, js: number[]) => {
    const v = speed(i), e = trend(i, js), dt = times[ks[i + 1]] - times[ks[i]];
    return (v > JUMP_RATIO * e || v < e / JUMP_RATIO) && Math.abs(v - e) * dt > JUMP_PX;
  };
  // only the last and the first two steps: a jump inside the track is a frame timing error, which the robust fit of
  // the solver handles, or a real change of pace
  let lo = 0, hi = ks.length - 1;
  for (const i of [hi - 2, hi - 1]) if (i >= 3 && jump(i, [i - 3, i - 2, i - 1])) { hi = i; break; }
  for (const i of [1, 0]) if (i + 3 < hi && jump(i, [i + 1, i + 2, i + 3])) { lo = i + 1; break; }
  return ks.slice(lo, hi + 1);
}

/**
 * The dark core of a blob (A.3), at full size: in 13 x 13 reference pixels around it, the background (the median of up
 * to 11 frames, sampled through their rotations) minus this frame, blurred with sigma 0.7, the pixels above 0.7 of the
 * peak, and their weighted centroid.
 */
function darkCore(frames: { gray: Gray8; R: Mat3 | null }[], K: Intrinsics, i: number, cx: number, cy: number): { x: number; y: number } | null {
  const R = 7, S = 2 * R + 1, cur = frames[i];
  if (!cur.R) return null;
  const others = frames.filter((f) => f.R);
  const diff = new Float64Array(S * S).fill(NaN);
  const vals: number[] = [];
  for (let yy = -R; yy <= R; yy++) for (let xx = -R; xx <= R; xx++) {
    const p = { x: cx + xx, y: cy + yy }, q = refToFrame(K, cur.R, p), v = sample(cur.gray, q.x, q.y);
    vals.length = 0;
    for (const f of others) { const o = refToFrame(K, f.R!, p), u = sample(f.gray, o.x, o.y); if (!Number.isNaN(u)) vals.push(u); }
    if (Number.isNaN(v) || !vals.length) continue;
    vals.sort((a, b) => a - b);
    diff[(yy + R) * S + (xx + R)] = vals[vals.length >> 1] - v;
  }
  // blur with a small Gaussian (sigma 0.7) over 3 x 3, inside the patch
  const e = Math.exp(-1 / (2 * 0.49)), k = [e, 1, e].map((a) => a / (1 + 2 * e));
  let top = -Infinity;
  const d = new Float64Array(S * S).fill(NaN);
  for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
    let sum = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) sum += k[a + 1] * k[b + 1] * diff[(y + a) * S + x + b];
    d[y * S + x] = sum;
    if (sum > top) top = sum;
  }
  if (!(top > 0)) return null;
  let sw = 0, sx = 0, sy = 0;
  for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
    const v = d[y * S + x];
    if (v > 0.7 * top) { sw += v; sx += v * (x - R); sy += v * (y - R); }
  }
  return { x: cx + sx / sw, y: cy + sy / sw };
}
