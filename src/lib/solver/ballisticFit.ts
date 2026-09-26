/**
 * The path model for the weapon ballistics (ballistics.ts). The unknowns are the direction from the crater to the gun
 * (th) and the launch elevation (e). Together they fix the gun position (the landing range behind the crater) and the
 * position of the shell at every moment of the flight. The impact time of each sighting says where on the flight the
 * shell was. The sighting position near the crater follows from each candidate flight (observerShift).
 */
import { at, flightAt, flights, heightAt, landing, type Ballistics, type Flight } from './ballistics.ts';
import { D2R, R2D, angleDiff, wrap360 } from './camera.ts';
import type { Fit, GroundAt, Id, Ray, ShiftPrior, Vec3 } from './types.ts';

/** The angular error (rad) of a ray without its own. */
const RAY_SIGMA = 1e-3;

/**
 * The shift (m) of the observer that brings the rays closest to the shell points P, by least squares on the distance
 * of each point from its ray, across the path of the shell and (with less weight) along it. The rays start at the
 * crater, and the user stood near it, but not on it. A prior (the sighting position from the minimap) pulls the ground
 * shift toward itself with its own error. The height stays fixed. When the fit solved it with a prior, it found 0.5 m
 * for a user 5 m above the terrain data on synthetic data. Thus the user gives the height above the ground
 * (Shot.raisedM).
 */
export function observerShift(rays: Ray[], P: Vec3[], prior?: ShiftPrior): [number, number] {
  // the normal equations N s = h of the shift s
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], h = [0, 0, 0];
  /** Adds the direction e (unit, across the ray) with the weight k. The miss of the point along e is (q - s) . e. */
  const add = (e: number[], k: number, q: number[]) => {
    const eq = e[0] * q[0] + e[1] * q[1] + e[2] * q[2];
    for (let i = 0; i < 3; i++) { h[i] += k * e[i] * eq; for (let j = 0; j < 3; j++) N[i][j] += k * e[i] * e[j]; }
  };
  const qs = rays.map((r, i) => [P[i][0] - r.O[0], P[i][1] - r.O[1], P[i][2] - r.O[2]]);
  // every ray counts the same, in meters of the typical miss, so a prior (in meters) weighs right against them. A
  // weight per ray by its own miss in meters (its angular error times its distance) trusts the rays near the observer
  // too much. On the benchmark, it doubled the gun error with frame time errors of 30 ms.
  const miss = rays.map((r, i) => (r.sigma ?? RAY_SIGMA) * Math.hypot(qs[i][0], qs[i][1], qs[i][2])).sort((x, y) => x - y);
  const k0 = 1 / Math.max(0.05, miss[miss.length >> 1] ?? 1) ** 2;
  rays.forEach((r, i) => {
    const D = r.D, q = qs[i];
    // Along the path, a ray counts less by its larger error there, because an uncertain frame time moves it along the path.
    const sc = r.sigma ?? RAY_SIGMA, k = (sig: number) => k0 * (sc / sig) ** 2;
    if (r.along) {
      // along the path of the shell and across it
      const t = r.along, c = [D[1] * t[2] - D[2] * t[1], D[2] * t[0] - D[0] * t[2], D[0] * t[1] - D[1] * t[0]];
      add(c, k(sc), q);
      add(t, k(r.sigmaAlong ?? sc), q);
    } else {
      // the two directions across the ray
      const e1 = Math.abs(D[2]) < 0.9 ? [-D[1], D[0], 0] : [0, -D[2], D[1]], n1 = Math.hypot(e1[0], e1[1], e1[2]);
      const u = [e1[0] / n1, e1[1] / n1, e1[2] / n1], v = [D[1] * u[2] - D[2] * u[1], D[2] * u[0] - D[0] * u[2], D[0] * u[1] - D[1] * u[0]];
      add(u, k(sc), q); add(v, k(sc), q);
    }
  });
  if (prior) {
    const k = 1 / (prior.sigma * prior.sigma);
    N[0][0] += k; N[1][1] += k; h[0] += k * prior.s[0]; h[1] += k * prior.s[1];
  }
  const det = N[0][0] * N[1][1] - N[0][1] * N[1][0];
  return Math.abs(det) < 1e-18 ? [0, 0] : [(h[0] * N[1][1] - N[0][1] * h[1]) / det, (N[0][0] * h[1] - N[1][0] * h[0]) / det];
}

interface Candidate { th: number; f: Flight; R: number; T: number }

/**
 * The scale (rad) of the robust cost the search minimizes. A miss up to about this counts like a square, and a larger
 * one grows only with its logarithm (Cauchy). A sighting whose frame time is off (the recording skipped frames) misses
 * the true flight by far, and with squares it would pull the fit toward itself.
 */
