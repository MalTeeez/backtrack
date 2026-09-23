/** The annotation file of a clip: its export from the project and its import back. Deterministic, without I/O. */
import type { ClipMeta, Id, ProjectData, Pt, Settings, Shot, Sighting } from '../solver/types.ts';

export const FORMAT = 'backtrack-annotation';
export const VERSION = 1;

/** The annotation file. Files of older versions of the app also have a position, which the import ignores. */
export interface Annotation {
  format: typeof FORMAT;
  version: number;
  clip: Omit<ClipMeta, 'id'>;
  settings: Pick<Settings, 'fovDeg' | 'fovAxis' | 'weapon'>;
  shots: {
    name: string;
    crater: Shot['crater'];
    sourceDeg?: number; sourceTolDeg?: number;
    impactTimeS: number | null;
  }[];
  sightings: {
    shot: string | null; timeS: number; frameW: number; frameH: number;
    shell?: Pt; edges: [Pt, Pt][]; headingDeg?: number; zoom?: number; position?: Sighting['position']; sameCameraAsPrevious: boolean;
  }[];
}

/** Everything the project knows about one clip, or null when the clip has no marks or impact. */
export function annotation(p: ProjectData, clip: ClipMeta): Annotation | null {
  const sightings = p.sightings.filter((s) => s.clipId === clip.id);
  const shots = p.shots.filter((s) => s.impactTimeS[clip.id] != null || sightings.some((x) => x.shotId === s.id));
  if (!sightings.length && !shots.length) return null;
  const { id: _, ...meta } = clip;
  return {
    format: FORMAT,
    version: VERSION,
    clip: meta,
    settings: { fovDeg: p.settings.fovDeg, fovAxis: p.settings.fovAxis, weapon: p.settings.weapon },
    shots: shots.map((s) => ({
      name: s.name, crater: { ...s.crater }, sourceDeg: s.sourceDeg, sourceTolDeg: s.sourceTolDeg,
      impactTimeS: s.impactTimeS[clip.id] ?? null,
    })),
    sightings: sightings
      .sort((a, b) => a.timeS - b.timeS)
      .map(({ id: _i, clipId: _c, shotId, ...s }) => ({ shot: p.shots.find((x) => x.id === shotId)?.name ?? null, ...s })),
  };
}

/**
 * Adds the marks of an annotation to the project, for the clip `clipId`. Shots match by name, and a missing shot is
 * made. The project settings stay, unless the project has no sightings yet. Returns notes for the user.
 */
export function applyAnnotation(p: ProjectData, clipId: Id, a: Annotation, make: { uid: () => Id; shot: (n: number) => Shot }, video: { width: number; height: number }): string[] {
  const notes: string[] = [];
  const s = a.settings;
  if (!p.sightings.length) Object.assign(p.settings, { fovDeg: s.fovDeg, fovAxis: s.fovAxis, weapon: s.weapon });
  else if (s.fovDeg !== p.settings.fovDeg || s.fovAxis !== p.settings.fovAxis) {
    notes.push(`The file used a FOV of ${s.fovDeg} deg (${s.fovAxis === 'h' ? 'horizontal' : 'vertical'}). The project keeps ${p.settings.fovDeg} deg.`);
  }

  const shotIds = new Map<string, Id>();
  for (const f of a.shots) {
    let shot = p.shots.find((x) => x.name === f.name);
    if (!shot) {
      // a new project starts with an empty "Shot 1": fill it instead of adding a second one
      const taken = new Set(shotIds.values());
      const unused = p.shots.find((x) => !taken.has(x.id) && !p.sightings.some((y) => y.shotId === x.id) && x.crater.x == null && !x.crater.from);
      shot = unused ?? make.shot(p.shots.length + 1);
      shot.name = f.name;
      if (!unused) p.shots.push(shot);
      shot = p.shots.find((x) => x.id === shot!.id)!; // the reactive copy
    }
    if (shot.crater.x == null && !shot.crater.from) shot.crater = { ...f.crater };
    if (shot.sourceDeg == null && f.sourceDeg != null) Object.assign(shot, { sourceDeg: f.sourceDeg, sourceTolDeg: f.sourceTolDeg });
    if (f.impactTimeS != null) shot.impactTimeS[clipId] = f.impactTimeS;
    shotIds.set(f.name, shot.id);
  }

  let otherSize = 0;
  for (const x of a.sightings) {
    const shotId = (x.shot != null && shotIds.get(x.shot)) || p.shots[0].id;
    if (x.frameW !== video.width || x.frameH !== video.height) otherSize++;
    p.sightings.push({
      id: make.uid(), shotId, clipId, timeS: x.timeS, frameW: x.frameW, frameH: x.frameH,
      shell: x.shell, edges: x.edges ?? [], headingDeg: x.headingDeg, zoom: x.zoom, position: x.position, sameCameraAsPrevious: !!x.sameCameraAsPrevious,
    });
  }
  if (otherSize) notes.push(`The file has ${otherSize} sighting(s) from a ${a.sightings[0].frameW}x${a.sightings[0].frameH} video, but this video is ${video.width}x${video.height}. Check the marks.`);
  return notes;
}
