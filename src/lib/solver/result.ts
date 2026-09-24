/**
 * Turns the whole project into a result for each shot, with its accuracy, and the guns the shots point to (phase 4).
 * Shots that agree on a gun combine; shots that do not come from another gun.
 */
import { angleDiff, wrap360 } from './camera.ts';
import { MC_RUNS, makeJitter, percentile, type Rng } from './montecarlo.ts';
import { SOURCE_TOL_DEG, SightingSolver, craterXyz } from './sightings.ts';
import { BALLISTICS } from './ballistics.ts';
import { motionFlags, motionShotWarning } from './motion.ts';
import { solveShot } from './solve.ts';
import { intersectTracks, minCrossingAngle } from './tracks.ts';
import type { Fit, Grid, GroundAt, Gun, Heights, Id, ProjectData, Ray, Shot, SolveOptions, Vec3 } from './types.ts';

export interface ShotResult {
  shotId: Id;
  name: string;
  /** The user left the shot out of the calculation. */
  excluded?: boolean;
  error?: string;
  C?: Vec3;
  fit?: Fit;
  gun?: Gun | null;
  n?: number;
  /** Monte Carlo gun positions (meters). `steep` marks ground too steep for a gun (the worker sets it). */
  mc: { x: number; y: number; th: number; steep?: boolean }[];
  /** The slope (deg) of the ground around the possible gun positions, from the terrain (the worker sets it). */
  slope?: Grid;
  /** 90th percentile distance of the Monte Carlo guns from the result (m). */
  err90?: number;
  /** Direction range from the crater (deg), as [from, to]. */
  dirRange?: [number, number];
  /** Where the user stood in each clip, as the solver estimates it (meters). */
  observers: Vec3[];
  notes: string[];
  /** The suspected heading (deg) and its tolerance that the solve used, if the shot has one. */
  source?: { deg: number; tol: number };
  /** The ground heights the solve used, when they came from terrain data. */
  ground?: { crater: number; gun: number };
}

/** The gun from all shots: combined by the accuracy of each shot, or where the tracks cross without one. */
/**
 * One gun: the shots that agree on it, combined. `single` is a gun of one shot, `combined` weighs several shots by
 * their Monte Carlo spread, and `tracks` crosses their tracks when there are no Monte Carlo runs.
 */
export interface GunGroup {
  x: number; y: number; err90?: number; shotIds: Id[]; method: 'single' | 'combined' | 'tracks';
  /** The smallest angle between the tracks of the shots (deg), for more than one shot. */
  angle?: number;
}

export interface ProjectResult {
  shots: ShotResult[];
  /** The guns, in the order of their first shot. More than one when the shots do not agree on one gun. */
  guns: GunGroup[];
  /** Which ground the heights came from, for the user. The worker sets it. */
  ground?: string;
  /** Where the guns can hit, from the terrain: 1 low arc, 2 only the high arc, 3 nothing. The worker sets it. */
  safe?: { grid: Grid; guns: { x: number; y: number }[] };
}

/** The rays of one shot, and how many sightings the solver skipped. */
function prepare(data: ProjectData, shot: Shot, solver: SightingSolver): { rays: Ray[]; bad: number } {
  const list = data.sightings.filter((s) => s.shotId === shot.id && !s.excluded);
  const rays = list.map((s) => solver.solve(s)).flatMap((r) => (r.ok ? [r.ray] : []));
  return { rays, bad: list.length - rays.length };
}

function options(data: ProjectData, shot: Shot, C: Vec3, heights?: Heights, ground?: GroundAt): SolveOptions {
  const st = data.settings;
  return {
    center: shot.sourceDeg ?? null,
    tol: shot.sourceTolDeg ?? SOURCE_TOL_DEG,
    zGun: heights?.gun[shot.id] ?? C[2], // without terrain data, the gun stands as high as the crater
    rmin: st.rangeMinM, rmax: st.rangeMaxM, useRange: st.limitToRange,
    ballistics: BALLISTICS[st.weapon],
    ground,
  };
}

/**
 * A flight whose gap to the ground, seen from the nearer end, is smaller than this angle (deg) makes the shot hard to
 * hit: an elevation error of that size runs it into the ground.
 */
const HARD_CLEARANCE_DEG = 0.3;

