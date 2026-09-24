/**
 * Turns the whole project into a result for each shot, with its accuracy, and the guns the shots point to (phase 4).
 * Shots that agree on a gun combine; shots that do not come from another gun.
 */
import { D2R, R2D, angleDiff, quadratic, wrap360 } from './camera.ts';
import { MC_RUNS, makeJitter, percentile, type Rng } from './montecarlo.ts';
import { GAME_UNIT_M, SOURCE_TOL_DEG, SightingSolver, anchorGame, craterGame, toMeters } from './sightings.ts';
import { BALLISTICS, WEAPONS } from './ballistics.ts';
import { costFloor, rayMisses } from './ballisticFit.ts';
import { confRatio, sigmaOf, value } from './field.ts';
import { motionFlags, motionShotWarning, shellSpeeds } from './motion.ts';
import { solveShot } from './solve.ts';
import { independentDirection } from './independent.ts';
import { intersectTracks, minCrossingAngle } from './tracks.ts';
import type { Detected, Field, Fit, Grid, GroundAt, Gun, Heights, Id, ProjectData, Ray, ShiftPrior, Shot, SolveOptions, Vec3, Weapon } from './types.ts';

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
  /** The crater the solve found from where the user stood (game units), with its error (m), when none was given. */
  crater?: { x: number; y: number; sigmaM: number };
  /** Two directions (deg) fit about equally well, so the suspected heading is required. */
  ambiguous?: { th: [number, number] };
  /** The direction (deg) of the independent model (section 12.6): a straight flight with gravity, without the weapon. */
  independent?: { dirDeg: number; rmsDeg: number };
  /** How far (m) the solved spot of the user lies from the minimap position (section 13), when there is one. */
  observerOffM?: number;
  /**
   * Each sighting against the fit (meters, like C): where the user was on its frame, the shell on the fitted flight
   * then, the seconds before the impact, and the miss (deg) along the path of the shell (signed) and across it.
   */
  sightings?: { id: Id; tau: number; O: Vec3; P: Vec3; along: number; cross: number }[];
  /** The frame time error (s) of the clip that the solve used, and whether it came from the marks. */
  timing?: { s: number; measured: boolean };
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
  /** The weapon the solve used, the field it comes from, and the RMS fit error (deg) of each weapon. */
  weapon: { use: Weapon; field: Field<Weapon>; rms: Record<Weapon, number | null> };
}

/**
 * The error (s) of a frame time, which moves a fast shell along its path in the image (section 12.5), when the marks
 * of a clip cannot tell it (frameTiming): between the entire screen and a window capture of the capture test.
 */
export const TIMESTAMP_SIGMA_S = 0.015;
/** The least and the largest frame time error (s) that frameTiming gives. */
const TIMING_MIN_S = 0.003, TIMING_MAX_S = 0.08;
/** How far (m) the minimap puts the user off where they really stood, for a position the user typed. */
export const OBSERVER_SIGMA_M = 10;
/** How far (m) a crater the user typed or measured may be off. */
export const CRATER_SIGMA_M = 1;
/** The independent model looks at the last part of the flight only (s): a straight flight with gravity. */
const INDEPENDENT_S = 1;
/** A weapon counts as found when the other weapon fits this many times worse (section 2.2). */
export const WEAPON_RATIO = 2;

/**
 * The rays of one shot, and how many sightings the solver skipped. Each ray gets the direction the shell moves in the
 * image there (from its neighbors), and the error of its frame time at that speed as its error along the path.
 */
