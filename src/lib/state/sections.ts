/**
 * Writes what the detection found in a section (src/lib/vision/pipeline.ts) into the project: a sighting per shell
 * mark with automatic fields, the camera of every sighting of the shot in the section, the impact, the sighting position
 * and the map (automation plan sections 5.5 and 8). The user's values stay. Deterministic, without I/O.
 */
import { confSigma, sigmaOf, value } from '../solver/field.ts';
import { GAME_UNIT_M } from '../solver/sightings.ts';
import { cameraToWorld, frameCamera } from '../vision/rotation.ts';
import { sameFrame } from '../video/frames.ts';
import type { Detected, Id, ProjectData, Section, Sighting } from '../solver/types.ts';

/** The sigma (deg) of a camera angle the user typed for a section. */
const TYPED_SIGMA = 0.05;

/** The shell mark sigma (px) from its detection score. It is about 1 px for a clear blob and more for a faint one. */
export const markSigma = (score: number) => Math.min(5, Math.max(0.7, 30 / score));

/** Whether the user put anything into a sighting. If so, a new run of the detection keeps it. */
export const touched = (s: Sighting) =>
  s.shell.manual != null || s.edges.length > 0 || s.heading.manual != null || s.pitch.manual != null || s.roll.manual != null || s.zoom != null || !!s.excluded;

/**
 * The camera of the frame at time t. It is the reference camera of the section (the user's values first), turned by
 * the rotation of the frame. Each angle gets the sigma of the section value and the section as its error group.
 */
export function frameCameraAt(sec: Section, t: number): { h: Detected<number>; p: Detected<number>; r: Detected<number> } | null {
  const f = sec.frames.find((x) => sameFrame(x.t, t));
  const h = value(sec.heading), p = value(sec.pitch), r = value(sec.roll) ?? 0;
  if (!f?.R || !f.ok || h == null || p == null) return null;
  const cam = frameCamera(cameraToWorld(h, p, r), f.R);
  const of = (kind: 'heading' | 'pitch' | 'roll', v: number, field: Section['heading']): Detected<number> => {
    const sigma = field.manual != null ? TYPED_SIGMA : sigmaOf(field) ?? (kind === 'roll' ? TYPED_SIGMA : 1);
    return { value: +v.toFixed(4), sigma, conf: field.manual != null ? 1 : confSigma(kind, sigma), group: sec.id };
  };
  return { h: of('heading', cam.h, sec.heading), p: of('pitch', cam.p, sec.pitch), r: of('roll', cam.r, sec.roll) };
}

/** Gives every sighting of the shot in the section the camera of its frame. It runs after a detection run and after the user changes the section camera. */
export function applyCameras(p: ProjectData, clipId: Id, sec: Section) {
  for (const s of p.sightings) {
    if (s.clipId !== clipId || s.shotId !== sec.shotId) continue;
    const c = frameCameraAt(sec, s.timeS);
    if (!c) continue;
    s.heading.auto = c.h; s.pitch.auto = c.p; s.roll.auto = c.r;
  }
}

/** Where the walk was at time t. The point lies between its two nearest points, or at its first or last one. */
function pathAt(w: NonNullable<Section['walk']>, t: number) {
  const k = w.findIndex((p) => p.t >= t);
  if (k <= 0) return w[k < 0 ? w.length - 1 : 0];
  const a = w[k - 1], b = w[k], u = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return { x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y) };
}

/** Adds (or replaces) the section of a shot in a clip, and writes its results into the project. */
export function applySection(p: ProjectData, clipId: Id, sec: Section, make: { uid: () => Id }) {
  const clip = (p.clips[clipId] ??= { map: {} });
  const old = clip.sections?.find((x) => x.shotId === sec.shotId);
  // the user's camera of the section stays
  if (old) for (const k of ['heading', 'pitch', 'roll'] as const) if (old[k].manual != null) sec[k].manual = old[k].manual;
  clip.sections = [...(clip.sections ?? []).filter((x) => x !== old), sec];

  // The sightings follow the marks. An automatic sighting that the new run did not find again goes.
  const inSection = (t: number) => t >= Math.min(sec.a, old?.a ?? sec.a) - 1e-3 && t <= Math.max(sec.b, old?.b ?? sec.b) + 1e-3;
  p.sightings = p.sightings.filter((s) => !(s.clipId === clipId && s.shotId === sec.shotId && inSection(s.timeS) && !touched(s) && !sec.marks.some((m) => sameFrame(m.t, s.timeS))));
  for (const m of sec.marks) {
    let s = p.sightings.find((x) => x.clipId === clipId && x.shotId === sec.shotId && sameFrame(x.timeS, m.t));
    if (!s) {
      p.sightings.push({ id: make.uid(), shotId: sec.shotId, clipId, timeS: m.t, frameW: sec.width, frameH: sec.height, shell: {}, edges: [], heading: {}, pitch: {}, roll: {} });
      s = p.sightings[p.sightings.length - 1]; // the reactive copy in a Svelte project
    }
    const sigma = markSigma(m.score);
    s.shell.auto = { value: { x: +m.x.toFixed(2), y: +m.y.toFixed(2) }, sigma: +sigma.toFixed(2), conf: confSigma('shell', sigma) };
  }
  // A sighting the user keeps loses an automatic mark that the new run did not find again.
  for (const s of p.sightings) {
    if (s.clipId === clipId && s.shotId === sec.shotId && inSection(s.timeS) && s.shell.auto && !sec.marks.some((m) => sameFrame(m.t, s.timeS))) s.shell.auto = undefined;
  }
  applyCameras(p, clipId, sec);
  // If the user walked, each sighting gets the sighting position of its frame, relative to the one at the impact.
  const walk = sec.walk, end = walk?.[walk.length - 1];
  for (const s of p.sightings) {
    if (s.clipId !== clipId || s.shotId !== sec.shotId || !inSection(s.timeS)) continue;
    const at = walk && pathAt(walk, s.timeS);
    if (at && end) s.walkM = [+((at.x - end.x) * GAME_UNIT_M).toFixed(2), +((at.y - end.y) * GAME_UNIT_M).toFixed(2)];
    else delete s.walkM;
  }

  const shot = p.shots.find((x) => x.id === sec.shotId);
  if (shot) {
    const { at: _at, ...impact } = sec.impact;
    (shot.impact[clipId] ??= {}).auto = impact;
    if (sec.minimap) (shot.observer[clipId] ??= {}).auto = sec.minimap.at;
  }
  if (sec.minimap && clip.map.manual == null) clip.map.auto = sec.minimap.map;
}
