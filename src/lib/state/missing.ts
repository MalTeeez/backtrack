/**
 * Lists what each phase still needs before the next phase opens. `warnings` holds problems that make a result
 * less accurate but do not stop it. Deterministic, without I/O, and tested in tests/unit.
 */
import { anchorGame } from '../solver/sightings.ts';
import { value } from '../solver/field.ts';
import { motionFlags, motionShotWarning } from '../solver/motion.ts';
import { NEEDED } from '../solver/solve.ts';
import type { ClipMeta, ProjectData, Sighting } from '../solver/types.ts';

/** What a sighting still lacks: the shell, a pitch (or vertical edges) and a heading. A confident automatic value counts. */
export function lacks(s: Sighting): string[] {
  const out: string[] = [];
  if (!value(s.shell)) out.push('shell');
  if (!s.edges.length && value(s.pitch) == null) out.push('vertical edge');
  if (value(s.heading) == null) out.push('compass heading');
  return out;
}

export interface Missing { record: string[]; mark: string[]; coordinates: string[]; warnings: string[] }

export function missing(p: ProjectData, clips: Pick<ClipMeta, 'id' | 'name'>[]): Missing {
  const out: Missing = { record: [], mark: [], coordinates: [], warnings: [] };
  if (!clips.length) out.record.push('Record or upload a clip.');

  const used = p.sightings.filter((s) => !s.excluded);
  const usedShots = p.shots.filter((s) => !s.excluded && used.some((x) => x.shotId === s.id));
  if (clips.length && !p.sightings.length) out.mark.push('Mark the shell on a frame to make the first sighting.');
  for (const shot of usedShots) {
    const list = used.filter((s) => s.shotId === shot.id);
    const noShell = list.filter((s) => lacks(s).includes('shell')).length;
    const noCam = list.filter((s) => lacks(s).some((x) => x !== 'shell')).length;
    const noImpact = new Set(list.filter((s) => value(shot.impact[s.clipId]) == null).map((s) => s.clipId)).size;
    if (noShell) out.mark.push(`${shot.name} has ${noShell} sighting(s) without a shell mark.`);
    if (noCam) out.mark.push(`${shot.name} has ${noCam} sighting(s) without camera data (a vertical edge and a compass heading).`);
    if (noImpact) out.mark.push(`${shot.name} has no impact mark in ${noImpact} clip(s). Mark the frame where the shell lands.`);
    if (list.length < NEEDED) out.mark.push(`${shot.name} has ${list.length} sighting(s) and needs ${NEEDED}.`);
    else if (list.length < 10) out.warnings.push(`${shot.name} has ${list.length} sightings. The result gets more accurate with about 10 or more.`);
    // where the user stood is enough: the solver then finds the crater (automation plan section 11)
    if (!anchorGame(shot)) {
      out.coordinates.push(shot.rangefinder
        ? `The rangefinder reading of ${shot.name} needs your X and Y, the heading and the distance.`
        : `The crater of ${shot.name} has no X and Y, and where you stood is not known either.`);
    }
  }
  // jumps in the motion of the shell: the video probably skipped frames
  const jumps = motionFlags(p);
  for (const shot of usedShots) {
    const own = jumps.filter((f) => f.shotId === shot.id);
    if (own.length) out.warnings.push(motionShotWarning(shot.name, own));
  }
  return out;
}

/**
 * Which of the four phases (record, mark, coordinates, result) are open. A phase opens when every phase before it
 * has nothing missing. The UI always allows a step back.
 */
export function openPhases(m: Missing): [boolean, boolean, boolean, boolean] {
  const record = !m.record.length, mark = record && !m.mark.length;
  return [true, record, mark, mark && !m.coordinates.length];
}