function prepare(data: ProjectData, shot: Shot, solver: SightingSolver, speeds: Map<Id, number>, timing: Map<Id, number>): { rays: Ray[]; bad: number } {
  const list = data.sightings.filter((s) => s.shotId === shot.id && !s.excluded);
  const solved = list.flatMap((s) => { const r = solver.solve(s); return r.ok ? [{ s, ray: r.ray }] : []; });
  const rays = solved.map(({ s, ray }) => {
    const move = (speeds.get(s.id) ?? 0) * D2R * (timing.get(s.clipId) ?? TIMESTAMP_SIGMA_S);
    return { ...ray, sigmaAlong: Math.hypot(ray.sigma ?? 0, move) };
  });
  // the direction of motion at each ray: toward the next ray and from the one before, across the ray
  const byClip = new Map<Id, number[]>();
  solved.forEach(({ s }, k) => byClip.set(s.clipId, [...(byClip.get(s.clipId) ?? []), k]));
  for (const ks of byClip.values()) {
    ks.sort((a, b) => rays[b].tau - rays[a].tau); // in time order
    ks.forEach((k, j) => {
      const prev = rays[ks[Math.max(0, j - 1)]], next = rays[ks[Math.min(ks.length - 1, j + 1)]], D = rays[k].D;
      if (prev === next) return;
      const v = [next.D[0] - prev.D[0], next.D[1] - prev.D[1], next.D[2] - prev.D[2]];
      const d = v[0] * D[0] + v[1] * D[1] + v[2] * D[2], t = [v[0] - d * D[0], v[1] - d * D[1], v[2] - d * D[2]];
      const n = Math.hypot(t[0], t[1], t[2]);
      if (n > 1e-9) rays[k].along = [t[0] / n, t[1] / n, t[2] / n];
    });
  }
  return { rays, bad: list.length - rays.length };
}

/**
 * The error of the frame times of each clip (s), from the shell itself: it moves smoothly, so the jitter of its marks
 * along its path against a local fit of their neighbors, over its speed, is the error of the frame times. Marks of a
 * slow shell say little (their own error takes over), so only those moving faster than 3 deg/s count. The capture test
 * measured 3 to 11 ms for a capture of the entire screen and about 27 ms for a window (capture-test-plan.md).
 */
export function frameTiming(data: ProjectData, solver: SightingSolver): Map<Id, number> {
  const out = new Map<Id, number>(), errs = new Map<Id, number[]>();
  for (const shot of data.shots) {
    const byClip = new Map<Id, { t: number; D: Vec3 }[]>();
    for (const s of data.sightings) {
      if (s.shotId !== shot.id || s.excluded) continue;
      const a = solver.aim(s);
      if (a.ok) byClip.set(s.clipId, [...(byClip.get(s.clipId) ?? []), { t: s.timeS, D: a.D }]);
    }
    for (const [clip, pts] of byClip) {
      pts.sort((a, b) => a.t - b.t);
      // the position along the path: the angle walked from the first mark (deg)
      const pos = [0];
      for (let k = 1; k < pts.length; k++) {
        const u = pts[k - 1].D, v = pts[k].D;
        pos.push(pos[k - 1] + Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) * R2D);
      }
      for (let k = 3; k < pts.length - 3; k++) {
        const nb = [k - 3, k - 2, k - 1, k + 1, k + 2, k + 3], t0 = pts[k].t;
        const fit = quadratic(nb.map((j) => pts[j].t - t0), nb.map((j) => pos[j]));
        if (!fit || fit[1] < 3) continue;
        (errs.get(clip) ?? errs.set(clip, []).get(clip)!).push((pos[k] - fit[0]) / fit[1]);
      }
    }
  }
  for (const [clip, e] of errs) {
    if (e.length < 5) continue;
    const med = [...e].sort((a, b) => a - b)[e.length >> 1], mad = e.map((x) => Math.abs(x - med)).sort((a, b) => a - b)[e.length >> 1];
    out.set(clip, Math.min(TIMING_MAX_S, Math.max(TIMING_MIN_S, 1.4826 * mad)));
  }
  return out;
}

/**
 * The angular speed of the shell (deg/s) at each sighting: of the step to it, or for the first sighting of a run, of
 * the step from it.
 */
