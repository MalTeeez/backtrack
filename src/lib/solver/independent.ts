/**
 * The independent model (automation plan section 12.6, Appendix B) fits a straight flight with gravity over the last
 * part of the flight to the rays, without the weapon table. It gives the direction toward the gun, not the range,
 * because the rays fix mainly the ratio of distance and speed. It gives a second opinion on the direction of the
 * ballistic fit. Deterministic, without I/O.
 */
import { R2D, wrap360 } from './camera.ts';
import type { Ray, Vec3 } from './types.ts';

const G = 9.81;

/** The unknowns are the azimuth and elevation (rad) of the impact from the camera, its distance (m), and the velocity (m/s). */
type P = [number, number, number, number, number, number];

const dir = (az: number, el: number): Vec3 => [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];

/** The misses. The miss of a ray is the cross product of the unit vector to the modeled shell and the ray. */
function residuals(p: P, rays: { D: Vec3; tau: number }[]): number[] {
  const u = dir(p[0], p[1]), d = p[2], V = [p[3], p[4], p[5]];
  const out: number[] = [];
  for (const r of rays) {
    const P = [d * u[0] - V[0] * r.tau, d * u[1] - V[1] * r.tau, d * u[2] - V[2] * r.tau - 0.5 * G * r.tau * r.tau];
    const n = Math.hypot(P[0], P[1], P[2]) || 1, q = [P[0] / n, P[1] / n, P[2] / n];
    out.push(q[1] * r.D[2] - q[2] * r.D[1], q[2] * r.D[0] - q[0] * r.D[2], q[0] * r.D[1] - q[1] * r.D[0]);
  }
  return out;
}

/** Solves A x = b for a small symmetric positive system (Gaussian elimination). */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-15) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Levenberg-Marquardt with a numeric Jacobian. */
function fit(p0: P, rays: { D: Vec3; tau: number }[]): { p: P; cost: number } {
  let p = [...p0] as P, r = residuals(p, rays), cost = r.reduce((s, x) => s + x * x, 0), lambda = 1e-3;
  for (let it = 0; it < 200; it++) {
    const J = p.map((_, k) => {
      const h = Math.max(1e-6, Math.abs(p[k]) * 1e-6), q = [...p] as P;
      q[k] += h;
      return residuals(q, rays).map((x, i) => (x - r[i]) / h);
    });
    const A = p.map((_, a) => p.map((_, b) => J[a].reduce((s, x, i) => s + x * J[b][i], 0)));
    const g = p.map((_, a) => -J[a].reduce((s, x, i) => s + x * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const Ad = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
      const step = solve(Ad, g);
      if (!step) { lambda *= 10; continue; }
      const q = p.map((v, i) => v + step[i]) as P;
      q[2] = Math.max(1, q[2]);
      const rq = residuals(q, rays), cq = rq.reduce((s, x) => s + x * x, 0);
      if (cq < cost) { p = q; r = rq; lambda = Math.max(1e-9, lambda / 3); improved = cost - cq > 1e-14; cost = cq; break; }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { p, cost };
}

/**
 * The direction (deg, clockwise from north) from the impact toward the gun, which is the opposite of the horizontal
 * velocity at the impact. The fit starts from several distances (10, 30, 80 and 200 m) and keeps the best result. Null
 * for fewer than 4 rays.
 */
export function independentDirection(rays: Pick<Ray, 'D' | 'tau'>[]): { dirDeg: number; rmsDeg: number } | null {
  if (rays.length < 4) return null;
  const sorted = [...rays].sort((a, b) => a.tau - b.tau), last = sorted[0], first = sorted[sorted.length - 1];
  const az = Math.atan2(last.D[0], last.D[1]), el = Math.asin(Math.max(-1, Math.min(1, last.D[2])));
  let best: { p: P; cost: number } | null = null;
  for (const d of [10, 30, 80, 200]) {
    // the velocity from the two ends of the rays, both as far as the impact
    const dt = first.tau - last.tau || 1;
    const V0 = [0, 1, 2].map((k) => (d * (last.D[k] - first.D[k])) / dt);
    const r = fit([az, el, d, V0[0], V0[1], V0[2]], sorted);
    if (!best || r.cost < best.cost) best = r;
  }
  const p = best!.p;
  return { dirDeg: wrap360(Math.atan2(-p[3], -p[4]) * R2D), rmsDeg: Math.asin(Math.min(1, Math.sqrt(best!.cost / rays.length))) * R2D };
}
