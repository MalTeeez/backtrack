/** Turns a sighting into a camera and a ray, and gives the quality warnings of each sighting (plan sections 3 and 6). */
import { PITCH_SIGMA_MAX, azEl, centered, edgeReport, focalPx, rayWorld } from './camera.ts';
import { impactSigma, impactTime, sigmaOf, value } from './field.ts';
import type { Heights, Id, ProjectData, Pt, Ray, Shot, Sighting, Vec3, XY } from './types.ts';

/** One game unit is 100 m. */
export const GAME_UNIT_M = 100;

/**
 * The rays start at eye height above the crater, because the user stands near it. The solver then finds how far off
 * the crater the user stood (ballisticFit.ts).
 */
export const EYE_HEIGHT_M = 1.7;

/** How far off (+/- deg) a suspected heading may be, when the user gives no other value. */
export const SOURCE_TOL_DEG = 30;

/** Random errors for one Monte Carlo run. Without them, the solver uses the marks as they are. */
export interface Jitter {
  /** Pixels, one draw per coordinate, with the sigma of an automatic mark or the mark accuracy of the settings. */
  px: (sigma?: number) => number;
  /** Degrees, with the sigma of an automatic heading or the compass accuracy of the settings. */
  heading: (sigma?: number) => number;
  /** Degrees of an automatic pitch or roll, with its sigma. */
  angle: (sigma: number) => number;
  /** Seconds, the same for every sighting in a clip: somewhere in the impact interval of half width `half`. */
  impact: (clipId: Id, half: number) => number;
}

export interface Camera {
  h: number; p: number; r: number;
  /** Where the pitch comes from: the marked edges, the automatic value, the value the user typed, or an earlier sighting. */
  source: 'edges' | 'auto' | 'typed' | 'copied';
}

export type Aim =
  | { ok: false; error: string; warnings: string[] }
  | { ok: true; D: Vec3; az: number; el: number; cam: Camera; warnings: string[] };

export type SightingResult =
  | { ok: false; error: string; warnings: string[] }
  | { ok: true; ray: Ray; az: number; el: number; cam: Camera; warnings: string[] };

/** The crater in game units: the user's value (a complete rangefinder reading first), else a confident automatic one. */
export function craterGame(s: Pick<Shot, 'crater' | 'rangefinder'>): XY | null {
  const f = s.rangefinder;
  if (f) {
    if (f.x == null || f.y == null || f.headingDeg == null || f.distanceM == null) return null;
    const h = (f.headingDeg * Math.PI) / 180;
    return { x: f.x + (f.distanceM * Math.sin(h)) / GAME_UNIT_M, y: f.y + (f.distanceM * Math.cos(h)) / GAME_UNIT_M };
  }
  return value(s.crater) ?? null;
}

/** Where the user stood during the flight of a shot, in the clip of the shot (game units), or null. */
export const observerGame = (s: Pick<Shot, 'observer' | 'clipId'>): XY | null => (s.clipId ? value(s.observer[s.clipId]) ?? null : null);

/**
 * The point the rays of a shot start from (game units): the crater, or where the user stood when the crater is not
 * known. The solver then finds the crater from the end of the flight (automation plan section 11).
 */
export const anchorGame = (s: Shot): XY | null => craterGame(s) ?? observerGame(s);

/** A game point in meters, at a ground height. */
export const toMeters = (p: XY, ground = 0): Vec3 => [p.x * GAME_UNIT_M, p.y * GAME_UNIT_M, ground];

/**
 * Solves the sightings of a project. Each Monte Carlo run gets its own instance, so a copied camera
 * gets the same random errors as its source.
 */
export class SightingSolver {
  private cams = new Map<Id, { cam?: Camera; error?: string; warnings: string[] }>();
  private readonly shots = new Map<Id, Shot>();

  constructor(private readonly data: ProjectData, private readonly J?: Jitter, private readonly heights?: Heights) {
    for (const s of data.shots) this.shots.set(s.id, s);
  }

  /** The focal length of a sighting in pixels: a zoom of 4 makes it 4 times longer. */
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

