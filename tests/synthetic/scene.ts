/**
 * A synthetic scene with a known gun position (after poc/tests/gen_video.py). The observer stands near the crater.
 * `makeScene` gives the truth, and `frameAt` gives what a camera frame shows at time t. The unit tests,
 * the benchmark and the video that the e2e test records in the browser all use the same scene.
 */
import { BALLISTICS, at as flightAt, landing, simulate } from '../../src/lib/solver/ballistics.ts';
import { focalPx, project } from '../../src/lib/solver/camera.ts';
import { EYE_HEIGHT_M } from '../../src/lib/solver/sightings.ts';
import type { Pt, Vec3 } from '../../src/lib/solver/types.ts';

/** L52 and L81 fly with their drag (ballistics.ts). */
export type SceneWeapon = 'L52' | 'L81';

export interface SceneOptions {
  weapon?: SceneWeapon;
  W?: number; H?: number; fovDeg?: number; fps?: number;
  gun?: Vec3; dirDeg?: number; rangeM?: number; craterZ?: number;
  /** Ground height (m) at a point in meters. Absent means flat ground at height 0. */
  ground?: (x: number, y: number) => number;
  /** Seconds of video before the shot and after the impact. */
  lead?: number; tail?: number;
  /** The observer walks at this velocity (m/s, east and north); O is where they stand at the impact. */
  walk?: [number, number];
}

export interface Truth {
  weapon: SceneWeapon;
  W: number; H: number; fovDeg: number; fps: number; f: number;
  G: Vec3; C: Vec3; O: Vec3; dirDeg: number;
  camH: number; camP: number;
  /** The flight time, and the video seconds when the gun fires and when the shell lands. */
  T: number; fireTime: number; impactTime: number; duration: number;
  /** Two vertical edges, each as its bottom and top point in video pixels. */
  edges: [Pt, Pt][];
  craterPx: Pt;
  shellAt: (t: number) => Vec3 | null;
  /** Where the observer stands at time t (eye height): O at the impact, moving with the walk. */
  observerAt: (t: number) => Vec3;
}

/** Per weapon: range to the crater, how far from the crater the observer stands (to the side), and the camera pitch. */
const LAYOUT: Record<SceneWeapon, { range: number; side: number; pitch: number }> = {
  L52: { range: 2000, side: 40, pitch: 8 },
  L81: { range: 400, side: 30, pitch: 45 },
};

/** A flight from the gun: position along the ground and height at time t, and the flight time. */
interface Path { T: number; R: number; at: (t: number) => { s: number; z: number } }

/** The flight with drag that lands at range R, on the lowest arc that gets there. */
function dragPath(weapon: 'L52' | 'L81', R: number, dz: number): Path {
  const b = BALLISTICS[weapon];
  const range = (e: number) => landing(simulate(b, e), dz)?.R ?? -1;
  let lo = b.elevMinDeg, hi = NaN;
  for (let e = b.elevMinDeg; e <= b.elevMaxDeg; e += 0.1) {
    if ((range(e) - R) * (range(lo) - R) <= 0 && e > lo) { hi = e; break; }
    lo = e;
  }
  if (Number.isNaN(hi)) throw new Error(`${weapon} cannot reach ${R} m`);
  const rising = range(hi) > range(lo);
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if ((range(m) < R) === rising) lo = m; else hi = m; }
  const f = simulate(b, (lo + hi) / 2), l = landing(f, dz)!;
  return { T: l.T, R: l.R, at: (t) => { const p = flightAt(f, t); return { s: p.x, z: p.z }; } };
}

export function makeScene(o: SceneOptions = {}): Truth {
  const weapon = o.weapon ?? 'L52', layout = LAYOUT[weapon];
  const W = o.W ?? 1280, H = o.H ?? 720, fovDeg = o.fovDeg ?? 90, fps = o.fps ?? 60;
  const f = focalPx(W, H, fovDeg, 'h');
  // flat ground at height 0, as the solver assumes until terrain data exists
  const gz = (x: number, y: number) => o.ground?.(x, y) ?? 0;
  const G: Vec3 = o.gun ?? [3000, 4000, gz(3000, 4000)];
  const dirDeg = o.dirDeg ?? 60, th = (dirDeg * Math.PI) / 180, R0 = o.rangeM ?? layout.range;
  // the crater height comes from the planned crater point; the flight then lands within centimeters of it
  const craterZ = o.craterZ ?? gz(G[0] + R0 * Math.sin(th), G[1] + R0 * Math.cos(th));
  // dirDeg is the direction from the gun to the crater. The crater sits where the flight really lands.
  const path = dragPath(weapon, R0, craterZ - G[2]);
  const C: Vec3 = [G[0] + path.R * Math.sin(th), G[1] + path.R * Math.cos(th), craterZ];
  const T = path.T;

  const ox = C[0] + layout.side * Math.cos(th), oy = C[1] - layout.side * Math.sin(th);
  const O: Vec3 = [ox, oy, gz(ox, oy) + EYE_HEIGHT_M];
  const mid = [(G[0] + C[0]) / 2 - O[0], (G[1] + C[1]) / 2 - O[1]];
  const az = ((Math.atan2(mid[0], mid[1]) * 180) / Math.PI + 360) % 360;
  const camH = Math.round(az * 10) / 10 + 3, camP = layout.pitch;
  const proj = (P: Vec3) => project(P, O, W, H, f, camH, camP)!;

  const at = (hd: number, d: number, dz: number): Vec3 => {
    const r = (hd * Math.PI) / 180;
    return [O[0] + d * Math.sin(r), O[1] + d * Math.cos(r), O[2] + dz];
  };
  // two buildings, 60 m tall, standing on the ground
  const B = [at(camH - 35, 350, -EYE_HEIGHT_M), at(camH + 33, 300, -EYE_HEIGHT_M)];
  const edges = B.map((b) => [proj(b), proj([b[0], b[1], b[2] + 60])] as [Pt, Pt]);

  const fireTime = o.lead ?? 1;
  const tail = o.tail ?? 1;
  return {
    weapon, W, H, fovDeg, fps, f, G, C, O, dirDeg, camH, camP, T,
    fireTime, impactTime: fireTime + T, duration: fireTime + T + tail,
    edges, craterPx: proj(C),
    observerAt: (t) => [O[0] + (o.walk?.[0] ?? 0) * (t - fireTime - T), O[1] + (o.walk?.[1] ?? 0) * (t - fireTime - T), O[2]],
    shellAt: (t) => {
      const tt = t - fireTime;
      if (tt < 0 || tt > T) return null;
      const p = path.at(tt);
      return [G[0] + p.s * Math.sin(th), G[1] + p.s * Math.cos(th), G[2] + p.z];
    },
  };
}

export const shellPx = (tr: Truth, t: number): Pt | null => {
  const P = tr.shellAt(t);
  return P ? project(P, tr.observerAt(t), tr.W, tr.H, tr.f, tr.camH, tr.camP) : null;
};

/** What one frame shows: the shell, the edges and (after impact) the flash. */
export interface Frame { shell: Pt | null; flash: { at: Pt; r: number } | null }

export function frameAt(tr: Truth, t: number): Frame {
  const since = t - tr.impactTime;
  return {
    shell: shellPx(tr, t),
    flash: since >= 0 && since <= 0.5 ? { at: tr.craterPx, r: 10 + 80 * since } : null,
  };
}

/** Converts meters to game coordinates (1 unit is 100 m). */
export const game = (v: Vec3) => ({ x: v[0] / 100, y: v[1] / 100, z: v[2] });
