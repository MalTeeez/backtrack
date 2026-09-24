/** Project data and UI state (runes). App.svelte saves both to IndexedDB (see persistence.ts). */
import type { ClipMeta, Id, ProjectData, Settings, Shot, Sighting, Weapon } from '../solver/types.ts';
import { freeShot, oneClipPerShot } from '../capture/annotation.ts';
import { sameFrame } from '../video/frames.ts';

import { WEAPONS } from '../solver/ballistics.ts';
export { WEAPONS };

export const DEFAULT_SETTINGS: Settings = {
  fovDeg: 90, fovAxis: 'h',
  weapon: 'L52', rangeMinM: WEAPONS.L52.min, rangeMaxM: WEAPONS.L52.max, limitToRange: true,
  bufferS: 40, bitrateMbps: 25,
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
  /** Per clip, where the Mark phase left it. */
  clipViews: Record<Id, ClipView>;
  speed: number;
  magZoom: number;
  /** Sightings folded in the list. */
  folded: Record<Id, boolean>;
  /** The result map: its view (null follows the result) and its terrain layers. */
  resultView: MapView | null;
  layers: { steep: boolean; out: boolean; high: boolean };
  /** The map panels by shot (crater) or sighting (where the user stood): open or not, and their view. */
  mapOpen: Record<Id, boolean>;
  mapViews: Record<Id, MapView>;
}
type Span = { a: number; b: number };
export type MapView = { cx: number; cy: number; span: number };
/** The frame on screen, the visible part of the timeline, and the section playback repeats. */
export type ClipView = { t?: number; zoom?: Span; loop?: Span };
export const ui: Ui = $state({
  phase: 'record', shotId: null, clipId: null, sightingId: null, tool: null, split: false,
  clipViews: {}, speed: 1, magZoom: 8, folded: {}, resultView: null, layers: { steep: true, out: true, high: true }, mapOpen: {}, mapViews: {},
});
/** The view of a clip, made on first use. Not for use inside $derived, which may not change state. */
export const clipView = (id: Id): ClipView => (ui.clipViews[id] ??= {});

/** Saved clips, newest first. The video blobs stay in IndexedDB (see persistence.ts). */
export const clips: { list: ClipMeta[] } = $state({ list: [] });

export const currentShot = (): Shot => project.shots.find((s) => s.id === ui.shotId) ?? project.shots[0];

/** The shots of a clip. Without a clip, the new shots that no clip has taken yet. */
export const shotsOf = (clipId: Id | null): Shot[] => project.shots.filter((s) => (s.clipId ?? null) === clipId);

/** The project as the selected clip sees it: its shots and their sightings. The solver and the checks use it. */
export function clipData(): ProjectData {
  const ids = new Set(shotsOf(ui.clipId).map((s) => s.id));
  return {
    settings: project.settings,
    shots: project.shots.filter((s) => ids.has(s.id)),
    sightings: project.sightings.filter((s) => ids.has(s.shotId) && s.clipId === ui.clipId),
  };
}

/** Adds a shot to the selected clip, numbered within it, and selects it. */
export function addShot() {
  project.shots.push({ ...newShot(shotsOf(ui.clipId).length + 1), clipId: ui.clipId ?? undefined });
  ui.shotId = project.shots.at(-1)!.id;
}

/**
 * Keeps the selected shot in the selected clip: else the first shot of the clip, a new shot that no clip has taken
 * yet, or a new one.
 */
export function fixShot() {
  const mine = shotsOf(ui.clipId);
  if (mine.some((s) => s.id === ui.shotId)) return;
  const free = ui.clipId ? project.shots.find((s) => freeShot(project, s)) : undefined;
  if (mine.length) ui.shotId = mine[0].id;
  else if (free) { free.clipId = ui.clipId!; ui.shotId = free.id; }
  else addShot();
}

/** The shape of older saved projects: landmarks, positions, heights, spray and a custom weapon. */
interface OldData {
  sightings?: (Sighting & { positionId?: Id; landmark?: unknown })[];
  shots?: (Shot & Record<string, unknown>)[];
  settings?: Partial<Settings> & { fps?: number };
}

/**
 * Replaces the whole project, for example after loading. The caller then sets the clip list and calls fixShot, so the
 * UI state points only at things that exist.
 */
export function loadProject(data: ProjectData, saved?: Partial<Ui>) {
  const old = data as unknown as OldData;
  const { fps: _fps, ...settings } = { ...DEFAULT_SETTINGS, ...old.settings };
  if (!(settings.weapon in WEAPONS)) settings.weapon = DEFAULT_SETTINGS.weapon;
  const sightings = (old.sightings ?? []).map(({ landmark: _l, positionId: _p, ...s }) => s);
  const shots = (old.shots ?? []).map((s) => ({
    id: s.id, name: s.name, crater: { x: s.crater?.x, y: s.crater?.y, from: s.crater?.from }, impactTimeS: s.impactTimeS ?? {},
    sourceDeg: s.sourceDeg, sourceTolDeg: s.sourceTolDeg, excluded: s.excluded, clipId: s.clipId,
  }));
  Object.assign(project, { settings, shots, sightings });
  oneClipPerShot(project, { uid });
  const { landmarkId: _, ...rest } = (saved ?? {}) as Partial<Ui> & { landmarkId?: unknown };
  Object.assign(ui, rest, { tool: null });
}

/** These delete a thing and everything that points at it. */
export function deleteShot(id: Id) {
  project.sightings = project.sightings.filter((s) => s.shotId !== id);
  project.shots = project.shots.filter((s) => s.id !== id);
  delete ui.mapOpen[id];
  delete ui.mapViews[id];
  fixShot();
}
export function deleteSighting(id: Id) {
  project.sightings = project.sightings.filter((s) => s.id !== id);
  if (ui.sightingId === id) ui.sightingId = null;
  delete ui.folded[id];
  delete ui.mapOpen[id];
  delete ui.mapViews[id];
}
/** Deletes a clip with its sightings, impact marks and shots. */
export function forgetClip(id: Id) {
  project.sightings = project.sightings.filter((s) => s.clipId !== id);
  for (const s of project.shots) delete s.impactTimeS[id];
  project.shots = project.shots.filter((s) => s.clipId !== id);
  clips.list = clips.list.filter((c) => c.id !== id);
  if (ui.clipId === id) ui.clipId = clips.list[0]?.id ?? null;
  delete ui.clipViews[id];
  fixShot();
}

export { sameFrame };

/** The sighting of the current shot on the frame at time t of this clip, if there is one. */
export function sightingAt(clipId: Id, t: number): Sighting | undefined {
  return project.sightings.find((s) => s.shotId === currentShot().id && s.clipId === clipId && sameFrame(s.timeS, t));
}
