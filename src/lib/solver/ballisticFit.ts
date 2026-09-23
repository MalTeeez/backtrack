/**
 * The path model for the weapon ballistics (ballistics.ts). The unknowns are the direction from the crater to the gun
 * (th) and the launch elevation (e). Together they fix the gun position (the landing range behind the crater) and the
 * position of the shell at every moment of the flight. The impact time of each sighting says where on the flight the
 * shell was. Where the user stood near the crater follows from each candidate flight (observerShift).
 */
import { at, flightAt, flights, heightAt, landing, type Ballistics, type Flight } from './ballistics.ts';
import { D2R, R2D, wrap360 } from './camera.ts';
import type { Fit, GroundAt, Id, Ray, Vec3 } from './types.ts';

/**
 * The ground shift (m) of the observer that brings the rays closest to the shell points P, by least squares on the
 * distance of each point from its ray. The rays start at the crater, and the user stood near it, but not on it.
 */
export function observerShift(rays: Ray[], P: Vec3[]): [number, number] {
  let a = 0, b = 0, d = 0, u = 0, w = 0;
  rays.forEach((r, i) => {
    const D = r.D, q = [P[i][0] - r.O[0], P[i][1] - r.O[1], P[i][2] - r.O[2]];
    // M = I - D D^T keeps the part across the ray. The shift moves only x and y.
    const dq = D[0] * q[0] + D[1] * q[1] + D[2] * q[2];
    a += 1 - D[0] * D[0]; b -= D[0] * D[1]; d += 1 - D[1] * D[1];
    u += q[0] - D[0] * dq; w += q[1] - D[1] * dq;
  });
  const det = a * d - b * b;
  return Math.abs(det) < 1e-12 ? [0, 0] : [(u * d - b * w) / det, (a * w - b * u) / det];
}

interface Candidate { th: number; f: Flight; R: number; T: number }

/**
 * The scale (rad) of the robust cost the search minimizes: a miss up to about this counts like a square, a larger one
 * grows only with its logarithm (Cauchy). A sighting whose frame time is off (the recording skipped frames) misses
 * the true flight by far, and with squares it would pull the fit toward itself.
 */
const ROBUST = 0.3 * D2R;

/**
 * The miss (m) that the positions (minimap, the spot near the crater) and the flight model explain on their own. Near
 * the impact the shell is only tens of meters away, so such a miss is several degrees there and says nothing about
 * the FOV, the headings or the marks.
 */
const MODEL_M = 10;

/**
 * The observer shift of each clip, and the error of the rays against one candidate flight: the angular RMS (deg), the
 * RMS miss (m), and the RMS of the angle beyond what a miss of MODEL_M explains (deg).
 */
function evaluate(c: Candidate, clips: Map<Id, Ray[]>, n: number, C: Vec3, zGun: number) {
  const th = c.th * D2R, dx = Math.sin(th), dy = Math.cos(th);
  const gx = C[0] + c.R * dx, gy = C[1] + c.R * dy;
  const shifts: Record<Id, [number, number]> = {};
  let ss = 0, cost = 0, sm = 0, so = 0;
  for (const [clip, rays] of clips) {
    const P = rays.map((r): Vec3 => { const p = at(c.f, c.T - r.tau); return [gx - p.x * dx, gy - p.x * dy, zGun + p.z]; });
    // only rays without a known position move with the estimated spot near the crater
    const free = rays.map((r, i) => ({ r, P: P[i] })).filter((x) => !x.r.fixed);
    const [ox, oy] = free.length ? (shifts[clip] = observerShift(free.map((x) => x.r), free.map((x) => x.P))) : [0, 0];
    rays.forEach((r, i) => {
      const sx = r.fixed ? 0 : ox, sy = r.fixed ? 0 : oy;
      const v = [P[i][0] - r.O[0] - sx, P[i][1] - r.O[1] - sy, P[i][2] - r.O[2]];
      const len = Math.hypot(v[0], v[1], v[2]), cos = (v[0] * r.D[0] + v[1] * r.D[1] + v[2] * r.D[2]) / len;
      const a = Math.acos(Math.max(-1, Math.min(1, cos))), over = Math.max(0, a - Math.atan(MODEL_M / len));
      ss += a * a; sm += (Math.sin(a) * len) ** 2; so += over * over;
      cost += ROBUST * ROBUST * Math.log1p((a / ROBUST) ** 2);
    });
  }
  return { shifts, rms: Math.sqrt(ss / n) * R2D, missM: Math.sqrt(sm / n), excess: Math.sqrt(so / n) * R2D, cost };
}

