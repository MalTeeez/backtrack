/**
 * The weapon ballistics model gravity and quadratic drag, a = -k * |v| * v - g. The launch speeds come from the
 * WARDOGS wiki (wardogs.wikitactics.com). Each drag constant k makes the maximum range match the community firing
 * tables, and the flight times then agree with the published ones. The L52 at 2000 m flies 12.3 s low and 33 s high,
 * and the L81 at 400 m flies 17.4 s. Bulkhead did not publish these values, so they are community estimates.
 */

import type { Weapon } from './types.ts';

/** The weapons of the game and their range (m). */
export const WEAPONS: Record<Weapon, { name: string; min: number; max: number }> = {
  L52: { name: 'L52 cannon', min: 600, max: 2600 },
  L81: { name: 'L81 mortar', min: 80, max: 684 },
};

export const G = 9.8;

export interface Ballistics { v0: number; k: number; elevMinDeg: number; elevMaxDeg: number }

export const BALLISTICS = {
  L52: { v0: 300, k: 4.807e-4, elevMinDeg: -3, elevMaxDeg: 65 },
  L81: { v0: 96.6, k: 5.429e-4, elevMinDeg: 45, elevMaxDeg: 85 },
} satisfies Record<string, Ballistics>;

/** Seconds between two samples of a flight. */
export const DT = 0.01;

/** A flight from the origin at elevation `e` (deg). x is the horizontal distance, z the height, one sample per DT. */
export interface Flight { e: number; x: Float64Array; z: Float64Array }

/** Integrates a flight with RK4 until the shell is `floor` meters below the launch height, or for at most 120 s. */
export function simulate(b: Ballistics, eDeg: number, floor = -600): Flight {
  const n = Math.round(120 / DT);
  const xs = new Float64Array(n), zs = new Float64Array(n);
  const e = (eDeg * Math.PI) / 180;
  let x = 0, z = 0, vx = b.v0 * Math.cos(e), vz = b.v0 * Math.sin(e), i = 0;
  const ax = (u: number, w: number) => -b.k * Math.hypot(u, w) * u;
  const az = (u: number, w: number) => -G - b.k * Math.hypot(u, w) * w;
  for (; i < n; i++) {
    xs[i] = x; zs[i] = z;
    if (z < floor) { i++; break; }
    const k1x = ax(vx, vz), k1z = az(vx, vz);
    const k2x = ax(vx + (k1x * DT) / 2, vz + (k1z * DT) / 2), k2z = az(vx + (k1x * DT) / 2, vz + (k1z * DT) / 2);
    const k3x = ax(vx + (k2x * DT) / 2, vz + (k2z * DT) / 2), k3z = az(vx + (k2x * DT) / 2, vz + (k2z * DT) / 2);
    const k4x = ax(vx + k3x * DT, vz + k3z * DT), k4z = az(vx + k3x * DT, vz + k3z * DT);
    x += vx * DT + ((k1x + k2x + k3x) * DT * DT) / 6;
    z += vz * DT + ((k1z + k2z + k3z) * DT * DT) / 6;
    vx += ((k1x + 2 * k2x + 2 * k3x + k4x) * DT) / 6;
    vz += ((k1z + 2 * k2z + 2 * k3z + k4z) * DT) / 6;
  }
  return { e: eDeg, x: xs.subarray(0, i), z: zs.subarray(0, i) };
}

/** Where the flight comes down through height dz, as its range R and flight time T. Null if it never gets there. */
export function landing(f: Flight, dz: number): { R: number; T: number } | null {
  let top = 0;
  for (let i = 1; i < f.z.length; i++) if (f.z[i] > f.z[top]) top = i;
  if (f.z[top] < dz) return null;
  for (let i = Math.max(top, 1); i < f.z.length; i++) {
    if (f.z[i] <= dz) {
      const a = (f.z[i - 1] - dz) / (f.z[i - 1] - f.z[i]);
      return { R: f.x[i - 1] + a * (f.x[i] - f.x[i - 1]), T: (i - 1 + a) * DT };
    }
  }
  return null;
}

/** The horizontal distance and the height at time t after the launch (clamped to the flight). */
export function at(f: Flight, t: number): { x: number; z: number } {
  const u = Math.max(0, Math.min(f.x.length - 1.000001, t / DT));
  const i = Math.floor(u), a = u - i;
  return { x: f.x[i] + a * (f.x[i + 1] - f.x[i]), z: f.z[i] + a * (f.z[i + 1] - f.z[i]) };
}

/** The height of the flight at horizontal distance x. The horizontal distance only grows, so a binary search finds it. */
export function heightAt(f: Flight, x: number): number {
  let lo = 0, hi = f.x.length - 1;
  if (x <= 0) return f.z[0];
  if (x >= f.x[hi]) return f.z[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (f.x[m] <= x) lo = m; else hi = m; }
  const a = (x - f.x[lo]) / (f.x[hi] - f.x[lo]);
  return f.z[lo] + a * (f.z[hi] - f.z[lo]);
}

/** One flight per weapon and elevation (rounded to 0.001 deg), kept for later solves such as the Monte Carlo runs. */
const memo = new Map<string, Flight>();
export function flightAt(b: Ballistics, eDeg: number): Flight {
  const e = Math.round(eDeg * 1000) / 1000;
  const key = `${b.v0}:${b.k}:${e}`;
  let f = memo.get(key);
  if (!f) {
    if (memo.size > 3000) memo.clear(); // ponytail: plain size cap, an LRU if memory ever matters
    f = simulate(b, e);
    memo.set(key, f);
  }
  return f;
}

/** Flights over the whole elevation range in `step` deg, made once per weapon and step. */
const tables = new Map<string, Flight[]>();
export function flights(b: Ballistics, step: number): Flight[] {
  const key = `${b.v0}:${b.k}:${step}`;
  let list = tables.get(key);
  if (!list) {
    list = [];
    for (let e = b.elevMinDeg; e <= b.elevMaxDeg + 1e-9; e += step) list.push(simulate(b, e));
    tables.set(key, list);
  }
  return list;
}
