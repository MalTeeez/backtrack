/** The annotation file of a clip: its export from the project and its import back. Deterministic, without I/O. */
import { sameFrame } from '../video/frames.ts';
import { WEAPONS } from '../solver/ballistics.ts';
import type { ClipMeta, Id, ProjectData, Pt, Settings, Shot, Sighting } from '../solver/types.ts';

export const FORMAT = 'backtrack-annotation';
export const VERSION = 1;

/** The annotation file. Files of older versions of the app also have a position, which the import ignores. */
export interface Annotation {
  format: typeof FORMAT;
  version: number;
  clip: Omit<ClipMeta, 'id'>;
  /** The range settings came later: an older file has only the weapon, and gets its default range. */
  settings: Pick<Settings, 'fovDeg' | 'fovAxis' | 'weapon'> & Partial<Pick<Settings, 'rangeMinM' | 'rangeMaxM' | 'limitToRange'>>;
  shots: {
    name: string;
    crater: Shot['crater'];
    sourceDeg?: number; sourceTolDeg?: number;
    impactTimeS: number | null;
    excluded?: boolean;
  }[];
  sightings: {
    shot: string | null; timeS: number; frameW: number; frameH: number;
    shell?: Pt; edges: [Pt, Pt][]; headingDeg?: number; zoom?: number; position?: Sighting['position']; sameCameraAsPrevious: boolean; excluded?: boolean;
  }[];
}

/** Everything the project knows about one clip, or null when the clip has no marks or impact. */
export function annotation(p: ProjectData, clip: ClipMeta): Annotation | null {
  const sightings = p.sightings.filter((s) => s.clipId === clip.id);
  const shots = p.shots.filter((s) => s.impactTimeS[clip.id] != null || sightings.some((x) => x.shotId === s.id));
  if (!sightings.length && !shots.length) return null;
  const { id: _, ...meta } = clip;
  // sightings name their shot, so two shots of one name get different names in the file
  const names = new Map<Id, string>(), used = new Set<string>();
  for (const s of shots) {
    let n = s.name, k = 2;
    while (used.has(n)) n = `${s.name} (${k++})`;
    used.add(n);
    names.set(s.id, n);
  }
  return {
    format: FORMAT,
    version: VERSION,
    clip: meta,
    settings: {
      fovDeg: p.settings.fovDeg, fovAxis: p.settings.fovAxis, weapon: p.settings.weapon,
      rangeMinM: p.settings.rangeMinM, rangeMaxM: p.settings.rangeMaxM, limitToRange: p.settings.limitToRange,
    },
    shots: shots.map((s) => ({
      name: names.get(s.id)!, crater: { ...s.crater }, sourceDeg: s.sourceDeg, sourceTolDeg: s.sourceTolDeg,
      impactTimeS: s.impactTimeS[clip.id] ?? null,
      ...(s.excluded ? { excluded: true } : {}),
    })),
    sightings: sightings
      .sort((a, b) => a.timeS - b.timeS)
      .map(({ id: _i, clipId: _c, shotId, ...s }) => ({ shot: names.get(shotId) ?? null, ...s })),
  };
}

/**
 * Adds the marks of an annotation to the project, for the clip `clipId`. Shots match by name within that clip, and a
 * missing shot is made in it. The project settings stay, unless the project has no sightings yet. Returns notes for the user.
 */
