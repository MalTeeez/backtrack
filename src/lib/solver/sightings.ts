/** Turns a sighting into a camera and a ray, and gives the quality warnings of each sighting (plan sections 3 and 6). */
import { D2R, PITCH_SIGMA_MAX, azEl, centered, edgeReport, focalPx, rayWorld } from './camera.ts';
import { impactSigma, impactTime, sigmaOf, value } from './field.ts';
import type { Heights, Id, ProjectData, Pt, Ray, Shot, Sighting, Vec3, XY } from './types.ts';

/** One game unit is 100 m. */
export const GAME_UNIT_M = 100;

/**
 * The rays start at eye height above the crater, because the user stands near it. The solver then finds how far the
 * sighting position lies from the crater (ballisticFit.ts).
 */
export const EYE_HEIGHT_M = 1.7;

/** The error (deg) of a pitch the user typed. */
const TYPED_PITCH_SIGMA = 0.1;

/** How far off (+/- deg) a suspected heading may be, when the user gives no other value. */
export const SOURCE_TOL_DEG = 30;

/** Random errors for one Monte Carlo run. Without them, the solver uses the marks as they are. */
export interface Jitter {
  /** The error in pixels, with the sigma of an automatic mark or the mark accuracy of the settings. One draw per coordinate. */
  px: (sigma?: number) => number;
  /** The error in degrees, with the sigma of an automatic heading or the compass accuracy of the settings. One draw per group. */
  heading: (sigma?: number, group?: string) => number;
  /** The error in degrees of an automatic pitch or roll, with its sigma. One draw per group. */
  angle: (sigma: number, group?: string) => number;
  /** The error in seconds, the same for every sighting in a clip. It lies in the impact interval of half width `half`. */
  impact: (clipId: Id, half: number) => number;
  /** The error in meters east and north of a walk offset `tau` seconds before the impact (Sighting.walkM). */
  walk: (clipId: Id, tau: number) => [number, number];
}

export interface Camera {
  h: number; p: number; r: number;
  /** The angular error (deg) of the camera, from its heading and its pitch. */
  sigma: number;
  /** Where the pitch comes from: the marked edges, the automatic value, or the value the user typed. */
  source: 'edges' | 'auto' | 'typed';
}

export type Aim =
  | { ok: false; error: string; warnings: string[] }
  | { ok: true; D: Vec3; az: number; el: number; cam: Camera; warnings: string[] };

export type SightingResult =
  | { ok: false; error: string; warnings: string[] }
  | { ok: true; ray: Ray; az: number; el: number; cam: Camera; warnings: string[] };

/** The crater in game units, which is the user's value (a complete rangefinder reading first) or else a confident automatic one. */
export function craterGame(s: Pick<Shot, 'crater' | 'rangefinder'>): XY | null {
  const f = s.rangefinder;
  if (f) {
    if (f.x == null || f.y == null || f.headingDeg == null || f.distanceM == null) return null;
    const h = (f.headingDeg * Math.PI) / 180;
    return { x: f.x + (f.distanceM * Math.sin(h)) / GAME_UNIT_M, y: f.y + (f.distanceM * Math.cos(h)) / GAME_UNIT_M };
  }
  return value(s.crater) ?? null;
}

/** The sighting position during the flight of a shot, in the clip of the shot (game units), or null. */
export const observerGame = (s: Pick<Shot, 'observer' | 'clipId'>): XY | null => (s.clipId ? value(s.observer[s.clipId]) ?? null : null);

/**
 * The point the rays of a shot start from (game units). It is the crater, or the sighting position when the crater is
 * not known. The solver then finds the crater from the end of the flight (automation plan section 11).
 */
export const anchorGame = (s: Shot): XY | null => craterGame(s) ?? observerGame(s);

/** The height (m) of the crater, which is the terrain there plus the height of what the shell hit above it. */
export const craterZ = (s: Shot, h?: Heights) => (h?.crater[s.id] ?? 0) + (s.craterRaisedM ?? 0);
/** The height (m) of the sighting position in the clip of a shot. It is the terrain there plus what the user stood on. */
export const standZ = (s: Shot, h?: Heights) => (h?.observer?.[s.id] ?? h?.crater[s.id] ?? 0) + ((s.clipId ? value(s.raisedM?.[s.clipId]) : undefined) ?? 0);

/** The group of an automatic value the solver uses (its error is shared), per kind of value. */
const groupOf = (f: Sighting['heading'], kind: string) => (f.manual == null && f.auto?.group ? `${kind}:${f.auto.group}` : undefined);

/** A game point in meters, at a ground height. */
export const toMeters = (p: XY, ground = 0): Vec3 => [p.x * GAME_UNIT_M, p.y * GAME_UNIT_M, ground];

/** Solves the sightings of a project. Each Monte Carlo run gets its own instance with its own random errors. */
export class SightingSolver {
  private cams = new Map<Id, { cam?: Camera; error?: string; warnings: string[] }>();
  private readonly shots = new Map<Id, Shot>();

  constructor(private readonly data: ProjectData, private readonly J?: Jitter, private readonly heights?: Heights) {
    for (const s of data.shots) this.shots.set(s.id, s);
  }

  /** The focal length of a sighting in pixels. A zoom of 4 makes it 4 times longer. */
  f(s: Sighting) {
    const st = this.data.settings;
    return focalPx(s.frameW, s.frameH, st.fovDeg, st.fovAxis) * (s.zoom ?? 1);
  }
  private jp(p: Pt, sigma?: number): Pt {
    return this.J ? { x: p.x + this.J.px(sigma), y: p.y + this.J.px(sigma) } : p;
  }