export function solveProject(data: ProjectData, rng: Rng = Math.random, runs = MC_RUNS, heights?: Heights, ground?: GroundAt): ProjectResult {
  const exact = new SightingSolver(data, undefined, heights);
  const jittered = Array.from({ length: runs }, () => new SightingSolver(data, makeJitter(data.settings, rng), heights));
  const shots: ShotResult[] = [];
  const jumps = motionFlags(data, exact);

  for (const shot of data.shots) {
    const count = data.sightings.filter((s) => s.shotId === shot.id).length;
    if (!count) continue;
    const r: ShotResult = { shotId: shot.id, name: shot.name, mc: [], observers: [], notes: [] };
    shots.push(r);
    if (shot.excluded) { r.excluded = true; continue; }
    const C = craterXyz(shot, heights?.crater[shot.id]);
    if (!C) { r.error = 'Enter the crater X and Y in Coordinates.'; continue; }
    r.C = C;
    const prep = prepare(data, shot, exact);
    if (prep.bad) r.notes.push(`The solver skipped ${prep.bad} incomplete sighting(s).`);

    const opt = options(data, shot, C, heights, ground);
    if (opt.center != null) r.source = { deg: opt.center, tol: opt.tol };
    if (heights) r.ground = { crater: C[2], gun: opt.zGun };
    const sol = solveShot(prep.rays, C, opt);
    if (sol.error !== undefined) { r.error = sol.error; continue; }
    Object.assign(r, { fit: sol.fit, gun: sol.gun, n: sol.n });
    // the estimated spots near the crater, and the positions from the minimap
    const known = new Map(prep.rays.filter((x) => x.fixed).map((x) => [`${x.O[0]},${x.O[1]}`, [x.O[0], x.O[1], C[2]] as Vec3]));
    r.observers = [...Object.values(sol.fit.shifts).map(([dx, dy]): Vec3 => [C[0] + dx, C[1] + dy, C[2]]), ...known.values()];

    for (const J of jittered) {
      const m = solveShot(prepare(data, shot, J).rays, C, { ...opt, near: { th: sol.fit.th, e: sol.fit.e } });
      if (m.error === undefined) r.mc.push({ x: m.gun.x, y: m.gun.y, th: m.fit.th });
    }
    if (r.mc.length >= 10) {
      r.err90 = percentile(r.mc.map((q) => Math.hypot(q.x - sol.gun.x, q.y - sol.gun.y)), 0.9);
      const dt = r.mc.map((q) => angleDiff(q.th, sol.fit.th));
      r.dirRange = [wrap360(sol.fit.th + Math.min(0, percentile(dt, 0.05))), wrap360(sol.fit.th + Math.max(0, percentile(dt, 0.95)))];
    } else {
      r.notes.push('Too few Monte Carlo runs gave a result, so the accuracy is unknown. Treat this result as rough.');
    }

    // the terrain only earns a note when it makes the shot impossible or hard
    if (sol.fit.ignoresTerrain) r.notes.push('No flight that fits the sightings clears the terrain between gun and crater, so this shot looks impossible. The result ignores the terrain.');
    else if (sol.fit.clearance && sol.fit.clearance.deg < HARD_CLEARANCE_DEG) {
      const c = sol.fit.clearance;
      r.notes.push(`${(c.atM / 1000).toFixed(1)} km from the gun, the flight passes only ${c.deg.toFixed(2)} deg over the terrain, so this shot is hard to make. A shell that flies that little lower hits the ground there.`);
    }
    const own = jumps.filter((f) => f.shotId === shot.id);
    if (own.length) r.notes.push(motionShotWarning(shot.name, own));
    if (sol.rangeRequested && !sol.rangeApplied) r.notes.push('No result is inside the weapon range. This result ignores the range limit.');
    // a fit on the edge of the suspected heading means the sightings pull outside it
    if (opt.center != null && Math.abs(angleDiff(sol.fit.th, opt.center)) > opt.tol - 0.5)
      r.notes.push(`The direction ${sol.fit.th.toFixed(1)} deg sits on the edge of the suspected heading ${opt.center} +/- ${opt.tol} deg, so the sightings point outside it. Check the suspected heading, the compass headings and the marks.`);
    if (sol.fit.excess > 0.5) r.notes.push('The fit error is high. Check the FOV, the headings and the marks.');
  }

  return { shots, guns: groupGuns(shots) };
}

// Two gun estimates agree when their difference lies within 6 standard deviations of their combined Monte Carlo
// spread. The Monte Carlo runs draw a new compass error for each sighting, so they miss an error that one shot shares
// (a misread compass), and a tighter limit (3, the 99 percent ellipse) split one gun in half of the synthetic tests.
// 6 kept three shots of one gun together and split a second gun 1.5 km away in every test. Without Monte Carlo
// runs, within a fixed distance.
const AGREE_SIGMA = 6, AGREE_M = 300;

