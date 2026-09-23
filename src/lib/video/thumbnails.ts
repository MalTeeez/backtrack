/** Small frames of a clip for the timeline film strip. */
import { seek } from './frameStepper.ts';
import { seekTimeFor } from './frames.ts';

/**
 * Draws the frames that start at `times` and hands each one to `onthumb` as a JPEG data URL, in order. It stops early
 * when `cancelled()` returns true.
 */
export async function makeThumbnails(url: string, times: number[], onthumb: (i: number, src: string) => void, cancelled: () => boolean) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise((ok, fail) => { v.onloadeddata = ok; v.onerror = fail; });
    const h = 72, w = Math.round((h * v.videoWidth) / (v.videoHeight || 1));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d')!;
    for (let i = 0; i < times.length && !cancelled(); i++) {
      await seek(v, seekTimeFor(times[i]));
      g.drawImage(v, 0, 0, w, h);
      onthumb(i, canvas.toDataURL('image/jpeg', 0.7));
    }
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}
