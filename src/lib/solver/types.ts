/** Project data (plan section 5) and solver types. The module has data types only, without DOM or Svelte code. */

export type Id = string;
/** A point in video pixels, with the origin at the top left. */
export interface Pt { x: number; y: number }
/** A point in world meters. X points east, Y north and Z up. */
export type Vec3 = [number, number, number];
/** A point on the map in game units (1 unit is 100 m). */
export interface XY { x: number; y: number }

/**
 * What a detector found for a value (automation plan section 2): the value, its standard deviation in the unit of the
 * value, and a confidence from 0 to 1. Below REQUIRED_BELOW (field.ts) the value does not count, and `reason` says why.
 */
export interface Detected<T> {
  value?: T; sigma?: number; conf: number; reason?: string;
  /** Values of one group share their error: the camera of the frames of one section comes from one fit. */
  group?: string;
}
/** A value Backtrack can detect and the user can override. The user's value always wins. */
export interface Field<T> { manual?: T; auto?: Detected<T> }

/** The impact lies between the last clean frame `a` and the first frame with a change near the crater `b` (s). */
export interface Impact { a: number; b: number }

export interface Clip {
  id: Id; name: string; source: 'buffer' | 'upload';
  blob: Blob; durationS: number; width: number; height: number; createdAt: number;
  /** Presentation time of every frame, sorted (prepareClip.ts). Absent on clips saved before it existed. */
  frames?: number[];
}
/** A clip without its video and its frame list, with the size of its video (bytes). The rest of the app passes this form around. */
export type ClipMeta = Omit<Clip, 'blob' | 'frames'> & { bytes?: number };

export type Weapon = 'L52' | 'L81';
/** A WARDOGS map with downloaded imagery (tools/fetch-map-data.ts). */
export type MapId = 'bakurani' | 'ozeti' | 'zestafona';

export interface Settings {
  fovDeg: number; fovAxis: 'h' | 'v';
  /**
   * The weapon the user picked, with its range limits. Absent: the solver tries every weapon and takes the one that
   * fits clearly better (automation plan section 12.4), each with its own range.
   */
  weapon?: Weapon; rangeMinM: number; rangeMaxM: number; limitToRange: boolean;
  bufferS: number; bitrateMbps: number;
  markSigmaPx: number; compassSigmaDeg: number;
}

/** What the project knows about a clip besides its marks. */
export interface ClipData {
  /** The map the clip comes from: its image under the maps, and its terrain for the solver. */
  map: Field<MapId>;
  /** The sections the detection ran on (automation plan section 8.1). */
  sections?: Section[];
}

/**
 * A part of a clip where a shell flies, and what the detection found in it (src/lib/vision/pipeline.ts). The
 * rotations of its frames are the stabilization, kept so the stabilized view and a new run need not repeat it.
 */
export interface Section {
  id: Id; shotId: Id;
  /** The section (s), and when the detection ran and how long it took (ms). */
  a: number; b: number; ranAt: number; ms: number;
  /** The time of each part of the run (ms), for the speed work (src/lib/vision/profile.ts). */
  profile?: Record<string, number>;
  width: number; height: number;
  /** The reference frame (s), and every decoded frame: rotation (b_frame = R b_ref, row-major), inliers, fit (px). */
  ref: number;
  frames: { t: number; R: number[] | null; ok: boolean; inliers: number; fitPx: number }[];
  /** The camera of the reference frame (deg). The user can override it for the whole section. */
  heading: Field<number>; pitch: Field<number>; roll: Field<number>;
  /**
   * The shell marks: in the frame (px as the app counts them, pixel i spans i to i + 1) and in the reference camera
   * (px as the vision code counts them, pixel centers on whole numbers), with their detection score.
   */
  marks: { t: number; x: number; y: number; rx: number; ry: number; score: number }[];
  /** The vertical lines of the pitch, in the reference camera (px), for the overlay. */
  lines: [number, number, number, number][];
  impact: Detected<Impact> & { at?: XY };
  /** The minimap: the map, where the user stood, and the scale (m per minimap pixel at 2160p). */
  minimap?: { map: Detected<MapId>; at: Detected<XY>; mpp: number };
  /**
   * Where the user was (game units) on frames of the section up to the impact, smoothed, when they walked: each frame
   * matched on its own. Missing when the user stood still (moved less than a few meters).
   */
  walk?: { t: number; x: number; y: number }[];
  /** Frames of the section without a sighting, and why. */
  dropped: { t: number; reason: string }[];
  /** What the user should know: too few sightings, none near the impact, a gap. */
  notes: string[];
}

/** A rangefinder reading: where the user stood (game units), a compass heading (deg) and a distance (m). */
export interface Rangefinder { x?: number; y?: number; headingDeg?: number; distanceM?: number }

export interface Shot {
  id: Id; name: string;
  /** The crater in game units. A complete rangefinder reading gives the user's value instead of `crater.manual`. */
  crater: Field<XY>;
  rangefinder?: Rangefinder;
  /** The suspected compass heading (deg) from the crater toward the gun, and how far off (+/- deg) it may be. */
  sourceDeg?: number;
  sourceTolDeg?: number;
  /** Left out of the calculation, to test what it changes. */
  excluded?: boolean;
  /** The impact in each clip (clipId). */
  impact: Record<Id, Field<Impact>>;
  /**
   * Where the user stood during the flight in each clip (clipId), from the minimap. The solver takes it with an
   * uncertainty; without it, the solver finds the spot from the crater.
   */
  observer: Record<Id, Field<XY>>;
  /** The clip the shot belongs to (one clip for now). None only for a new shot while no clip has taken it. */
  clipId?: Id;
}