/**
 * Groups the solved shots into guns. Each shot joins the gun it agrees with best, or starts a new one. Within a gun,
 * each estimate counts with the inverse of its Monte Carlo covariance: a shot pins the gun well across its track and
 * less well along it, so shots from different directions fix each other, and shots from one direction still add
 * their ranges. Without Monte Carlo runs, a gun of several shots is where their tracks cross.
 */
function groupGuns(shots: ShotResult[]): GunGroup[] {
  const solved = shots.filter((r) => r.fit && r.C && r.gun);
  const withMc = solved.every((r) => r.mc.length >= 10);
  const cov = new Map(solved.map((r) => [r, withMc ? covariance(r.mc, r.gun!) : ([1, 0, 1] as Sym)]));
  const groups: ShotResult[][] = [];
  for (const r of solved) {
    let best: ShotResult[] | null = null, bestD = Infinity;
    for (const g of groups) {
      const c = combine(g, cov);
      const dx = r.gun!.x - c.x, dy = r.gun!.y - c.y;
      const d = withMc ? mahalanobis(dx, dy, add(cov.get(r)!, c.cov)) : Math.hypot(dx, dy);
      if (d < (withMc ? AGREE_SIGMA : AGREE_M) && d < bestD) { best = g; bestD = d; }
    }
    if (best) best.push(r);
    else groups.push([r]);
  }
  return groups.map((g) => {
    const c = combine(g, cov);
    const out: GunGroup = { x: c.x, y: c.y, shotIds: g.map((r) => r.shotId), method: g.length === 1 ? 'single' : withMc ? 'combined' : 'tracks' };
    if (g.length === 1) return { ...out, err90: g[0].err90 };
    out.angle = minCrossingAngle(g.map((r) => r.fit!.th));
    if (!withMc) {
      const X = intersectTracks(g.map((r) => ({ x: r.C![0], y: r.C![1], th: r.fit!.th })));
      return X ? { ...out, ...X } : out;
    }
    // the accuracy: the same combination of each Monte Carlo run
    const n = Math.min(...g.map((r) => r.mc.length)), W = g.map((r) => inverse(cov.get(r)!)), d: number[] = [];
    for (let k = 0; k < n; k++) {
      const q = fuse(g.map((r) => r.mc[k]), W);
      if (q) d.push(Math.hypot(q.x - c.x, q.y - c.y));
    }
    return { ...out, err90: d.length >= 10 ? percentile(d, 0.9) : undefined };
  });
}

/** The combined gun of a group and its covariance. */
function combine(g: ShotResult[], cov: Map<ShotResult, Sym>): { x: number; y: number; cov: Sym } {
  if (g.length === 1) return { ...g[0].gun!, cov: cov.get(g[0])! };
  const W = g.map((r) => inverse(cov.get(r)!));
  const X = fuse(g.map((r) => r.gun!), W) ?? g[0].gun!;
  return { x: X.x, y: X.y, cov: inverse(W.reduce(add)) };
}

const add = (a: Sym, b: Sym): Sym => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** The distance of (dx, dy) in standard deviations of the covariance. */
function mahalanobis(dx: number, dy: number, c: Sym) {
  const [a, b, d] = inverse(c);
  return Math.sqrt(a * dx * dx + 2 * b * dx * dy + d * dy * dy);
}

type Sym = [number, number, number]; // xx, xy, yy

/** The spread of Monte Carlo guns around the gun (m^2), with a floor of 1 m so a perfect shot does not take over. */
function covariance(pts: { x: number; y: number }[], c: { x: number; y: number }): Sym {
  let xx = 0, xy = 0, yy = 0;
  for (const p of pts) { const dx = p.x - c.x, dy = p.y - c.y; xx += dx * dx; xy += dx * dy; yy += dy * dy; }
  return [xx / pts.length + 1, xy / pts.length, yy / pts.length + 1];
}
function inverse([a, b, d]: Sym): Sym {
  const det = a * d - b * b;
  return [d / det, -b / det, a / det];
}
/** The weighted mean of points, each with a 2x2 weight. */
export function fuse(pts: { x: number; y: number }[], W: Sym[]) {
  let a = 0, b = 0, d = 0, u = 0, v = 0;
  pts.forEach((p, i) => {
    const [wa, wb, wd] = W[i];
    a += wa; b += wb; d += wd;
    u += wa * p.x + wb * p.y; v += wb * p.x + wd * p.y;
  });
  const det = a * d - b * b;
  return Math.abs(det) < 1e-18 ? null : { x: (u * d - b * v) / det, y: (a * v - b * u) / det };
}