export function applyAnnotation(p: ProjectData, clipId: Id, a: Annotation, make: { uid: () => Id; shot: (n: number) => Shot }, video: { width: number; height: number }): string[] {
  const notes: string[] = [];
  const s = a.settings;
  if (!p.sightings.length) {
    const w = WEAPONS[s.weapon] ? s.weapon : p.settings.weapon;
    Object.assign(p.settings, {
      fovDeg: s.fovDeg, fovAxis: s.fovAxis, weapon: w,
      rangeMinM: s.rangeMinM ?? WEAPONS[w].min, rangeMaxM: s.rangeMaxM ?? WEAPONS[w].max, limitToRange: s.limitToRange ?? p.settings.limitToRange,
    });
  }
  else if (s.fovDeg !== p.settings.fovDeg || s.fovAxis !== p.settings.fovAxis) {
    notes.push(`The file used a FOV of ${s.fovDeg} deg (${s.fovAxis === 'h' ? 'horizontal' : 'vertical'}). The project keeps ${p.settings.fovDeg} deg.`);
  }

  const shotIds = new Map<string, Id>();
  for (const f of a.shots) {
    // a shot belongs to one clip, so a name only matches a shot of this clip
    let shot = p.shots.find((x) => x.clipId === clipId && x.name === f.name);
    if (!shot) {
      // a new project starts with an empty "Shot 1" in no clip: fill it instead of adding a second one
      const taken = new Set(shotIds.values());
      const unused = p.shots.find((x) => !taken.has(x.id) && freeShot(p, x));
      shot = unused ?? make.shot(p.shots.length + 1);
      Object.assign(shot, { name: f.name, clipId });
      if (!unused) p.shots.push(shot);
      shot = p.shots.find((x) => x.id === shot!.id)!; // the reactive copy
    }
    if (shot.crater.x == null && !shot.crater.from) shot.crater = { ...f.crater };
    if (shot.sourceDeg == null && f.sourceDeg != null) shot.sourceDeg = f.sourceDeg;
    if (shot.sourceTolDeg == null && f.sourceTolDeg != null) shot.sourceTolDeg = f.sourceTolDeg;
    if (f.impactTimeS != null) shot.impactTimeS[clipId] = f.impactTimeS;
    if (f.excluded) shot.excluded = true;
    shotIds.set(f.name, shot.id);
  }

  // a sighting without a known shot goes to the first shot of the file, or a new one: never to a shot of another clip
  const fileShot = () => {
    const first = [...shotIds.values()][0];
    if (first) return first;
    const s = { ...make.shot(p.shots.length + 1), clipId };
    p.shots.push(s);
    shotIds.set(s.name, s.id);
    return s.id;
  };
  let otherSize = 0, again = 0;
  for (const x of a.sightings) {
    const shotId = (x.shot != null && shotIds.get(x.shot)) || fileShot();
    // the same file imported twice: a sighting of this shot on this frame is already there
    if (p.sightings.some((y) => y.clipId === clipId && y.shotId === shotId && sameFrame(y.timeS, x.timeS))) { again++; continue; }
    if (x.frameW !== video.width || x.frameH !== video.height) otherSize++;
    p.sightings.push({
      id: make.uid(), shotId, clipId, timeS: x.timeS, frameW: x.frameW, frameH: x.frameH,
      shell: x.shell, edges: x.edges ?? [], headingDeg: x.headingDeg, zoom: x.zoom, position: x.position, sameCameraAsPrevious: !!x.sameCameraAsPrevious, ...(x.excluded ? { excluded: true } : {}),
    });
  }
  if (again) notes.push(`${again} sighting(s) of the file were already there and were skipped.`);
  if (otherSize) notes.push(`The file has ${otherSize} sighting(s) from a ${a.sightings[0].frameW}x${a.sightings[0].frameH} video, but this video is ${video.width}x${video.height}. Check the marks.`);
  return notes;
}

/** The clips a shot has a sighting or an impact mark in. */
export const clipsOfShot = (p: ProjectData, s: Shot) =>
  new Set([...Object.keys(s.impactTimeS), ...p.sightings.filter((x) => x.shotId === s.id).map((x) => x.clipId)]);

/** A shot with no crater yet. */
export const blankShot = (s: Shot) => s.crater.x == null && s.crater.y == null && !s.crater.from;

/** A new shot that no clip has taken yet: the first clip takes it instead of making another one. */
export const freeShot = (p: ProjectData, s: Shot) => s.clipId == null && !clipsOfShot(p, s).size && blankShot(s);

/**
 * A shot belongs to one clip for now. Projects from before shots stored their clip get it here, from their marks. An
 * older import merged shots of the same name from several clips, so this splits such a shot into one shot per clip.
 * The new shots get no crater or suspected heading, because the merge kept only those of the first clip. It also
 * drops shots that a deleted clip left behind: in no clip, but with a crater. Returns the names of the new shots.
 */
export function oneClipPerShot(p: ProjectData, make: { uid: () => Id }): string[] {
  const made: string[] = [];
  p.shots = p.shots.filter((s) => s.clipId != null || clipsOfShot(p, s).size || blankShot(s));
  for (const s of [...p.shots]) {
    const own = p.sightings.filter((x) => x.shotId === s.id);
    const inClips = [...clipsOfShot(p, s)];
    s.clipId ??= inClips[0];
    for (const [i, clipId] of inClips.filter((c) => c !== s.clipId).entries()) {
      const shot: Shot = { id: make.uid(), name: `${s.name} (${i + 2})`, crater: {}, impactTimeS: {}, clipId, ...(s.excluded ? { excluded: true } : {}) };
      if (s.impactTimeS[clipId] != null) shot.impactTimeS[clipId] = s.impactTimeS[clipId];
      delete s.impactTimeS[clipId];
      for (const x of own) if (x.clipId === clipId) x.shotId = shot.id;
      p.shots.push(shot);
      made.push(shot.name);
    }
  }
  return made;
}