const ROBUST = 0.3 * D2R;

/**
 * The miss (m) that the positions (the minimap, the sighting position near the crater) and the flight model explain on
 * their own. Near the impact the shell is only tens of meters away, so such a miss is several degrees there and says
 * nothing about the FOV, the headings or the marks.
 */
const MODEL_M = 10;

/**
 * The observer shift of each clip, and the error of the rays against one candidate flight. The error holds the angular
 * RMS (deg), the RMS miss (m), the RMS of the angle beyond what a miss of MODEL_M explains (deg), and the robust cost
 * the search minimizes. In that cost, each miss counts in units of the error of its ray (`w` scales each ray, section
 * 12.5).
 */
function evaluate(c: Candidate, clips: Map<Id, Ray[]>, n: number, C: Vec3, zGun: number, w: Map<Ray, { cross: number; along: number }>, priors?: Record<Id, ShiftPrior>) {
  const th = c.th * D2R, dx = Math.sin(th), dy = Math.cos(th);
  const gx = C[0] + c.R * dx, gy = C[1] + c.R * dy;
  const shifts: Record<Id, [number, number]> = {};
  const rho = (x: number) => ROBUST * ROBUST * Math.log1p((x / ROBUST) ** 2);
  let ss = 0, cost = 0, sm = 0, so = 0;
  for (const [clip, rays] of clips) {
    const P = rays.map((r): Vec3 => { const p = at(c.f, c.T - r.tau); return [gx - p.x * dx, gy - p.x * dy, zGun + p.z]; });
    const [ox, oy] = (shifts[clip] = observerShift(rays, P, priors?.[clip]));
    rays.forEach((r, i) => {
      const { a, len, al, cr } = rayMiss(r, P[i], ox, oy), over = Math.max(0, a - Math.atan(MODEL_M / len));
      ss += a * a; sm += (Math.sin(a) * len) ** 2; so += over * over;
      const s = w.get(r)!;
      cost += al == null ? rho(a * s.along) : rho(cr * s.cross) + rho(al * s.along);
    });
  }
  return { shifts, rms: Math.sqrt(ss / n) * R2D, missM: Math.sqrt(sm / n), excess: Math.sqrt(so / n) * R2D, cost };
}

/**
 * The miss of a ray that starts shifted by (ox, oy), relative to the shell point P. It gives the angle `a` (rad) and
 * the distance `len` (m). With the path direction of the ray, it also splits the miss along the path of the shell
 * (`al`, signed, positive ahead of the mark) and across it (`cr`, unsigned).
 */
function rayMiss(r: Ray, P: Vec3, ox: number, oy: number) {
  const v = [P[0] - r.O[0] - ox, P[1] - r.O[1] - oy, P[2] - r.O[2]];
  const len = Math.hypot(v[0], v[1], v[2]), cos = (v[0] * r.D[0] + v[1] * r.D[1] + v[2] * r.D[2]) / len;
  const a = Math.acos(Math.max(-1, Math.min(1, cos)));
  if (!r.along) return { a, len, al: undefined, cr: 0 };
  const m = [v[0] / len - cos * r.D[0], v[1] / len - cos * r.D[1], v[2] / len - cos * r.D[2]];
  const al = m[0] * r.along[0] + m[1] * r.along[1] + m[2] * r.along[2];
  return { a, len, al, cr: Math.sqrt(Math.max(0, Math.sin(a) ** 2 - al * al)) };
}

/**
 * Each ray against a fit, for the pictures of the result. A ray gives the sighting position on its frame (O, with the
 * shift of its clip), the shell on the fitted flight at that moment (P), and the miss (deg) along the path of the shell
 * and across it.
 */
export function rayMisses(b: Ballistics, fit: Fit, rays: Ray[], C: Vec3, zGun: number) {
  const th = fit.th * D2R, dx = Math.sin(th), dy = Math.cos(th), f = flightAt(b, fit.e);
  return rays.map((r) => {
    const p = at(f, fit.T - r.tau), P: Vec3 = [C[0] + fit.R * dx - p.x * dx, C[1] + fit.R * dy - p.x * dy, zGun + p.z];
    const [ox, oy] = fit.shifts[r.clip] ?? [0, 0], m = rayMiss(r, P, ox, oy);
    return { O: [r.O[0] + ox, r.O[1] + oy, r.O[2]] as Vec3, P, along: (m.al ?? 0) * R2D, cross: (m.al == null ? m.a : m.cr) * R2D };
  });
}

