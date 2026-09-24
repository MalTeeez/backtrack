/** Frame times of a clip: a sorted list of presentation times in seconds (prepareClip.ts). Deterministic, without I/O. */

/**
 * How close two times must be to count as the same frame. Sightings store the presentation time of their frame, so
 * this only has to be smaller than half the shortest frame interval (4 ms is half a frame at 120 fps).
 */
const SAME_FRAME_S = 0.004;
/** True when both times belong to the same frame. */
export const sameFrame = (a: number, b: number) => Math.abs(a - b) < SAME_FRAME_S;

/** The index of the frame on screen at time t: the last frame that starts at or before t. */
export function frameIndexAt(frames: number[], t: number): number {
  let lo = 0, hi = frames.length - 1;
  if (hi < 0 || t <= frames[0]) return 0;
  if (t >= frames[hi]) return hi;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (frames[m] <= t + 1e-6) lo = m; else hi = m; }
  return lo;
}

/** The start time of the frame on screen at time t. Without a frame list, t itself. */
export const frameTimeAt = (frames: number[] | undefined, t: number) => (frames?.length ? frames[frameIndexAt(frames, t)] : t);

/**
 * Where to seek so the video shows the frame that starts at t. Half a millisecond past its start, so a rounded time
 * never lands on the frame before.
 */
export const seekTimeFor = (t: number) => t + 0.0005;

/** The start of the frame n frames after (or before, for a negative n) the frame at time t. */
export function stepFrom(frames: number[], t: number, n: number): number {
  const i = Math.max(0, Math.min(frames.length - 1, frameIndexAt(frames, t) + n));
  return frames[i];
}

/** One frame per `everyS` seconds for the film strip, each a different frame, in order. */
export function thumbTimes(frames: number[], durationS: number, everyS = 2): number[] {
  const out: number[] = [];
  const count = Math.max(1, Math.ceil(durationS / everyS));
  for (let k = 0; k < count; k++) {
    const t = frameTimeAt(frames, Math.min(durationS, (k + 0.5) * (durationS / count)));
    if (out.at(-1) !== t) out.push(t);
  }
  return out;
}