export interface BallisticOptions {
  C: Vec3; zGun: number; lo: number; hi: number;
  /** Keeps only guns inside [rmin, rmax] when set. */
  range: [number, number] | null;
  ground?: GroundAt;
  /** A known fit to start from (the Monte Carlo runs): the search stays within 5 deg of its direction and elevation. */
  near?: { th: number; e: number };
}

// the terrain check: a sample every 10 m, 3 m of slack for the 2 m terrain grid, and 30 m at each end, where the
// shell is near the ground anyway
const CLEAR_STEP = 10, CLEARANCE = 3, CLEAR_END = 30;

/**
 * How close the flight comes to the ground between the gun and the crater. `m` is the least height above the ground,
 * and `deg` the least angle of that gap as seen from the nearer end (gun or crater): about how much lower the shell
 * could fly before it touches the ground there. A shell is always low near both ends, so the angle, not the height,
 * says whether the terrain makes the shot hard. With `stopBelow` (m), it stops at the first sample lower than that.
 * `end` meters at each end do not count.
 */
function clearance(c: Candidate, C: Vec3, zGun: number, ground: GroundAt, stopBelow = -Infinity, end = CLEAR_END) {
  const th = c.th * D2R, dx = Math.sin(th), dy = Math.cos(th);
  const gx = C[0] + c.R * dx, gy = C[1] + c.R * dy;
  // the shell leaves from the ground at this candidate's own gun, not from the gun height of the last solve: a gun
  // elsewhere may stand higher, and would otherwise start under the ground and 'hit' it at once
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
  // one landing per flight, not one per candidate
  const landings = new Map<Flight, ReturnType<typeof landing>>();
  const candidate = (th: number, f: Flight): Candidate | null => {
    if (!landings.has(f)) landings.set(f, landing(f, dz));
    const l = landings.get(f);
    if (!l) return null;
    if (o.range && (l.R < o.range[0] || l.R > o.range[1])) return null;
    return { th: wrap360(th), f, R: l.R, T: l.T };
  };
  // a holder, because TypeScript does not see the closure assign it
  const found: { best: (Candidate & ReturnType<typeof evaluate>) | null } = { best: null };
  // the terrain check runs only for a candidate that would become the best, which keeps it cheap
  const tryOne = (th: number, f: Flight) => {
    const c = candidate(th, f);
    if (!c) return;
    const e = evaluate(c, clips, rays.length, o.C, o.zGun);
    if (found.best && e.cost >= found.best.cost) return;
    if (o.ground && !clears(c, o.C, o.zGun, o.ground)) return;
    found.best = { ...c, ...e };
  };

  // coarse: every elevation of the table for each direction, then a finer direction step near the best one. Near a
  // known fit, only its neighborhood.
  const NEAR = 5;
  const table = o.near ? flights(b, 0.5).filter((f) => Math.abs(f.e - o.near!.e) <= NEAR) : flights(b, 0.5);
  const [lo, hi, step] = o.near ? [o.near.th - NEAR, o.near.th + NEAR, 0.5] : [o.lo, o.hi, 1];
  for (let th = lo; th <= hi + 1e-9; th += step) for (const f of table) tryOne(th, f);
  if (!found.best) return null;
  const b0: Candidate = found.best;
  for (let th = b0.th - 1.5; th <= b0.th + 1.5; th += 0.1) for (const f of table) tryOne(th, f);

  // fine: alternate between direction and elevation, with fresh flights for the elevations
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
    th: r.th, e: r.f.e, R: r.R, T: r.T, rms: r.rms, missM: r.missM, excess: r.excess, shifts: r.shifts,
    // how hard the shot is: without the ends, where the ground under a gun on a slope or next to the crater says
    // nothing about the flight
    clearance: o.ground ? clearance(r, o.C, o.zGun, o.ground, -Infinity, Math.max(100, r.R * 0.1)) : undefined,
  };
}
