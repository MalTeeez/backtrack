/** Project data and UI state (runes). App.svelte saves both to IndexedDB (see persistence.ts). */
import type { ClipMeta, Id, ProjectData, Settings, Shot, Sighting, Weapon } from '../solver/types.ts';

export const WEAPONS: Record<Weapon, { name: string; min: number; max: number }> = {
  L52: { name: 'L52 cannon', min: 600, max: 2600 },
  L81: { name: 'L81 mortar', min: 80, max: 684 },
};

export const DEFAULT_SETTINGS: Settings = {
  fovDeg: 90, fovAxis: 'h',
  weapon: 'L52', rangeMinM: WEAPONS.L52.min, rangeMaxM: WEAPONS.L52.max, limitToRange: true,
  bufferS: 40, bitrateMbps: 10,
  markSigmaPx: 1, compassSigmaDeg: 0.5,
};

/** The frame rate the recorder asks the screen capture for. The clips themselves have no fixed frame rate. */
export const CAPTURE_FPS = 60;

export type Phase = 'record' | 'mark' | 'coordinates' | 'result';
export type Tool = 'shell' | 'edge' | null;

export const uid = (): Id => crypto.randomUUID().slice(0, 8);

export const newShot = (n: number): Shot => ({ id: uid(), name: `Shot ${n}`, crater: {}, impactTimeS: {} });

export function emptyProject(): ProjectData {
  return { settings: { ...DEFAULT_SETTINGS }, shots: [newShot(1)], sightings: [] };
}

export const project: ProjectData = $state(emptyProject());

export interface Ui {
  phase: Phase;
  shotId: Id | null;
  clipId: Id | null;
  sightingId: Id | null;
  tool: Tool;
  /** Shows the result next to the Mark and Coordinates phases. */
  split: boolean;
}
export const ui: Ui = $state({ phase: 'record', shotId: null, clipId: null, sightingId: null, tool: null, split: false });

/** Saved clips, newest first. The video blobs stay in IndexedDB (see persistence.ts). */
export const clips: { list: ClipMeta[] } = $state({ list: [] });

export const currentShot = (): Shot => project.shots.find((s) => s.id === ui.shotId) ?? project.shots[0];

/** The shape of older saved projects: landmarks, positions, heights, spray and a custom weapon. */
interface OldData {
  sightings?: (Sighting & { positionId?: Id; landmark?: unknown })[];
  shots?: (Shot & Record<string, unknown>)[];
  settings?: Partial<Settings> & { fps?: number };
}

/** Replaces the whole project, for example after loading. The UI state then points only at things that exist. */
export function loadProject(data: ProjectData, saved?: Partial<Ui>) {
  const old = data as unknown as OldData;
  const { fps: _fps, ...settings } = { ...DEFAULT_SETTINGS, ...old.settings };
  if (!(settings.weapon in WEAPONS)) settings.weapon = DEFAULT_SETTINGS.weapon;
  const sightings = (old.sightings ?? []).map(({ landmark: _l, positionId: _p, ...s }) => s);
  const shots = (old.shots ?? []).map((s) => ({
    id: s.id, name: s.name, crater: { x: s.crater?.x, y: s.crater?.y, from: s.crater?.from }, impactTimeS: s.impactTimeS ?? {},
    sourceDeg: s.sourceDeg, sourceTolDeg: s.sourceTolDeg, excluded: s.excluded,
  }));
  Object.assign(project, { settings, shots, sightings });
  if (!project.shots.length) project.shots.push(newShot(1));
  const { landmarkId: _, ...rest } = (saved ?? {}) as Partial<Ui> & { landmarkId?: unknown };
  Object.assign(ui, rest, { tool: null });
  if (!project.shots.some((s) => s.id === ui.shotId)) ui.shotId = project.shots[0].id;
}

/** These delete a thing and everything that points at it. */
export function deleteShot(id: Id) {
  project.sightings = project.sightings.filter((s) => s.shotId !== id);
  project.shots = project.shots.filter((s) => s.id !== id);
  if (!project.shots.length) project.shots.push(newShot(1));
  if (ui.shotId === id) ui.shotId = project.shots[0].id;
}
export function deleteSighting(id: Id) {
  project.sightings = project.sightings.filter((s) => s.id !== id);
  if (ui.sightingId === id) ui.sightingId = null;
}
/** Deletes a clip with its sightings and impact marks. */
export function forgetClip(id: Id) {
  project.sightings = project.sightings.filter((s) => s.clipId !== id);
  for (const s of project.shots) delete s.impactTimeS[id];
  clips.list = clips.list.filter((c) => c.id !== id);
  if (ui.clipId === id) ui.clipId = clips.list[0]?.id ?? null;
}

/**
 * How close two times must be to count as the same frame. Sightings store the presentation time of their frame, so
 * this only has to be smaller than half the shortest frame interval (4 ms is half a frame at 120 fps).
 */
const SAME_FRAME_S = 0.004;

/** The sighting of the current shot on the frame at time t of this clip, if there is one. */
export function sightingAt(clipId: Id, t: number): Sighting | undefined {
  return project.sightings.find((s) => s.shotId === currentShot().id && s.clipId === clipId && Math.abs(s.timeS - t) < SAME_FRAME_S);
}
/** True when both times belong to the same frame. */
export const sameFrame = (a: number, b: number) => Math.abs(a - b) < SAME_FRAME_S;
