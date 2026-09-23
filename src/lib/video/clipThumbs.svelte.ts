/**
 * One small picture per clip for the clip list: the frame in the middle of the clip, where the shell usually is. The
 * pictures come one after the other, so a long list does not open many videos at once, and they stay for the session.
 */
import { clipUrl } from '../state/persistence.ts';
import type { Id } from '../solver/types.ts';
import { makeThumbnails } from './thumbnails.ts';

export const clipThumbs: Record<Id, string> = $state({});
const asked = new Set<Id>();
let queue = Promise.resolve();

/** The picture of a clip, or undefined while it is made. The first call starts it. */
export function clipThumb(id: Id, durationS: number): string | undefined {
  if (!asked.has(id)) {
    asked.add(id);
    queue = queue.then(async () => {
      const url = await clipUrl(id);
      if (url) await makeThumbnails(url, [durationS / 2], (_, src) => (clipThumbs[id] = src), () => !asked.has(id)).catch(() => {});
    });
  }
  return clipThumbs[id];
}

/** Drops the picture of a deleted clip. */
export function forgetThumb(id: Id) {
  asked.delete(id);
  delete clipThumbs[id];
}
