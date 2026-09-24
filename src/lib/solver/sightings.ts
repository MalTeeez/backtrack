/** Turns a sighting into a camera and a ray, and gives the quality warnings of each sighting (plan sections 3 and 6). */
import { PITCH_SIGMA_MAX, azEl, centered, edgeReport, focalPx, rayWorld } from './camera.ts';
import type { Heights, Id, ProjectData, Pt, Ray, Shot, Sighting, Vec3 } from './types.ts';

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
  px: () => number;      // pixels, one draw per coordinate
  heading: () => number; // degrees
  impact: (clipId: Id) => number; // seconds, the same for every sighting in a clip
}

export interface Camera { h: number; p: number; source: 'compass and edges' | 'copied' }

export type Aim =
  | { ok: false; error: string; warnings: string[] }
  | { ok: true; D: Vec3; az: number; el: number; cam: Camera; warnings: string[] };

export type SightingResult =
  | { ok: false; error: string; warnings: string[] }
  | { ok: true; ray: Ray; az: number; el: number; cam: Camera; warnings: string[] };

/** The crater in game units: its X and Y, or where a rangefinder puts it. Null while an input is missing. */
export function craterGame(s: Pick<Shot, 'crater'>): { x: number; y: number } | null {
  const f = s.crater.from;
  if (!f) return s.crater.x != null && s.crater.y != null ? { x: s.crater.x, y: s.crater.y } : null;
  if (f.x == null || f.y == null || f.headingDeg == null || f.distanceM == null) return null;
  const h = (f.headingDeg * Math.PI) / 180;
  return { x: f.x + (f.distanceM * Math.sin(h)) / GAME_UNIT_M, y: f.y + (f.distanceM * Math.cos(h)) / GAME_UNIT_M };
}

/** The crater in meters, on the ground (0 without terrain data). Null while an input is missing. */
export const craterXyz = (s: Shot, ground = 0): Vec3 | null => {
  const c = craterGame(s);
  return c ? [c.x * GAME_UNIT_M, c.y * GAME_UNIT_M, ground] : null;
};

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
  private f(s: Sighting) {
    const st = this.data.settings;
    return focalPx(s.frameW, s.frameH, st.fovDeg, st.fovAxis) * (s.zoom ?? 1);
  }
  private jp(p: Pt): Pt {
    return this.J ? { x: p.x + this.J.px(), y: p.y + this.J.px() } : p;
  }

  /** Gets the camera of a sighting from its own edges and compass heading. The run caches it. */
  ownCamera(s: Sighting) {
    const hit = this.cams.get(s.id);
    if (hit) return hit;
    const out = this.computeOwnCamera(s);
    this.cams.set(s.id, out);
    return out;
  }

  private computeOwnCamera(s: Sighting): { cam?: Camera; error?: string; warnings: string[] } {
    const f = this.f(s), sigPx = this.data.settings.markSigmaPx;
    const warnings: string[] = [];
    const rep = edgeReport(s.edges.map(([a, b]) => [this.jp(a), this.jp(b)] as [Pt, Pt]), s.frameW, s.frameH, f, sigPx);
    rep.edges.forEach((e, i) => {
      if (e.pitch == null) warnings.push(`Edge ${i + 1} cannot give a pitch. Mark it again.`);
      else if (e.offBy != null) warnings.push(`Edge ${i + 1} differs from the other edges by ${Math.abs(e.offBy).toFixed(1)} deg, more than its marks explain, so the pitch leaves it out. Check that it is vertical.`);
    });
    if (rep.pitch != null && rep.sigma > PITCH_SIGMA_MAX) {
      warnings.push(`The pitch from the edges is only accurate to +/-${rep.sigma.toFixed(1)} deg. A longer edge nearer the side of the frame might give a more exact result.`);
    }

    const heading = s.headingDeg;
    if (rep.pitch == null && heading == null) return { error: 'This sighting has no camera data. Mark a vertical edge and type the compass heading.', warnings };
    if (rep.pitch == null) return { error: 'This sighting has no pitch. Mark a vertical edge.', warnings };
    if (heading == null) return { error: 'This sighting has no heading. Type the compass heading.', warnings };
    return { cam: { h: heading + (this.J ? this.J.heading() : 0), p: rep.pitch, source: 'compass and edges' }, warnings };
  }

  /** Where the user stood: the position of the sighting, or of the one whose camera it copies. Null without one. */
  position(s: Sighting): { x: number; y: number } | null {
    let cur: Sighting | undefined = s;
    while (cur) {
      const p = cur.position;
      if (p?.x != null && p.y != null) return { x: p.x, y: p.y };
      if (!cur.sameCameraAsPrevious) return null;
      const t: number = cur.timeS, clip: Id = cur.clipId;
      cur = this.data.sightings.filter((x) => x.clipId === clip && x.timeS < t).sort((a, b) => b.timeS - a.timeS)[0];
    }
    return null;
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
    if (!s.shell) return { ok: false, error: 'Mark the shell.', warnings };
    const D = rayWorld(centered(this.jp(s.shell), s.frameW, s.frameH), this.f(s), cam.h, cam.p);
    const { az, el } = azEl(D);
    return { ok: true, D, az, el, cam, warnings };
  }

  /** The ray of a sighting: its aim, with the time before impact and the crater it starts from. */
  solve(s: Sighting): SightingResult {
    const a = this.aim(s);
    if (!a.ok) return a;
    const { D, az, el, cam, warnings } = a;
    const shot = this.shots.get(s.shotId);
    const T = shot?.impactTimeS[s.clipId];
    if (T == null) return { ok: false, error: 'This clip has no impact mark. Mark the frame where the shell lands.', warnings };
    const tau = T - s.timeS + (this.J ? this.J.impact(s.clipId) : 0);
    if (tau <= 0) return { ok: false, error: 'This sighting is at or after the impact.', warnings };
    const C = craterXyz(shot!, this.heights?.crater[shot!.id]);
    if (!C) return { ok: false, error: 'The crater of this shot has no X and Y yet.', warnings };
    // ponytail: the user stands at the height of the crater; the terrain at the position would be better on hills
    const at = this.position(s);
    const O: Vec3 = at ? [at.x * GAME_UNIT_M, at.y * GAME_UNIT_M, C[2] + EYE_HEIGHT_M] : [C[0], C[1], C[2] + EYE_HEIGHT_M];
    return { ok: true, ray: { O, D, tau, clip: s.clipId, fixed: !!at }, az, el, cam, warnings };
  }
}
