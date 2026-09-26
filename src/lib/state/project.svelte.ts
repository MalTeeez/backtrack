/** Project data and UI state (runes). App.svelte saves both to IndexedDB (see persistence.ts). */
import type { Layout } from '../dock/layout.ts';
import type { ClipData, ClipMeta, Id, MapId, ProjectData, Settings, Shot, Sighting } from '../solver/types.ts';
import { freeShot, oneClipPerShot, shotFlow } from '../capture/annotation.ts';
import { sameFrame } from '../video/frames.ts';
import { value } from '../solver/field.ts';

import { WEAPONS } from '../solver/ballistics.ts';
export { WEAPONS };

export const DEFAULT_SETTINGS: Settings = {
  fovDeg: 90, fovAxis: 'h',
  rangeMinM: WEAPONS.L52.min, rangeMaxM: WEAPONS.L52.max, limitToRange: true,
  bufferS: 40, bitrateMbps: 25,
  markSigmaPx: 1, compassSigmaDeg: 0.5,
};

/** The frame rate the recorder asks the screen capture for. The clips themselves have no fixed frame rate. */
export const CAPTURE_FPS = 60;

export type Phase = 'record' | 'setup' | 'review' | 'mark' | 'coordinates' | 'result';
export type Tool = 'shell' | 'edge' | null;

export const uid = (): Id => crypto.randomUUID().slice(0, 8);

export const newShot = (n: number): Shot => ({ id: uid(), name: `Shot ${n}`, crater: {}, impact: {}, observer: {} });

/** A new sighting on a frame, with every field empty. */
export const newSighting = (s: Pick<Sighting, 'shotId' | 'clipId' | 'timeS' | 'frameW' | 'frameH'>): Sighting =>
  ({ id: uid(), ...s, shell: {}, edges: [], heading: {}, pitch: {}, roll: {} });

/**
 * The version of the saved project. The data of another version does not load, because Backtrack is still in
 * development and keeps no old formats (automation plan section 3).
 */
export const DATA_VERSION = 2;

export function emptyProject(): ProjectData {
  return { settings: { ...DEFAULT_SETTINGS }, clips: {}, shots: [newShot(1)], sightings: [] };
}

export const project: ProjectData = $state(emptyProject());

export interface Ui {
  phase: Phase;
  shotId: Id | null;
  clipId: Id | null;
  /** The clips picked together in the clip list. Setup offers them as one batch, for both flows. */
  clipIds: Id[];
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
  /** The view of the result map (null follows the result) and its terrain layers. */
  resultView: MapView | null;
  layers: { steep: boolean; out: boolean; high: boolean; sightings: boolean };
  /** Whether each map panel is open, and its view, by shot (crater) or by sighting (sighting position). */
  mapOpen: Record<Id, boolean>;
  mapViews: Record<Id, MapView>;
  /** A map panel that shows another map than its clip, by panel (automation plan section 4). */
  mapShown: Record<Id, MapId>;
  /** Clips whose map prompt the user closed without a map. */
  mapAsked: Record<Id, boolean>;
  /** The Mark phase shows the video, the stabilized view of the detection, or both (automation plan section 5.4). */
  view: 'video' | 'stab' | 'both';
  /** The video shows what the detection used and found on each frame. */
  cv: boolean;
  /** The window layout of each page that has one, with its attached and floating windows (src/lib/dock/). */
  docks: Record<string, Layout>;
  /** The view of the sign-off list of Review. It holds the filter, the order, the threshold of the button (percent) and the folded sections. */
  signoffView: { filter: 'all' | 'open' | 'done'; sort: 'time' | 'type' | 'conf'; reverse: boolean; threshold: number; folded: Record<string, boolean> };
}
type Span = { a: number; b: number };
export type MapView = { cx: number; cy: number; span: number };
/** The frame on screen, the visible part of the timeline, and the section playback repeats. */
export type ClipView = { t?: number; zoom?: Span; loop?: Span };
export const ui: Ui = $state({
  phase: 'record', shotId: null, clipId: null, clipIds: [], sightingId: null, tool: null, split: false,
  clipViews: {}, speed: 1, magZoom: 8, folded: {}, resultView: null, layers: { steep: true, out: true, high: true, sightings: true }, mapOpen: {}, mapViews: {},
  mapShown: {}, mapAsked: {}, view: 'video', cv: true, docks: {},
  signoffView: { filter: 'open', sort: 'time', reverse: false, threshold: 90, folded: {} },
});
/** The view of a clip, made on first use. Not for use inside $derived, which may not change state. */
export const clipView = (id: Id): ClipView => { ui.clipViews[id] ??= {}; return ui.clipViews[id]; };

/** Saved clips, newest first. The video blobs stay in IndexedDB (see persistence.ts). */
export const clips: { list: ClipMeta[] } = $state({ list: [] });

