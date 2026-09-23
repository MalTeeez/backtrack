/** Keeps the clips (with their video) and the project in IndexedDB. */
import { openDB, type DBSchema } from 'idb';
import type { Clip, ClipMeta, Id, ProjectData } from '../solver/types.ts';
import type { Ui } from './project.svelte.ts';
import { prepareClip } from '../video/prepareClip.ts';

interface Saved { data: ProjectData; ui: Partial<Ui> }

interface Schema extends DBSchema {
  clips: { key: Id; value: Clip };
  project: { key: string; value: Saved };
}

const db = openDB<Schema>('backtrack', 1, {
  upgrade(d) {
    d.createObjectStore('clips', { keyPath: 'id' });
    d.createObjectStore('project');
  },
});

export async function saveClip(c: Clip) { await (await db).put('clips', c); }
export async function deleteClip(id: Id) { await (await db).delete('clips', id); }
export async function clipBlob(id: Id): Promise<Blob | undefined> { return (await (await db).get('clips', id))?.blob; }
export async function renameClip(id: Id, name: string) {
  const d = await db, c = await d.get('clips', id);
  if (c) await d.put('clips', { ...c, name });
}
export async function listClips(): Promise<ClipMeta[]> {
  const all = await (await db).getAll('clips');
  return all.map(({ blob, frames: _f, ...meta }) => ({ ...meta, bytes: blob.size })).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The frame list of a clip. A clip saved before clips were prepared gets prepared now (remuxed, with its frame list),
 * and saved again, so this happens once.
 */
export async function clipFrames(id: Id): Promise<number[] | undefined> {
  const d = await db, c = await d.get('clips', id);
  if (!c) return undefined;
  if (c.frames) return c.frames;
  const p = await prepareClip(c.blob, c.name).catch(() => null);
  if (!p) return undefined;
  await d.put('clips', { ...c, blob: p.blob, frames: p.frames, durationS: p.durationS });
  dropClipUrl(id); // the old URL still points at the unprepared video
  return p.frames;
}

export async function loadSaved(): Promise<Saved | undefined> { return (await db).get('project', 'current'); }
export async function save(s: Saved) { await (await db).put('project', s, 'current'); }

/** The object URL of the video of a clip. Each session makes it once. */
const urls = new Map<Id, string>();
export async function clipUrl(id: Id): Promise<string | undefined> {
  if (!urls.has(id)) {
    const b = await clipBlob(id);
    if (!b) return undefined;
    urls.set(id, URL.createObjectURL(b));
  }
  return urls.get(id);
}
export function dropClipUrl(id: Id) {
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
}
