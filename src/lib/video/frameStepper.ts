/** Seeks on a <video>. Times are in video seconds. Frame steps use the clip's frame list (frames.ts). */
import { frameTimeAt, seekTimeFor, stepFrom } from './frames.ts';

/** Seeks and waits for the frame. A `seeked` event of an earlier seek, which arrives while this one runs, does not count. */
export function seek(v: HTMLVideoElement, t: number): Promise<void> {
  const max = Number.isFinite(v.duration) ? v.duration : t;
  const to = Math.max(0, Math.min(max, t));
  if (Math.abs(v.currentTime - to) < 1e-6 && !v.seeking) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (v.seeking) return;
      v.removeEventListener('seeked', done);
      resolve();
    };
    v.addEventListener('seeked', done);
    v.currentTime = to;
  });
}

/**
 * Steps n frames forward, or back for a negative n, from the frame at time `current`, and returns the start time of
 * the frame it shows. Without a frame list, a step is 1/60 s.
 */
export async function stepFrames(v: HTMLVideoElement, frames: number[] | undefined, n: number, current: number): Promise<number> {
  if (!frames?.length) {
    await seek(v, current + n / 60);
    return v.currentTime;
  }
  const t = stepFrom(frames, current, n);
  await seek(v, seekTimeFor(t));
  return frameTimeAt(frames, t);
}