function speedsAt(data: ProjectData, solver: SightingSolver): Map<Id, number> {
  const to = shellSpeeds(data, solver), out = new Map(to);
  const byTime = [...data.sightings].sort((a, b) => a.timeS - b.timeS);
  for (const s of byTime) {
    if (out.has(s.id)) continue;
    const next = byTime.find((x) => x.shotId === s.shotId && x.clipId === s.clipId && x.timeS > s.timeS && to.has(x.id));
    if (next) out.set(s.id, to.get(next.id)!);
  }
  return out;
}

/** The weapon ballistics and range a solve uses. */
function options(data: ProjectData, shot: Shot, weapon: Weapon, C: Vec3, heights?: Heights, ground?: GroundAt): SolveOptions {
  const st = data.settings, manual = st.weapon === weapon;
  return {
    center: shot.sourceDeg ?? null,
    tol: shot.sourceTolDeg ?? SOURCE_TOL_DEG,
    zGun: heights?.gun[shot.id] ?? C[2], // without terrain data, the gun stands as high as the crater
    // the range of the settings belongs to the weapon the user picked; a weapon the solver tries has its own
    rmin: manual ? st.rangeMinM : WEAPONS[weapon].min, rmax: manual ? st.rangeMaxM : WEAPONS[weapon].max, useRange: st.limitToRange,
    ballistics: BALLISTICS[weapon],
    ground,
  };
}

/** A shot the solver can place: its anchor (crater, or where the user stood), and where the user stood as a prior. */
interface Setup {
  C: Vec3;
  /** The crater is not known: the rays start where the user stood, and the solve finds the crater. */
  findCrater: boolean;
  /** Where the minimap puts the user, as a shift from the crater (m). */
  prior?: ShiftPrior;
}

function setup(shot: Shot, heights?: Heights): Setup | null {
  const at = anchorGame(shot);
  if (!at || !shot.clipId) return null;
  const C = toMeters(at, heights?.crater[shot.id]);
  const crater = craterGame(shot), obs = shot.observer[shot.clipId];
  const O = value(obs);
  if (!crater || !O) return { C, findCrater: !crater };
  // both known: the minimap position pulls the solved spot of the user, with the errors of both
  const sObs = (sigmaOf(obs) ?? OBSERVER_SIGMA_M / GAME_UNIT_M) * GAME_UNIT_M;
  const sCrater = shot.rangefinder ? Math.hypot(CRATER_SIGMA_M, (shot.rangefinder.distanceM ?? 0) * 0.005) : (sigmaOf(shot.crater) ?? CRATER_SIGMA_M / GAME_UNIT_M) * GAME_UNIT_M;
  return { C, findCrater: false, prior: { s: [(O.x - crater.x) * GAME_UNIT_M, (O.y - crater.y) * GAME_UNIT_M], sigma: Math.hypot(sObs, sCrater) } };
}

/** Solves the shots of a project with one weapon, without Monte Carlo runs: the RMS fit error over all shots. */
function weaponError(data: ProjectData, weapon: Weapon, heights?: Heights, ground?: GroundAt): number | null {
  const solver = new SightingSolver(data, undefined, heights), speeds = speedsAt(data, solver), timing = frameTiming(data, solver);
  let ss = 0, n = 0;
  for (const shot of data.shots) {
    const su = !shot.excluded && setup(shot, heights);
    if (!su) continue;
    const { rays } = prepare(data, shot, solver, speeds, timing);
    const sol = solveShot(rays, su.C, { ...options(data, shot, weapon, su.C, heights, ground), priors: su.prior && { [shot.clipId!]: su.prior } });
    if (sol.error !== undefined) continue;
    ss += sol.fit.rms ** 2 * sol.n; n += sol.n;
  }
  return n ? Math.sqrt(ss / n) : null;
}

/**
 * The weapon of the project (section 12.4): each weapon table solves the shots, and the one that fits clearly better
 * is the automatic weapon. The user's pick wins.
 */
