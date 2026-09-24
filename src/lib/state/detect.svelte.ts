/**
 * Runs the detection of a section (the loop section of the timeline) for a shot in the detection worker, and writes
 * the result into the project (sections.ts). One run at a time.
 */
import { clipInfo, clipMap, project, uid } from './project.svelte.ts';
import { applySection } from './sections.ts';
import type { DetectRequest } from '../workers/detect.worker.ts';
import type { Id, MapId, Section } from '../solver/types.ts';

export const detection: { running: { clipId: Id; shotId: Id; a: number; b: number; step: string; since: number } | null; error: string } =
  $state({ running: null, error: '' });

let worker: Worker | null = null, token = 0;

/** Where the minimap search found the user before in this clip, as a start for the next search. */
function prior(clipId: Id): DetectRequest['prior'] {
  const s = (project.clips[clipId]?.sections ?? []).map((x) => x.minimap).find((m) => m && m.at.conf >= 0.5 && m.map.value);
  return s ? { map: s.map.value as MapId, x: s.at.value!.x, y: s.at.value!.y, mpp: s.mpp } : undefined;
}

export function detect(clipId: Id, shotId: Id, a: number, b: number) {
  if (detection.running) return;
  detection.error = '';
  detection.running = { clipId, shotId, a, b, step: 'Starting', since: Date.now() };
  worker ??= new Worker(new URL('../workers/detect.worker.ts', import.meta.url), { type: 'module' });
  const t = ++token;
  worker.onmessage = ({ data: m }) => {
    if (m.token !== t || !detection.running) return;
    if (m.step) { detection.running.step = m.step; return; }
    detection.running = null;
    if (m.error) { detection.error = m.error; return; }
    const sec: Section = { ...(m.section as Omit<Section, 'id' | 'shotId' | 'ranAt'>), id: uid(), shotId, ranAt: Date.now() };
    applySection(project, clipId, sec, { uid });
  };
  worker.onerror = (e) => { detection.running = null; detection.error = e.message || 'The detection failed.'; worker = null; };
  const st = project.settings;
  worker.postMessage({ token: t, clipId, a, b, fovDeg: st.fovDeg, fovAxis: st.fovAxis, map: clipMap(clipId), prior: prior(clipId) } satisfies DetectRequest);
}

const mapAsked = new Set<Id>();
/**
 * Finds the map of a clip from its minimap, once per clip and session, while nothing else runs: the question for the
 * map then shows it first (automation plan section 4).
 */
export function detectClipMap(clipId: Id, durationS: number) {
  if (mapAsked.has(clipId) || detection.running || project.clips[clipId]?.map.auto) return;
  mapAsked.add(clipId);
  worker ??= new Worker(new URL('../workers/detect.worker.ts', import.meta.url), { type: 'module' });
  const t = ++token;
  detection.running = { clipId, shotId: '', a: durationS / 2, b: durationS / 2, step: 'Finding the map', since: Date.now() };
  worker.onmessage = ({ data: m }) => {
    if (m.token !== t || !detection.running) return;
    if (m.step) return;
    detection.running = null;
    const found = m.map?.map;
    if (found?.value) clipInfo(clipId).map.auto = found;
  };
  worker.postMessage({ kind: 'map', token: t, clipId, a: durationS / 2, b: durationS / 2, fovDeg: 0, fovAxis: 'h' } satisfies DetectRequest);
}

/** Stops the search for the map of a clip, once the user answered the question. */
export function stopMapSearch(clipId: Id) {
  if (detection.running?.clipId === clipId && !detection.running.shotId) cancelDetect();
}

/** Stops a run: the worker ends, and the next run starts a new one. */
export function cancelDetect() {
  worker?.terminate();
  worker = null;
  detection.running = null;
}
