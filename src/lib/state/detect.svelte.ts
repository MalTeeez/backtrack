/**
 * The detection worker and what it does for the app: the detection of sections (one at a time, from a queue), the
 * search for the map of a clip, and the check of the FOV. Each request has a token, and each answer goes to the
 * handler of its token, so the requests run side by side. The results go into the project (sections.ts).
 */
import { clipInfo, clipMap, project, uid } from './project.svelte.ts';
import { applySection } from './sections.ts';
import type { DetectRequest } from '../workers/detect.worker.ts';
import type { Id, MapId, Section } from '../solver/types.ts';

export interface Job { clipId: Id; shotId: Id; a: number; b: number }
/** How well a pure rotation fits the frames of a section at each FOV (deg), and how far the camera turned there. */
export interface FovFit { fov: number; sure: number; fit: number }
export interface FovCheck { running: boolean; a: number; b: number; fovAxis: 'h' | 'v'; fits: FovFit[]; turnDeg: number; error?: string }

export const detection: {
  running: (Job & { step: string; since: number }) | null;
  queue: Job[];
  /** The detections of one batch (the Process button of Setup), as the count of finished ones and the total. */
  batch: { done: number; total: number };
  error: string;
  /** The clip whose map the minimap search is looking for. */
  searching: Id | null;
  fov: Record<Id, FovCheck>;
} = $state({ running: null, queue: [], batch: { done: 0, total: 0 }, error: '', searching: null, fov: {} });

let worker: Worker | null = null, token = 0;
const handlers = new Map<number, (m: Record<string, unknown>) => void>();
function ensure() {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/detect.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data: m }) => handlers.get(m.token)?.(m);
  worker.onerror = (e) => {
    detection.error = e.message || 'The detection failed.';
    reset();
  };
  return worker;
}
function send(req: Omit<DetectRequest, 'token'>, on: (m: Record<string, unknown>) => void) {
  const t = ++token;
  handlers.set(t, on);
  ensure().postMessage({ ...req, token: t } satisfies DetectRequest);
  return t;
}

/** The sighting position that the minimap search found before in this clip, as a start for the next search. */
function prior(clipId: Id): DetectRequest['prior'] {
  const s = (project.clips[clipId]?.sections ?? []).map((x) => x.minimap).find((m) => m && m.at.conf >= 0.5 && m.map.value);
  return s ? { map: s.map.value as MapId, x: s.at.value!.x, y: s.at.value!.y, mpp: s.mpp } : undefined;
}

/** Detects a section for a shot, at once or after the detections before it in the queue. */
export function detect(clipId: Id, shotId: Id, a: number, b: number) {
  detection.queue.push({ clipId, shotId, a, b });
  next();
}
/** Detects several sections one after the other, as one batch with a progress. */
export function detectAll(jobs: Job[]) {
  if (!detection.running && !detection.queue.length) detection.batch = { done: 0, total: 0 };
  detection.batch.total += jobs.length;
  detection.queue.push(...jobs);
  next();
}
function next() {
  if (detection.running || !detection.queue.length) return;
  const job = detection.queue.shift()!;
  detection.error = '';
  detection.running = { ...job, step: 'Starting', since: Date.now() };
  const st = project.settings;
  const t = send({ clipId: job.clipId, a: job.a, b: job.b, fovDeg: st.fovDeg, fovAxis: st.fovAxis, map: clipMap(job.clipId), prior: prior(job.clipId) }, (m) => {
    if (!detection.running) return;
    if (m.step) { detection.running.step = m.step as string; return; }
    handlers.delete(t);
    detection.running = null;
    if (detection.batch.total) detection.batch.done++;
    if (m.error) detection.error = m.error as string;
    else {
      const sec: Section = { ...(m.section as Omit<Section, 'id' | 'shotId' | 'ranAt'>), id: uid(), shotId: job.shotId, ranAt: Date.now() };
      applySection(project, job.clipId, sec, { uid });
    }
    next();
  });
}

/** The steps a detection reports, in order, for a progress bar. */
export const STEPS = ['Starting', 'Loading', 'Decoding', 'Stabilizing', 'Pitch and roll', 'Heading', 'Shell', 'Impact', 'Minimap'];
/** The progress of the batch, from 0 to 1. It counts the finished detections and the step of the running one. */
export function progress(): number {
  const b = detection.batch, r = detection.running;
  if (!b.total) return 0;
  const inRun = r ? Math.max(0, STEPS.indexOf(r.step)) / STEPS.length : 0;
  return Math.min(1, (b.done + inRun) / b.total);
}