/** The fitted flight as n points from the gun to the impact, each with its time before the impact (s). */
export function flightPath(b: Ballistics, fit: Fit, C: Vec3, zGun: number, n = 80): { tau: number; P: Vec3 }[] {
  const th = fit.th * D2R, dx = Math.sin(th), dy = Math.cos(th), f = flightAt(b, fit.e);
  return Array.from({ length: n }, (_, k) => {
    const t = (k / (n - 1)) * fit.T, p = at(f, t);
    return { tau: fit.T - t, P: [C[0] + fit.R * dx - p.x * dx, C[1] + fit.R * dy - p.x * dy, zGun + p.z] as Vec3 };
  });
}

/**
 * The scales of each ray in the cost, across the path of the shell and along it. Each scale is the median error of the
 * rays over the error of the ray. Thus a typical ray keeps the scale ROBUST, and a larger error counts less. A vague
 * mark has a larger error, and so does a fast shell with an uncertain frame time, along its path.
 */
function rayScales(rays: Ray[]): Map<Ray, { cross: number; along: number }> {
  const sig = rays.map((r) => r.sigma ?? RAY_SIGMA), ref = [...sig].sort((a, b) => a - b)[sig.length >> 1];
  return new Map(rays.map((r, i) => [r, { cross: ref / sig[i], along: ref / (r.sigmaAlong ?? sig[i]) }]));
}

export interface BallisticOptions {
  C: Vec3; zGun: number; lo: number; hi: number;
  /** Keeps only guns inside [rmin, rmax] when set. */
  range: [number, number] | null;
  ground?: GroundAt;
  /** A known fit to start from (the Monte Carlo runs). The search stays within 5 deg of its direction and elevation. */
  near?: { th: number; e: number };
  /** The sighting position from the minimap in each clip, as a shift from the crater. */
  priors?: Record<Id, ShiftPrior>;
}

// The terrain check takes a sample every 10 m, allows 3 m of slack for the 2 m terrain grid, and skips 30 m at each
// end, where the shell is near the ground anyway.
const CLEAR_STEP = 10, CLEARANCE = 3, CLEAR_END = 30;

/**
 * How close the flight comes to the ground between the gun and the crater. `m` is the least height above the ground,
 * and `deg` the least angle of that gap as seen from the nearer end (gun or crater). The angle tells about how much
 * lower the shell could fly before it touches the ground there. A shell is always low near both ends, so the angle, not the height,
 * says whether the terrain makes the shot hard. With `stopBelow` (m), it stops at the first sample lower than that.
 * `end` meters at each end do not count.
 */
function clearance(c: Candidate, C: Vec3, zGun: number, ground: GroundAt, stopBelow = -Infinity, end = CLEAR_END) {
  const th = c.th * D2R, dx = Math.sin(th), dy = Math.cos(th);
  const gx = C[0] + c.R * dx, gy = C[1] + c.R * dy;
  // The shell leaves from the ground at this candidate's own gun, not from the gun height of the last solve. A gun
  // elsewhere may stand higher, and would otherwise start under the ground and 'hit' it at once.
  const zLaunch = ground(gx, gy) ?? zGun;
  let m = Infinity, deg = Infinity, atM = 0;
  for (let d = end; d < c.R - end; d += CLEAR_STEP) {
    const z = ground(gx - d * dx, gy - d * dy);
    if (z == null) continue;
    const above = zLaunch + heightAt(c.f, d) - z;
    m = Math.min(m, above);
    const a = (Math.atan2(above, Math.min(d, c.R - d)) * 180) / Math.PI;
    if (a < deg) { deg = a; atM = d; }
    if (m < stopBelow) break;
  }
  return { m, deg, atM };
}
const clears = (c: Candidate, C: Vec3, zGun: number, ground: GroundAt) => clearance(c, C, zGun, ground, -CLEARANCE).m >= -CLEARANCE;

