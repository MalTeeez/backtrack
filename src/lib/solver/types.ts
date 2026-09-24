/** Project data (plan section 5) and solver types. The module has data types only, without DOM or Svelte code. */

export type Id = string;
/** A point in video pixels, with the origin at the top left. */
export interface Pt { x: number; y: number }
/** A point in world meters. X points east, Y north and Z up. */
export type Vec3 = [number, number, number];

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
  weapon: Weapon; rangeMinM: number; rangeMaxM: number; limitToRange: boolean;
  /** The map the clips come from. Absent means no map imagery. */
  map?: MapId;
  bufferS: number; bitrateMbps: number;
  markSigmaPx: number; compassSigmaDeg: number;
}

export interface Shot {
  id: Id; name: string;
  /**
   * The crater in game units. With `from`, a rangefinder measured it instead: from where the user stood then (game
   * units), at a compass heading (deg) and a distance (m), and x and y do not count.
   */
  crater: { x?: number; y?: number; from?: { x?: number; y?: number; headingDeg?: number; distanceM?: number } };
  /** The suspected compass heading (deg) from the crater toward the gun, and how far off (+/- deg) it may be. */
  sourceDeg?: number;
  sourceTolDeg?: number;
  /** Left out of the calculation, to test what it changes. */
  excluded?: boolean;
  impactTimeS: Record<Id, number>; // clipId -> seconds
  /** The clip the shot belongs to (one clip for now). None only for a new shot while no clip has taken it. */
  clipId?: Id;
}

export interface Sighting {
  id: Id; shotId: Id; clipId: Id; timeS: number;
  frameW: number; frameH: number;
  shell?: Pt;
  edges: [Pt, Pt][];
  headingDeg?: number;
  /** The zoom of binoculars or a scope on this frame: the field of view is the game FOV divided by it. 1 without. */
  zoom?: number;
  /**
   * Where the user stood on this frame, from the minimap (game units). Without it, the solver estimates the spot near
   * the crater. A sighting with the same camera as the previous one also has its position.
   */
  position?: { x?: number; y?: number };
  sameCameraAsPrevious: boolean;
  /** Left out of the calculation, to test what it changes. */
  excluded?: boolean;
}

/** Everything the solver needs about a project. */
export interface ProjectData {
  settings: Settings;
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
}

/**
 * One line of sight to the shell: its origin (above the crater), its unit direction, the seconds before impact, and
 * its clip. The solver finds where the user stood in each clip.
 */
export interface Ray {
  O: Vec3; D: Vec3; tau: number; clip: Id;
  /** The origin is where the user stood (from the minimap), so the solver does not move it. */
  fixed?: boolean;
}

/**
 * A fit with the weapon ballistics: direction th, launch elevation e (deg), range R (m), flight time T (s), and the
 * ground shift (m) of the observer from the crater in each clip.
 */
export interface Fit {
  th: number; e: number; R: number; T: number; rms: number; shifts: Record<Id, [number, number]>;
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
}

export type ShotSolution =
  | { error: string }
  | { error?: undefined; fit: Fit; gun: Gun; rangeApplied: boolean; rangeRequested: boolean; n: number };
