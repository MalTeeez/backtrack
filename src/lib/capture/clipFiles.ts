/**
 * Clip files: a clip downloads as its video file plus an annotation file (`<video name>.backtrack.json`) when it has
 * marks, and the same pair imports back (annotation.ts).
 */
import { clipBlob } from '../state/persistence.ts';
import type { ClipMeta, ProjectData } from '../solver/types.ts';
import { FORMAT, VERSION, annotation, type Annotation } from './annotation.ts';

export { applyAnnotation } from './annotation.ts';

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The clip name as a file name, with the extension of its video type when the name has none. */
function fileName(clip: ClipMeta, type: string) {
  const base = clip.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'clip';
  if (/\.(webm|mp4|mkv|mov)$/i.test(base)) return base;
  return `${base}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
}

export async function downloadClip(p: ProjectData, clip: ClipMeta) {
  const blob = await clipBlob(clip.id);
  if (!blob) throw new Error(`The video of ${clip.name} is missing.`);
  const video = fileName(clip, blob.type);
  save(blob, video);
  const a = annotation(p, clip);
  if (a) save(new Blob([JSON.stringify(a, null, 2)], { type: 'application/json' }), baseName(video) + '.backtrack.json');
}

/** A file name without its extension, and without `.backtrack.json` for an annotation file. */
export const baseName = (name: string) => name.replace(/\.backtrack\.json$/i, '').replace(/\.[^.]+$/, '');

export const isAnnotationFile = (f: File) => /\.json$/i.test(f.name);

/** Reads and checks an annotation file. Throws with a message for the user when the file is not one. */
export async function readAnnotation(f: File): Promise<Annotation> {
  let a: Annotation;
  try {
    a = JSON.parse(await f.text());
  } catch {
    throw new Error(`${f.name} is not a Backtrack annotation file.`);
  }
  if (a?.format !== FORMAT || !Array.isArray(a.sightings) || !Array.isArray(a.shots)) throw new Error(`${f.name} is not a Backtrack annotation file.`);
  if (a.version > VERSION) throw new Error(`${f.name} comes from a newer Backtrack. Update the app to import it.`);
  if (a.version < VERSION) throw new Error(`${f.name} comes from an older Backtrack, whose files this version does not read.`);
  return a;
}

