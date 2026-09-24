/**
 * The impact time from the shell track (automation plan section 9, decision of 2026-09-24): the track goes on past its
 * last mark with the speed and the acceleration of its last marks, and the impact is between the last clean frame and
 * the first frame with a change around that path in the stabilized view (Appendix A.5). It needs no crater, which is
 * often hidden, and no minimap position.
 */
import { sample, type Gray8 } from './image.ts';
import { refToFrame, type Intrinsics, type Mat3 } from './rotation.ts';

export interface ImpactFit {
  /** The last clean frame and the first changed frame (s), or null when no clear change shows. */
  a: number; b: number;
  /** 0 to 1: how clear the change is. */
  conf: number;
  /** Where the impact is in the reference camera (px), and the changed share of each frame after the track. */
  at: { x: number; y: number };
  shares: { t: number; share: number }[];
  reason?: string;
}

/** A pixel changed when its gray value moved by more than this since the frame before (A.5). */
const CHANGED = 25;
/** Half the side of the square (px at 2160p). */
const HALF = 250;
/** A frame shows the impact when this share of the square changed, and the frame before stayed clean. */
const SHARE_HIT = 0.05, SHARE_CLEAN = 0.02;

/** Where the shell would be at time t, from its last marks (ref camera px): a parabola through the last three. */
export function extrapolate(marks: { t: number; x: number; y: number }[], t: number): { x: number; y: number } {
  const m = marks.slice(-3);
  if (m.length < 2) return { x: m[0].x, y: m[0].y };
  const [p, q] = [m[m.length - 2], m[m.length - 1]];
  const v = { x: (q.x - p.x) / (q.t - p.t), y: (q.y - p.y) / (q.t - p.t) };
  let acc = { x: 0, y: 0 };
  if (m.length === 3) {
    const v0 = { x: (m[1].x - m[0].x) / (m[1].t - m[0].t), y: (m[1].y - m[0].y) / (m[1].t - m[0].t) };
    const dt = (m[2].t - m[0].t) / 2;
    acc = { x: (v.x - v0.x) / dt, y: (v.y - v0.y) / dt };
  }
  // v is the speed in the middle of the last step: at the last mark it is half a step of acceleration more
  const h = (q.t - p.t) / 2, vx = v.x + acc.x * h, vy = v.y + acc.y * h, d = t - q.t;
  return { x: q.x + vx * d + 0.5 * acc.x * d * d, y: q.y + vy * d + 0.5 * acc.y * d * d };
}

/**
 * Scans the frames after the last mark. Each frame is compared with the one before it in the reference camera, in a
 * square around the extrapolated path. A frame without a camera (the stabilization failed: the shake of the impact)
 * compares with the camera of the last good frame.
 */
export function impactFromTrack(frames: { t: number; gray: Gray8; R: Mat3 | null }[], K: Intrinsics, marks: { t: number; x: number; y: number }[], maxAfterS = 1.5): ImpactFit | null {
  if (marks.length < 2) return null;
  const last = marks[marks.length - 1];
  const s = frames[0].gray.h / 2160, half = Math.round(HALF * s), step = 2;
  const from = last.t;
  const centerAt = (t: number) => marks.find((m) => Math.abs(m.t - t) < 1e-3) ?? extrapolate(marks, Math.min(t, last.t + 0.5));
  const after = frames.map((f, i) => ({ f, i })).filter(({ f }) => f.t >= from - 1e-4 && f.t <= last.t + maxAfterS);
  if (after.length < 2) return null;
  const shares: ImpactFit['shares'] = [];
  let R = after[0].f.R;
  for (let k = 1; k < after.length; k++) {
    const prev = after[k - 1].f, cur = after[k].f;
    const Rp = prev.R ?? R, Rc = cur.R ?? Rp;
    if (!Rp || !Rc) continue;
    R = Rc;
    // the square follows the path, but not past the time the shell could still fly
    const c = centerAt(cur.t);
    let changed = 0, count = 0;
    for (let y = c.y - half; y <= c.y + half; y += step) {
      for (let x = c.x - half; x <= c.x + half; x += step) {
        const p0 = refToFrame(K, Rp, { x, y }), p1 = refToFrame(K, Rc, { x, y });
        const v0 = sample(prev.gray, p0.x, p0.y), v1 = sample(cur.gray, p1.x, p1.y);
        if (Number.isNaN(v0) || Number.isNaN(v1)) continue;
        count++;
        if (Math.abs(v1 - v0) > CHANGED) changed++;
      }
    }
    shares.push({ t: cur.t, share: count > 100 ? changed / count : NaN });
  }
  const at = centerAt(last.t);
  for (let k = 0; k < shares.length; k++) {
    const sh = shares[k].share, before = k ? shares[k - 1].share : 0;
    if (!(sh >= SHARE_HIT)) continue;
    if (!(before <= SHARE_CLEAN)) return { a: NaN, b: NaN, conf: 0, at, shares, reason: 'the view changed before the shell landed' };
    const a = k ? shares[k - 1].t : from;
    // clear: the jump is large against the frame before
    const conf = Math.min(1, (sh - before) / (2 * SHARE_HIT));
    return { a, b: shares[k].t, conf, at: centerAt(shares[k].t), shares };
  }
  return { a: NaN, b: NaN, conf: 0, at, shares, reason: shares.some((x) => Number.isNaN(x.share)) ? 'the landing is out of view' : 'no clear change where the shell lands' };
}