function pickWeapon(data: ProjectData, heights?: Heights, ground?: GroundAt): ProjectResult['weapon'] {
  const rms = Object.fromEntries((Object.keys(WEAPONS) as Weapon[]).map((w) => [w, weaponError(data, w, heights, ground)])) as Record<Weapon, number | null>;
  const ranked = (Object.keys(rms) as Weapon[]).filter((w) => rms[w] != null).sort((a, b) => rms[a]! - rms[b]!);
  const [best, next] = ranked;
  // a fit error of a few hundredths of a degree is noise: the ratio counts from there
  const ratio = best && next ? Math.max(rms[next]!, 0.02) / Math.max(rms[best]!, 0.02) : 1;
  const auto: Detected<Weapon> = best
    ? { value: best, conf: next ? confRatio(ratio, WEAPON_RATIO) : 0, ...(next && ratio < WEAPON_RATIO ? { reason: `${best} fits only ${ratio.toFixed(1)} times better than ${next}` } : {}) }
    : { conf: 0, reason: 'no shot can be solved yet' };
  const f: Field<Weapon> = { manual: data.settings.weapon, auto };
  return { use: value(f) ?? best ?? 'L52', field: f, rms };
}

/**
 * A flight whose gap to the ground, seen from the nearer end, is smaller than this angle (deg) makes the shot hard to
 * hit: an elevation error of that size runs it into the ground.
 */
const HARD_CLEARANCE_DEG = 0.3;
/** Two directions fit about equally well when the cost of the second is less than this many times the best one. */
const AMBIGUOUS = 2;