/** Searches direction and elevation, coarse to fine. Returns the best fit, or null if no candidate fits. */
export function fitBallistic(b: Ballistics, rays: Ray[], o: BallisticOptions): Fit | null {
  const dz = o.C[2] - o.zGun;
  const clips = new Map<Id, Ray[]>();
  for (const r of rays) clips.set(r.clip, [...(clips.get(r.clip) ?? []), r]);
  const w = rayScales(rays);
  // one landing per flight, not one per candidate
  const landings = new Map<Flight, ReturnType<typeof landing>>();
  // the refinement and the Monte Carlo neighborhood step past lo and hi too, so every candidate checks the window
  const mid = (o.lo + o.hi) / 2, half = (o.hi - o.lo) / 2 + 1e-9;
  const candidate = (th: number, f: Flight): Candidate | null => {
    if (Math.abs(angleDiff(th, mid)) > half) return null;
    if (!landings.has(f)) landings.set(f, landing(f, dz));
    const l = landings.get(f);
    if (!l) return null;
    if (o.range && (l.R < o.range[0] || l.R > o.range[1])) return null;
    return { th: wrap360(th), f, R: l.R, T: l.T };
  };
  const NEAR = 5;
  const [lo, hi, step] = o.near ? [o.near.th - NEAR, o.near.th + NEAR, 0.5] : [o.lo, o.hi, 1];
  let curve: Float64Array | null = null;
  // a holder, because TypeScript does not see the closure assign it
  const found: { best: (Candidate & ReturnType<typeof evaluate>) | null } = { best: null };
  // the terrain check runs only for a candidate that would become the best, which keeps it cheap
  const tryOne = (th: number, f: Flight) => {
    const c = candidate(th, f);
    if (!c) return;
    const e = evaluate(c, clips, rays.length, o.C, o.zGun, w, o.priors);
    if (curve) { const k = Math.round((th - lo) / step) % curve.length; if (k >= 0 && e.cost < curve[k]) curve[k] = e.cost; }
    if (found.best && e.cost >= found.best.cost) return;
    if (o.ground && !clears(c, o.C, o.zGun, o.ground)) return;
    found.best = { ...c, ...e };
  };

  // The coarse search tries every elevation of the table for each direction, then a finer direction step near the best
  // one. Near a known fit, it tries only its neighborhood.
  const table = o.near ? flights(b, 0.5).filter((f) => Math.abs(f.e - o.near!.e) <= NEAR) : flights(b, 0.5);
  // the least cost of each direction of the coarse search, for the ambiguity report (section 12.3)
  const circular = o.hi - o.lo >= 360 - 1e-9;
  curve = o.near ? null : new Float64Array(circular ? Math.round(360 / step) : Math.floor((hi - lo) / step + 1e-9) + 1).fill(Infinity);
  for (let th = lo; th <= hi + 1e-9; th += step) for (const f of table) tryOne(th, f);
  const coarse = curve;
  curve = null;
  if (!found.best) return null;
  const b0: Candidate = found.best;
  for (let th = b0.th - 1.5; th <= b0.th + 1.5; th += 0.1) for (const f of table) tryOne(th, f);

  // The fine search alternates between direction and elevation, with fresh flights for the elevations.
  for (const [span, step] of [[0.6, 0.02], [0.05, 0.002]]) {
    for (let round = 0; round < 2; round++) {
      const c: Candidate = found.best!;
      for (let th = c.th - span; th <= c.th + span; th += step) tryOne(th, c.f);
      const c2: Candidate = found.best!;
      const lo = Math.max(b.elevMinDeg, c2.f.e - span), hi = Math.min(b.elevMaxDeg, c2.f.e + span);
      for (let e = lo; e <= hi + 1e-9; e += step) tryOne(c2.th, flightAt(b, e));
    }
  }
  const r = found.best!;
  return {
    th: r.th, e: r.f.e, R: r.R, T: r.T, rms: r.rms, missM: r.missM, excess: r.excess, shifts: r.shifts, cost: r.cost,
    second: (coarse && secondMinimum(coarse, lo, step, circular)) ?? undefined,
    // How hard the shot is. The check leaves out the ends, where the ground under a gun on a slope or next to the
    // crater says nothing about the flight.
    clearance: o.ground ? clearance(r, o.C, o.zGun, o.ground, -Infinity, Math.max(100, r.R * 0.1)) : undefined,
  };
}

/** The least cost that counts as a real misfit for n rays, with each ray off by 0.1 deg. Below it, costs are noise. */
export const costFloor = (n: number) => n * ROBUST * ROBUST * Math.log1p(((0.1 * D2R) / ROBUST) ** 2);

/** Directions closer than this (deg) to the best one belong to its minimum. */
const SAME_MINIMUM_DEG = 15;

/**
 * The second-best minimum of the coarse cost over direction. It is the least local minimum at least SAME_MINIMUM_DEG
 * from the best one, with its cost and the cost of the best. Null when there is none.
 */
export function secondMinimum(curve: Float64Array, lo: number, step: number, circular: boolean): { th: number; cost: number; best: number } | null {
  const n = curve.length;
  let bi = 0;
  for (let i = 1; i < n; i++) if (curve[i] < curve[bi]) bi = i;
  const at = (i: number) => (circular ? curve[(i + n) % n] : i < 0 || i >= n ? Infinity : curve[i]);
  let second: { th: number; cost: number } | null = null;
  for (let i = 0; i < n; i++) {
    const c = curve[i];
    if (!Number.isFinite(c) || c > at(i - 1) || c > at(i + 1)) continue;
    const d = circular ? Math.abs(angleDiff(i * step, bi * step)) : Math.abs(i - bi) * step;
    if (d < SAME_MINIMUM_DEG) continue;
    if (!second || c < second.cost) second = { th: wrap360(lo + i * step), cost: c };
  }
  return second && { ...second, best: curve[bi] };
}