  /** The pitch: typed by the user, from the marked edges, or automatic, in that order. */
  private pitch(s: Sighting, warnings: string[]): { p: number; source: Camera['source'] } | null {
    if (s.pitch.manual != null) return { p: s.pitch.manual, source: 'typed' };
    if (s.edges.length) {
      const rep = edgeReport(s.edges.map(([a, b]) => [this.jp(a), this.jp(b)] as [Pt, Pt]), s.frameW, s.frameH, this.f(s), this.data.settings.markSigmaPx);
      rep.edges.forEach((e, i) => {
        if (e.pitch == null) warnings.push(`Edge ${i + 1} cannot give a pitch. Mark it again.`);
        else if (e.offBy != null) warnings.push(`Edge ${i + 1} differs from the other edges by ${Math.abs(e.offBy).toFixed(1)} deg, more than its marks explain, so the pitch leaves it out. Check that it is vertical.`);
      });
      if (rep.pitch != null && rep.sigma > PITCH_SIGMA_MAX) {
        warnings.push(`The pitch from the edges is only accurate to +/-${rep.sigma.toFixed(1)} deg. A longer edge nearer the side of the frame might give a more exact result.`);
      }
      if (rep.pitch != null) return { p: rep.pitch, source: 'edges' };
    }
    const auto = value(s.pitch);
    return auto == null ? null : { p: auto + (this.J ? this.J.angle(sigmaOf(s.pitch) ?? 0) : 0), source: 'auto' };
  }

  private computeOwnCamera(s: Sighting): { cam?: Camera; error?: string; warnings: string[] } {
    const warnings: string[] = [];
    const pitch = this.pitch(s, warnings), heading = value(s.heading);
    if (pitch == null && heading == null) return { error: 'This sighting has no camera data. Mark a vertical edge and type the compass heading.', warnings };
    if (pitch == null) return { error: 'This sighting has no pitch. Mark a vertical edge.', warnings };
    if (heading == null) return { error: 'This sighting has no heading. Type the compass heading.', warnings };
    const r = (value(s.roll) ?? 0) + (this.J ? this.J.angle(sigmaOf(s.roll) ?? 0) : 0);
    const h = heading + (this.J ? this.J.heading(sigmaOf(s.heading)) : 0);
    return { cam: { h, p: pitch.p, r, source: pitch.source }, warnings };
  }

  /** The camera of an earlier sighting in the same clip. */
  private previousCamera(s: Sighting) {
    const earlier = this.data.sightings
      .filter((x) => x.clipId === s.clipId && x.timeS < s.timeS && !x.sameCameraAsPrevious)
      .sort((a, b) => b.timeS - a.timeS);
    for (const x of earlier) {
      const c = this.ownCamera(x);
      if (c.cam) return c.cam;
    }
    return null;
  }

  /** The camera and the direction to the shell, from the marks of the sighting alone. */
  aim(s: Sighting): Aim {
    let cam: Camera, warnings: string[] = [];
    if (s.sameCameraAsPrevious) {
      const prev = this.previousCamera(s);
      if (!prev) return { ok: false, error: 'No earlier sighting in this clip has a camera to copy.', warnings };
      cam = { ...prev, source: 'copied' };
    } else {
      const own = this.ownCamera(s);
      warnings = own.warnings;
      if (!own.cam) return { ok: false, error: own.error!, warnings };
      cam = own.cam;
    }
    const shell = value(s.shell);
    if (!shell) return { ok: false, error: s.shell.auto?.reason ? `Mark the shell (${s.shell.auto.reason}).` : 'Mark the shell.', warnings };
    const D = rayWorld(centered(this.jp(shell, sigmaOf(s.shell)), s.frameW, s.frameH), this.f(s), cam.h, cam.p, cam.r);
    const { az, el } = azEl(D);
    return { ok: true, D, az, el, cam, warnings };
  }

  /** The ray of a sighting: its aim, with the time before impact and the point it starts from. */
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
    if (!at) return { ok: false, error: 'The crater of this shot has no X and Y yet, and where you stood is not known either.', warnings };
    // ponytail: the user stands at the height of the crater; the terrain at the observer would be better on hills
    const C = toMeters(at, this.heights?.crater[shot!.id]);
    const sigma = (sigmaOf(s.shell) ?? this.data.settings.markSigmaPx) / this.f(s);
    return { ok: true, ray: { O: [C[0], C[1], C[2] + EYE_HEIGHT_M], D, tau, clip: s.clipId, sigma }, az, el, cam, warnings };
  }
}