export const currentShot = (): Shot => project.shots.find((s) => s.id === ui.shotId) ?? project.shots[0];

/**
 * The clips the pages work on together. They are the clips picked in the clip list when the selected clip is one of
 * them, or else the selected clip alone.
 */
export function batchClips(): Id[] {
  const id = ui.clipId;
  if (!id) return [];
  return ui.clipIds.includes(id) ? ui.clipIds.filter((x) => clips.list.some((c) => c.id === x)) : [id];
}
/** The flow a shot of the project belongs to (shotFlow). */
export const flowOf = (s: Shot) => shotFlow(project, s);
/** Whether the flow of its clip shows a shot. A clip whose flow is not picked yet shows every shot, and so does each flow a shot that holds nothing yet. */
export function inFlow(s: Shot): boolean {
  const mode = s.clipId ? project.clips[s.clipId]?.mode : undefined, flow = flowOf(s);
  return !mode || !flow || !!s.shared || flow === mode;
}
/** The shots of a clip in the flow of the clip. Without a clip, the new shots that no clip has taken yet. */
export const shotsOf = (clipId: Id | null): Shot[] => project.shots.filter((s) => (s.clipId ?? null) === clipId && inFlow(s));

/** What the project knows about a clip, made on first use. Not for use inside $derived, which may not change state. */
export const clipInfo = (id: Id): ClipData => { project.clips[id] ??= { map: {} }; return project.clips[id]; };

/** The map of a clip, which is the user's pick or else the one the minimap search is sure of. */
export const clipMap = (id: Id | null | undefined): MapId | undefined => (id ? value(project.clips[id]?.map) : undefined);

/** The project as the selected clip sees it, with its shots and their sightings. The solver and the checks use it. */
export function clipData(): ProjectData {
  const ids = new Set(shotsOf(ui.clipId).map((s) => s.id));
  return {
    settings: project.settings,
    clips: ui.clipId && project.clips[ui.clipId] ? { [ui.clipId]: project.clips[ui.clipId] } : {},
    shots: project.shots.filter((s) => ids.has(s.id)),
    sightings: project.sightings.filter((s) => ids.has(s.shotId) && s.clipId === ui.clipId),
  };
}

/** Adds a shot to the selected clip, numbered within it, and selects it. */
/** Adds a shot to the selected clip and selects it. It takes no arguments, so it can be a click handler. */
export const addShot = () => addShotTo(ui.clipId);
/** Adds a shot to a clip and selects it. */
export function addShotTo(clipId: Id | null) {
  const flow = clipId ? project.clips[clipId]?.mode : undefined;
  project.shots.push({ ...newShot(shotsOf(clipId).length + 1), clipId: clipId ?? undefined, ...(flow ? { flow } : {}) });
  ui.shotId = project.shots.at(-1)!.id;
}

/**
 * Keeps the selected shot in the selected clip. Otherwise it selects the first shot of the clip, a new shot that no
 * clip has taken yet, or a new one.
 */
export function fixShot() {
  const mine = shotsOf(ui.clipId);
  if (mine.some((s) => s.id === ui.shotId)) return;
  const free = ui.clipId ? project.shots.find((s) => freeShot(project, s)) : undefined;
  if (mine.length) ui.shotId = mine[0].id;
  else if (free) {
    free.clipId = ui.clipId!;
    free.flow = project.clips[ui.clipId!]?.mode;
    ui.shotId = free.id;
  }
  else addShot();
}

/**
 * Replaces the whole project, for example after loading. The caller then sets the clip list and calls fixShot, so the
 * UI state points only at things that exist.
 */
export function loadProject(data: ProjectData, saved?: Partial<Ui>) {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...data.settings };
  if (settings.weapon && !(settings.weapon in WEAPONS)) settings.weapon = undefined;
  Object.assign(project, { settings, clips: data.clips ?? {}, shots: data.shots, sightings: data.sightings });
  oneClipPerShot(project, { uid });
  // a saved object keeps the keys of a newer version that it lacks
  Object.assign(ui, saved ?? {}, { tool: null, layers: { ...ui.layers, ...saved?.layers }, docks: saved?.docks ?? {}, signoffView: { ...ui.signoffView, ...saved?.signoffView } });
}

/** These delete a thing and everything that points at it. */
/** Deletes a shot with its sightings, its detections and its marked sections. */
export function deleteShot(id: Id) {
  project.sightings = project.sightings.filter((s) => s.shotId !== id);
  for (const c of Object.values(project.clips)) {
    if (c.pending?.some((p) => p.shotId === id)) c.pending = c.pending.filter((p) => p.shotId !== id);
    if (c.sections?.some((x) => x.shotId === id)) c.sections = c.sections.filter((x) => x.shotId !== id);
  }
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
  for (const s of project.shots) { delete s.impact[id]; delete s.observer[id]; }
  delete project.clips[id];
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
