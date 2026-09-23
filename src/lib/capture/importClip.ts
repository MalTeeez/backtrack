/** Turns a video file or recorder blob into a Clip, prepared for marking (prepareClip.ts). */
import { uid } from '../state/project.svelte.ts';
import type { Clip } from '../solver/types.ts';
import { prepareClip } from '../video/prepareClip.ts';

export async function importClip(blob: Blob, name: string, source: Clip['source']): Promise<Clip> {
  const p = await prepareClip(blob, name);
  // mediabunny reads more containers than a browser plays, so check that this browser can show it
  const v = document.createElement('video');
  v.muted = true;
  const url = URL.createObjectURL(p.blob);
  try {
    await new Promise<void>((resolve, reject) => {
      v.onloadedmetadata = () => resolve();
      v.onerror = () => reject(new Error(`This browser cannot play ${name}. Use WebM or MP4 (H.264).`));
      v.src = url;
    });
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
  return { id: uid(), name, source, blob: p.blob, frames: p.frames, durationS: p.durationS, width: p.width, height: p.height, createdAt: Date.now() };
}
