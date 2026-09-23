import { seek } from './frameStepper.ts';

/**
 * A WebM from MediaRecorder has no duration (Infinity). This seeks far past the end, waits for a
 * `durationchange` with a real value, then seeks back to 0 (plan section 7).
 */
export function fixDuration(v: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(v.duration)) return Promise.resolve(v.duration);
  return new Promise((resolve) => {
    const done = () => {
      if (!Number.isFinite(v.duration)) return;
      v.removeEventListener('durationchange', done);
      v.removeEventListener('timeupdate', done);
      // wait for the seek back, or its `seeked` event lands on the caller's next seek
      seek(v, 0).then(() => resolve(v.duration));
    };
    v.addEventListener('durationchange', done);
    v.addEventListener('timeupdate', done);
    v.currentTime = 1e101;
  });
}