  /** Gets the camera of a sighting from its own data. The run caches it. */
  ownCamera(s: Sighting) {
    const hit = this.cams.get(s.id);
    if (hit) return hit;
    const out = this.computeOwnCamera(s);
    this.cams.set(s.id, out);
    return out;
  }

  /** The pitch. The typed value comes first, then the one from the marked edges, then the automatic one. */
  private pitch(s: Sighting, warnings: string[]): { p: number; sigma: number; source: Camera['source'] } | null {
    if (s.pitch.manual != null) return { p: s.pitch.manual, sigma: TYPED_PITCH_SIGMA, source: 'typed' };
    if (s.edges.length) {
      const rep = edgeReport(s.edges.map(([a, b]) => [this.jp(a), this.jp(b)] as [Pt, Pt]), s.frameW, s.frameH, this.f(s), this.data.settings.markSigmaPx);
      rep.edges.forEach((e, i) => {
        if (e.pitch == null) warnings.push(`Edge ${i + 1} cannot give a pitch. Mark it again.`);
        else if (e.offBy != null) warnings.push(`Edge ${i + 1} differs from the other edges by ${Math.abs(e.offBy).toFixed(1)} deg, more than its marks explain, so the pitch leaves it out. Check that it is vertical.`);
      });
      if (rep.pitch != null && rep.sigma > PITCH_SIGMA_MAX) {
        warnings.push(`The pitch from the edges is only accurate to +/-${rep.sigma.toFixed(1)} deg. A longer edge nearer the side of the frame might give a more exact result.`);
      }
      if (rep.pitch != null) return { p: rep.pitch, sigma: rep.sigma, source: 'edges' };
    }
    const auto = value(s.pitch);
    return auto == null ? null : { p: auto + (this.J ? this.J.angle(sigmaOf(s.pitch) ?? 0, groupOf(s.pitch, 'p')) : 0), sigma: sigmaOf(s.pitch) ?? PITCH_SIGMA_MAX, source: 'auto' };
  }

  private computeOwnCamera(s: Sighting): { cam?: Camera; error?: string; warnings: string[] } {
    const warnings: string[] = [];
    const pitch = this.pitch(s, warnings), heading = value(s.heading);
    if (pitch == null && heading == null) return { error: 'This sighting has no camera data. Mark a vertical edge and type the compass heading.', warnings };
    if (pitch == null) return { error: 'This sighting has no pitch. Mark a vertical edge.', warnings };
    if (heading == null) return { error: 'This sighting has no heading. Type the compass heading.', warnings };
    const r = (value(s.roll) ?? 0) + (this.J ? this.J.angle(sigmaOf(s.roll) ?? 0, groupOf(s.roll, 'r')) : 0);
    const h = heading + (this.J ? this.J.heading(sigmaOf(s.heading), groupOf(s.heading, 'h')) : 0);
    const sh = sigmaOf(s.heading) ?? this.data.settings.compassSigmaDeg;
    return { cam: { h, p: pitch.p, r, sigma: Math.hypot(sh, pitch.sigma), source: pitch.source }, warnings };
  }

  /** The camera and the direction to the shell, from the marks of the sighting alone. */
  aim(s: Sighting): Aim {
    const own = this.ownCamera(s), warnings = own.warnings;
    if (!own.cam) return { ok: false, error: own.error!, warnings };
    const cam = own.cam;
    const shell = value(s.shell);
    if (!shell) return { ok: false, error: s.shell.auto?.reason ? `Mark the shell (${s.shell.auto.reason}).` : 'Mark the shell.', warnings };
    const D = rayWorld(centered(this.jp(shell, sigmaOf(s.shell)), s.frameW, s.frameH), this.f(s), cam.h, cam.p, cam.r);
    const { az, el } = azEl(D);
    return { ok: true, D, az, el, cam, warnings };
  }

  /** The ray of a sighting, which is its aim with the time before the impact and the point it starts from. */
  solve(s: Sighting): SightingResult {
    const a = this.aim(s);
    if (!a.ok) return a;
    const { D, az, el, cam, warnings } = a;
    const shot = this.shots.get(s.shotId);
    const I = value(shot?.impact[s.clipId]);
    if (I == null) return { ok: false, error: 'This clip has no impact mark. Mark the frame where the shell lands.', warnings };
    const tau = impactTime(I) - s.timeS + (this.J ? this.J.impact(s.clipId, impactSigma(I)) : 0);
    if (tau <= 0) return { ok: false, error: 'This sighting is at or after the impact.', warnings };
    const at = anchorGame(shot!);
    if (!at) return { ok: false, error: 'The crater of this shot has no X and Y yet, and the sighting position is not known either.', warnings };
    const C = toMeters(at, craterZ(shot!, this.heights));
    // The height of the sighting position at the impact, and on a walk, how much higher or lower the ground of this
    // frame is.
    const z = standZ(shot!, this.heights) + (this.heights?.walk?.[s.id] ?? 0);
    // The error of the mark and the camera. The error of the frame time comes later, with the speed of the shell
    // (result.ts).
    const sigma = Math.hypot((sigmaOf(s.shell) ?? this.data.settings.markSigmaPx) / this.f(s), cam.sigma * D2R);
    // If the user walks, the ray starts at the sighting position of this frame. The solver finds the sighting position
    // at the impact.
    let [wx, wy] = s.walkM ?? [0, 0];
    if (s.walkM && this.J) { const [ex, ey] = this.J.walk(s.clipId, tau); wx += ex; wy += ey; }
    return { ok: true, ray: { O: [C[0] + wx, C[1] + wy, z + EYE_HEIGHT_M], D, tau, clip: s.clipId, sighting: s.id, sigma }, az, el, cam, warnings };
  }
}
