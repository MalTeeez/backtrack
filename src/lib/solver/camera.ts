/** Camera math that turns pixels into rays. X points east, Y north and Z up. Headings run clockwise from north. */
import type { Pt, Vec3 } from './types.ts';

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const wrap360 = (a: number) => { a %= 360; return a < 0 ? a + 360 : a; };
/** The signed difference a - b (deg) in [-180, 180), for any a and b. */
export const angleDiff = (a: number, b: number) => wrap360(a - b + 180) - 180;

/** Focal length in pixels, f = (W/2) / tan(FOV/2). A vertical FOV uses H instead of W. */
export function focalPx(w: number, h: number, fovDeg: number, axis: 'h' | 'v'): number {
  const half = (axis === 'v' ? h : w) / 2;
  return half / Math.tan((fovDeg * D2R) / 2);
}

/** Converts a video pixel to camera coordinates, with the origin at the center and y up. */
export const centered = (p: Pt, w: number, h: number): Pt => ({ x: p.x - w / 2, y: h / 2 - p.y });

/** Camera pitch (deg) from a vertical world edge through a and b, in centered coordinates. Returns null for a degenerate edge. */
export function pitchFromEdge(a: Pt, b: Pt, f: number): number | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const den = a.y * dx - a.x * dy;
  if (Math.abs(den) < 1e-9) return null;
  return Math.atan((f * dx) / den) * R2D;
}

/** Approximate 1-sigma pitch error (deg) of an edge, (f / |x_mid|) * (1.41 * sigmaPx / length). */
export function edgePitchSigma(a: Pt, b: Pt, f: number, sigmaPx: number): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const xMid = Math.max(Math.abs((a.x + b.x) / 2), 1);
  return (f / xMid) * ((1.41 * sigmaPx) / Math.max(len, 1)) * R2D;
}

/** Extra error (deg) an edge may have beyond its marks: few building corners are exactly vertical. */
const EDGE_FLOOR_DEG = 0.3;
/** How many standard deviations an edge may be off the others before it counts as wrong. */
const EDGE_SIGMAS = 3;
/** The pitch from all edges is imprecise above this (deg). */
export const PITCH_SIGMA_MAX = 0.3;

export interface EdgeInfo { pitch: number | null; sigma: number; offBy: number | null }

/**
 * The pitch of each edge with its error, and the pitch of all of them (weighted by their errors). An edge counts as
 * off (`offBy`, in deg) when it differs from the mean of the other edges by more than its own error and theirs allow,
 * so a short or central edge (large error) is not flagged just for being imprecise.
 */
export function edgeReport(edges: [Pt, Pt][], w: number, h: number, f: number, sigmaPx: number) {
  const list = edges.map(([a0, b0]) => {
    const a = centered(a0, w, h), b = centered(b0, w, h);
    return { pitch: pitchFromEdge(a, b, f), sigma: edgePitchSigma(a, b, f, sigmaPx) };
  });
  const good = list.map((e, i) => ({ ...e, i })).filter((e): e is { pitch: number; sigma: number; i: number } => e.pitch != null);
  const weight = (e: { sigma: number }) => 1 / (e.sigma * e.sigma);
  const mean = (xs: typeof good) => xs.reduce((a, e) => a + e.pitch * weight(e), 0) / xs.reduce((a, e) => a + weight(e), 0);
  const info: EdgeInfo[] = list.map((e, i) => {
    const others = good.filter((o) => o.i !== i);
    if (e.pitch == null || !others.length) return { ...e, offBy: null };
    const m = mean(others), mSigma = 1 / Math.sqrt(others.reduce((a, o) => a + weight(o), 0));
    const d = e.pitch - m, allowed = EDGE_SIGMAS * Math.hypot(e.sigma, mSigma, EDGE_FLOOR_DEG);
    return { ...e, offBy: Math.abs(d) > allowed ? d : null };
  });
  // the pitch leaves out the edges that are off, when some are left
  const kept = good.filter((e) => info[e.i].offBy == null);
  const use = kept.length ? kept : good;
  const pitch = use.length ? mean(use) : null;
  const sigma = use.length ? 1 / Math.sqrt(use.reduce((a, e) => a + weight(e), 0)) : Infinity;
  return { edges: info, pitch, sigma };
}

/**
 * The camera axes in world coordinates for a heading, a pitch and a roll (deg): right, up and forward. A positive roll
 * turns the right axis toward up (automation plan Appendix A.1).
 */
export function cameraAxes(headingDeg: number, pitchDeg: number, rollDeg = 0): { R: Vec3; U: Vec3; F: Vec3 } {
  const h = headingDeg * D2R, p = pitchDeg * D2R, r = rollDeg * D2R;
  const ch = Math.cos(h), sh = Math.sin(h), cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
  const R0 = [ch, -sh, 0], U0 = [-sp * sh, -sp * ch, cp];
  const F: Vec3 = [cp * sh, cp * ch, sp];
  const R: Vec3 = [0, 0, 0], U: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) { R[i] = cr * R0[i] + sr * U0[i]; U[i] = -sr * R0[i] + cr * U0[i]; }
  return { R, U, F };
}

/** World ray through camera point c, for a camera at a heading, pitch and roll in degrees. */
export function rayWorld(c: Pt, f: number, headingDeg: number, pitchDeg: number, rollDeg = 0): Vec3 {
  const { R, U, F } = cameraAxes(headingDeg, pitchDeg, rollDeg);
  const d: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) d[i] = c.x * R[i] + c.y * U[i] + f * F[i];
  const n = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / n, d[1] / n, d[2] / n];
}

/** Azimuth (deg, clockwise from north) and elevation (deg) of a unit vector. */
export function azEl(d: Vec3): { az: number; el: number } {
  return { az: wrap360(Math.atan2(d[0], d[1]) * R2D), el: Math.asin(Math.max(-1, Math.min(1, d[2]))) * R2D };
}

export function dirTo(O: Vec3, P: Vec3): Vec3 {
  const d: Vec3 = [P[0] - O[0], P[1] - O[1], P[2] - O[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / n, d[1] / n, d[2] / n];
}

/** Projects a world point into the camera, in video pixels. Returns null for a point behind the camera. */
export function project(P: Vec3, O: Vec3, w: number, h: number, f: number, headingDeg: number, pitchDeg: number, rollDeg = 0): Pt | null {
  const { R, U, F } = cameraAxes(headingDeg, pitchDeg, rollDeg);
  const v = [P[0] - O[0], P[1] - O[1], P[2] - O[2]];
  const dot = (a: number[]) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
  const z = dot(F);
  if (z <= 0) return null;
  return { x: w / 2 + (f * dot(R)) / z, y: h / 2 - (f * dot(U)) / z };
}

/** y = a + b x + c x^2 by least squares: [a, b, c], or null. */
export function quadratic(xs: number[], ys: number[]): number[] | null {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], y = [0, 0, 0];
  xs.forEach((x, i) => { const r = [1, x, x * x]; for (let a = 0; a < 3; a++) { y[a] += r[a] * ys[i]; for (let b = 0; b < 3; b++) A[a][b] += r[a] * r[b]; } });
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-18) return null;
  return [0, 1, 2].map((c) => det(A.map((row, r) => row.map((v, cc) => (cc === c ? y[r] : v)))) / D);
}