export function solveProject(data: ProjectData, rng: Rng = Math.random, runs = MC_RUNS, heights?: Heights, ground?: GroundAt): ProjectResult {
  const exact = new SightingSolver(data, undefined, heights);
  const jittered = Array.from({ length: runs }, () => new SightingSolver(data, makeJitter(data.settings, rng), heights));
  const shots: ShotResult[] = [];
  const jumps = motionFlags(data, exact);
  const speeds = speedsAt(data, exact), timing = frameTiming(data, exact);
  const weapon = pickWeapon(data, heights, ground);

  for (const shot of data.shots) {
    const count = data.sightings.filter((s) => s.shotId === shot.id).length;
    if (!count) continue;
    const r: ShotResult = { shotId: shot.id, name: shot.name, mc: [], observers: [], notes: [] };
    shots.push(r);
    if (shot.excluded) { r.excluded = true; continue; }
    const su = setup(shot, heights);
    if (!su) { r.error = 'Enter the crater X and Y in Coordinates, or where you stood.'; continue; }
    const clip = shot.clipId!;
    const prep = prepare(data, shot, exact, speeds, timing);
    if (prep.bad) r.notes.push(`The solver skipped ${prep.bad} incomplete sighting(s).`);

    const opt: SolveOptions = { ...options(data, shot, weapon.use, su.C, heights, ground), priors: su.prior && { [clip]: su.prior } };
    if (opt.center != null) r.source = { deg: opt.center, tol: opt.tol };
    const sol = solveShot(prep.rays, su.C, opt);
    if (sol.error !== undefined) { r.error = sol.error; continue; }
    // without a crater the rays start where the user stood: the crater is that spot minus the shift the fit found,
    // and the whole solution moves with it
    const move = (s: [number, number]): [number, number] => (su.findCrater ? [-s[0], -s[1]] : [0, 0]);
    const [mx, my] = move(sol.fit.shifts[clip]);
    const C: Vec3 = [su.C[0] + mx, su.C[1] + my, su.C[2]];
    r.C = C;
    if (heights) r.ground = { crater: C[2], gun: opt.zGun };
    Object.assign(r, { fit: sol.fit, gun: { ...sol.gun, x: sol.gun.x + mx, y: sol.gun.y + my }, n: sol.n });
    const zObs = heights?.observer?.[shot.id] ?? su.C[2];
    r.observers = Object.values(sol.fit.shifts).map(([dx, dy]): Vec3 => [C[0] + dx, C[1] + dy, zObs]);
    const at = (p: Vec3): Vec3 => [p[0] + mx, p[1] + my, p[2]];
    r.sightings = rayMisses(opt.ballistics, sol.fit, prep.rays, su.C, opt.zGun).map((m, k) => (
      { id: prep.rays[k].sighting!, tau: prep.rays[k].tau, O: at(m.O), P: at(m.P), along: +m.along.toFixed(4), cross: +m.cross.toFixed(4) }));
    r.timing = { s: timing.get(clip) ?? TIMESTAMP_SIGMA_S, measured: timing.has(clip) };

    const shifts: [number, number][] = [];
    for (const J of jittered) {
      const m = solveShot(prepare(data, shot, J, speeds, timing).rays, su.C, { ...opt, near: { th: sol.fit.th, e: sol.fit.e } });
      if (m.error !== undefined) continue;
      const [jx, jy] = move(m.fit.shifts[clip]);
      r.mc.push({ x: m.gun.x + jx, y: m.gun.y + jy, th: m.fit.th });
      shifts.push(m.fit.shifts[clip]);
    }
    if (r.mc.length >= 10) {
      r.err90 = percentile(r.mc.map((q) => Math.hypot(q.x - r.gun!.x, q.y - r.gun!.y)), 0.9);
      const dt = r.mc.map((q) => angleDiff(q.th, sol.fit.th));
      r.dirRange = [wrap360(sol.fit.th + Math.min(0, percentile(dt, 0.05))), wrap360(sol.fit.th + Math.max(0, percentile(dt, 0.95)))];
    } else {
      r.notes.push('Too few Monte Carlo runs gave a result, so the accuracy is unknown. Treat this result as rough.');
    }
    if (su.findCrater) {
      // the spread of the shift, and the error of the minimap position the crater hangs on
      const [sx, sy] = sol.fit.shifts[clip], spread = shifts.length >= 10 ? Math.sqrt(shifts.reduce((a, [x, y]) => a + (x - sx) ** 2 + (y - sy) ** 2, 0) / shifts.length) : 0;
      const sObs = (sigmaOf(shot.observer[clip]) ?? OBSERVER_SIGMA_M / GAME_UNIT_M) * GAME_UNIT_M;
      r.crater = { x: C[0] / GAME_UNIT_M, y: C[1] / GAME_UNIT_M, sigmaM: Math.hypot(spread, sObs) };
    }
    // the second opinion on the direction: the last second of the flight, or the 6 rays nearest the impact
    const late = [...prep.rays].sort((a, b) => a.tau - b.tau);
    r.independent = independentDirection(late.filter((x, k) => x.tau <= INDEPENDENT_S || k < 6)) ?? undefined;
    if (su.prior) {
      // the minimap position against where the rays alone put the user (sections 10.3 and 13): the fit with the
      // prior is pulled toward it, so it would hide a disagreement
      const free = solveShot(prep.rays, su.C, { ...opt, priors: undefined, near: { th: sol.fit.th, e: sol.fit.e } });
      const [sx, sy] = free.error === undefined ? free.fit.shifts[clip] : sol.fit.shifts[clip], d = Math.hypot(sx - su.prior.s[0], sy - su.prior.s[1]);
      r.observerOffM = d;
      if (d > 3 * su.prior.sigma && d > OBSERVER_SIGMA_M) r.notes.push(`The sightings put you ${d.toFixed(0)} m from where the minimap and the crater put you. Check the crater and the impact time.`);
    }

    // two directions that fit about equally well: the user must say which (section 12.3)
    const second = sol.fit.second;
    if (opt.center == null && second && second.cost < AMBIGUOUS * Math.max(second.best, costFloor(sol.n))) {
      r.ambiguous = { th: [sol.fit.th, second.th] };
      r.notes.push(`Two directions fit the sightings about equally well: ${sol.fit.th.toFixed(0)} and ${second.th.toFixed(0)} deg. Give the suspected heading in Coordinates.`);
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

  return { shots, guns: groupGuns(shots), weapon };
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