const mapAsked = new Set<Id>();
/** Finds the map of a clip from its minimap, once per clip and session (automation plan section 4). */
export function detectClipMap(clipId: Id, durationS: number) {
  if (mapAsked.has(clipId) || project.clips[clipId]?.map.auto) return;
  mapAsked.add(clipId);
  detection.searching = clipId;
  const t = send({ kind: 'map', clipId, a: durationS / 2, b: durationS / 2, fovDeg: 0, fovAxis: 'h' }, (m) => {
    if (m.step) return;
    handlers.delete(t);
    if (detection.searching === clipId) detection.searching = null;
    const found = (m.map as { map?: { value?: MapId } } | undefined)?.map;
    if (found?.value) clipInfo(clipId).map.auto = found as never;
  });
}

/**
 * Stops the search for the map of a clip once the user picked one. With nothing else running, the worker ends (the
 * search keeps every core busy), and a fresh one starts for the next detection. Otherwise the app drops its answer.
 */
export function stopMapSearch(clipId: Id) {
  if (detection.searching !== clipId) return;
  detection.searching = null;
  if (!detection.running && !Object.values(detection.fov).some((f) => f.running)) { reset(); warmDetection(); }
}

/**
 * Checks the FOV on a section of a clip. The check measures how well a pure rotation fits its frames at the FOV of the
 * settings, and at 10 deg less and more. A wrong FOV fits worse (with 90 instead of 100 deg, the stabilization of test
 * clip 1 failed).
 */
export function checkFov(clipId: Id, a: number, b: number) {
  const st = project.settings, have = detection.fov[clipId];
  if (have && have.a === a && have.b === b && have.fits[0]?.fov === st.fovDeg && have.fovAxis === st.fovAxis) return;
  const fovs = [st.fovDeg, st.fovDeg - 10, st.fovDeg + 10].filter((f) => f >= 30 && f <= 150);
  detection.fov[clipId] = { running: true, a, b, fovAxis: st.fovAxis, fits: [], turnDeg: 0 };
  const t = send({ kind: 'fov', clipId, a, b, fovDeg: st.fovDeg, fovAxis: st.fovAxis, fovs }, (m) => {
    if (m.step) return;
    handlers.delete(t);
    const c = detection.fov[clipId];
    // A newer check replaced this one in the worker. It can have the same section when a drag comes back to it.
    if (m.skipped || !c || c.a !== a || c.b !== b) return;
    c.running = false;
    if (m.error) c.error = m.error as string;
    else { const r = m.fov as { fits: FovFit[]; turnDeg: number }; c.fits = r.fits; c.turnDeg = r.turnDeg; }
  });
}

/**
 * What the FOV check says: fine, a suspected mismatch (another FOV fits clearly better, or few frames get a sure
 * rotation), or nothing (the camera barely turned, and every FOV fits a still camera).
 */
export function fovVerdict(c: FovCheck | undefined): { kind: 'ok' | 'mismatch' | 'unknown'; better?: number } | null {
  if (!c || c.running || !c.fits.length) return null;
  if (c.turnDeg < 3) return { kind: 'unknown' };
  const cur = c.fits[0], best = [...c.fits].sort((p, q) => p.fit - q.fit)[0];
  if (best.fov !== cur.fov && best.fit < cur.fit * 0.7 && best.sure >= cur.sure - 0.05) return { kind: 'mismatch', better: best.fov };
  if (cur.sure < 0.6) return { kind: 'mismatch' };
  return { kind: 'ok' };
}

/**
 * Starts the detection worker and its pool before the first run, when a clip opens. Every vision worker loads its
 * OpenCV, which took about 3.4 s of a first run of 8.6 s.
 */
export function warmDetection() {
  if (worker) return;
  ensure().postMessage({ kind: 'warm', token: 0, clipId: '', a: 0, b: 0, fovDeg: 0, fovAxis: 'h' } satisfies DetectRequest);
}

function reset() {
  worker?.terminate();
  worker = null;
  handlers.clear();
  detection.running = null;
  detection.searching = null;
  for (const c of Object.values(detection.fov)) if (c.running) c.running = false;
}
/** Stops everything. The worker ends, the queue empties, and the next request starts a new worker. */
export function cancelDetect() {
  detection.queue = [];
  detection.batch = { done: 0, total: 0 };
  reset();
}