export interface Sighting {
  id: Id; shotId: Id; clipId: Id; timeS: number;
  frameW: number; frameH: number;
  shell: Field<Pt>;
  /** Vertical edges the user marked. They give the pitch in place of the automatic one. */
  edges: [Pt, Pt][];
  /** The camera (deg): compass heading, pitch (up positive) and roll. Without a roll the camera is level. */
  heading: Field<number>;
  pitch: Field<number>;
  roll: Field<number>;
  /** The zoom of binoculars or a scope on this frame: the field of view is the game FOV divided by it. 1 without. */
  zoom?: number;
  /**
   * Where the user stood on this frame against where they stood at the impact (m, east and north), from the path of
   * the minimap: a user who walks. Without it the user stood still during the flight.
   */
  walkM?: [number, number];
  /** Left out of the calculation, to test what it changes. */
  excluded?: boolean;
}

/** Everything the solver needs about a project. */
export interface ProjectData {
  settings: Settings;
  /** By clip id. */
  clips: Record<Id, ClipData>;
  shots: Shot[];
  sightings: Sighting[];
}

/**
 * Ground heights (m) from terrain data (src/lib/terrain/). A missing key means flat ground at height 0. Only
 * differences matter, because the terrain heights share one unknown datum.
 */
export interface Heights {
  crater: Record<Id, number>; // shotId
  gun: Record<Id, number>; // shotId
  /** The ground where the user stood (shotId); the height of the crater when missing. */
  observer?: Record<Id, number>;
}

/**
 * One line of sight to the shell: its origin (above the crater), its unit direction, the seconds before impact, and
 * its clip. The solver finds where the user stood in each clip. `sigma` is the angular error (rad) of the ray: its
 * mark, and the error of its frame time at the speed the shell moves across the image (section 12.5).
 */
export interface Ray {
  O: Vec3; D: Vec3; tau: number; clip: Id;
  /** The sighting of the ray. */
  sighting?: Id;
  /** The angular error (rad) across the path of the shell: the mark and the camera. */
  sigma?: number;
  /**
   * The direction the shell moves in the image at this ray (unit, across the ray), and the angular error (rad) along
   * it: the mark, and the error of the frame time at the speed of the shell (section 12.5). A frame time only moves a
   * mark along the path, so a fast mark keeps what it says across the path.
   */
  along?: Vec3; sigmaAlong?: number;
}

/**
 * Where the user stood in a clip, as a shift (m) from the crater that the solver pulls the fit toward, and its
 * standard deviation (m).
 */
export interface ShiftPrior { s: [number, number]; sigma: number }

/**
 * A fit with the weapon ballistics: direction th, launch elevation e (deg), range R (m), flight time T (s), and the
 * ground shift (m) of the observer from the crater in each clip.
 */
export interface Fit {
  th: number; e: number; R: number; T: number; rms: number; shifts: Record<Id, [number, number]>;
  /** The robust cost of the fit, and the second-best minimum over direction of the coarse search (section 12.3). */
  cost: number;
  second?: { th: number; cost: number; best: number };
  /** The RMS miss of the rays (m), and the RMS of their angle beyond what a miss of 10 m explains (deg). */
  missM: number; excess: number;
  /**
   * With terrain: how close the flight comes to the ground. `deg` is the least angle of the gap as seen from the nearer
   * end, `atM` where that is (m from the gun), and `m` the least height above the ground.
   */
  clearance?: { m: number; deg: number; atM: number };
  /** No flight that fits the sightings clears the terrain, so this fit ignores it. */
  ignoresTerrain?: boolean;
}

/** The ground height (m) at a point in meters, or null without terrain data there. */
export type GroundAt = (x: number, y: number) => number | null;

/** A raster over the map in meters: west edge x0, north edge y0, square cells, rows from the north. */
export interface Grid { x0: number; y0: number; cell: number; w: number; h: number; data: Uint8Array }

export interface Gun { range: number; x: number; y: number; launchEl: number; tof: number }

export interface SolveOptions {
  /** Searches only center +/- tol (degrees). Null searches all directions. */
  center: number | null;
  tol: number;
  zGun: number;
  rmin: number;
  rmax: number;
  useRange: boolean;
  ballistics: { v0: number; k: number; elevMinDeg: number; elevMaxDeg: number };
  /** The terrain, when known: flights that run into it do not count. */
  ground?: GroundAt;
  /** A known fit to search around (the Monte Carlo runs), instead of every direction and elevation. */
  near?: { th: number; e: number };
  /** Where the minimap puts the user in each clip, as a shift from the crater. */
  priors?: Record<Id, ShiftPrior>;
}

export type ShotSolution =
  | { error: string }
  | { error?: undefined; fit: Fit; gun: Gun; rangeApplied: boolean; rangeRequested: boolean; n: number };
