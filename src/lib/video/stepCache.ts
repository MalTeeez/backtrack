/**
 * The frames around the playhead, decoded at the size of the viewer (step.worker.ts), so a frame step shows its frame
 * at once while the video still decodes it (player.svelte.ts). It keeps RADIUS frames on each side of the frame on
 * screen, which at the size of the viewer takes a few MB each.
 */
import type { Id } from '../solver/types.ts';
import { frameIndexAt } from './frames.ts';

const RADIUS = 2;
let worker: Worker | null = null, jobs = 0;
let clip: { id: Id; w: number; h: number } | null = null, center = 0;
const cache = new Map<number, ImageBitmap>();
let busy = false, latest: (() => Promise<void>) | null = null;

/** The decoded frame i of a clip, if the cache holds it. */
export const stepFrame = (id: Id, i: number) => (clip?.id === id ? cache.get(i) : undefined);

function clear() {
  for (const b of cache.values()) b.close();
  cache.clear();
}

/**
 * Keeps the frames within RADIUS of frame i decoded, at w x h. Only the newest request counts, so a fast run of steps
 * asks once for where it stops.
 */
export function prefetch(id: Id, url: string, frames: number[], i: number, w: number, h: number) {
  if (clip?.id !== id || clip.w !== w || clip.h !== h) { clear(); clip = { id, w, h }; }
  center = i;
  for (const [k, b] of cache) if (Math.abs(k - i) > RADIUS) { b.close(); cache.delete(k); }
  const need: number[] = [];
  for (let k = Math.max(0, i - RADIUS); k <= Math.min(frames.length - 1, i + RADIUS); k++) if (!cache.has(k)) need.push(k);
  if (!need.length) return;
  latest = () => ask(id, url, frames, need, w, h);
  if (!busy) pump();
}

async function pump() {
  busy = true;
  for (let next; (next = latest);) { latest = null; await next().catch(() => {}); }
  busy = false;
}

function ask(id: Id, url: string, frames: number[], need: number[], w: number, h: number): Promise<void> {
  worker ??= new Worker(new URL('../workers/step.worker.ts', import.meta.url), { type: 'module' });
  const wk = worker, job = ++jobs;
  return new Promise((ok, fail) => {
    const on = ({ data: m }: MessageEvent) => {
      if (m.job !== job) return;
      if (m.bmp) {
        const k = frameIndexAt(frames, m.t);
        // a frame the playhead has moved away from meanwhile, or of another clip or size, is not kept
        if (clip?.id !== id || clip.w !== w || clip.h !== h || Math.abs(k - center) > RADIUS || cache.has(k)) m.bmp.close();
        else cache.set(k, m.bmp);
        return;
      }
      wk.removeEventListener('message', on);
      if (m.error) fail(new Error(m.error)); else ok();
    };
    wk.addEventListener('message', on);
    wk.postMessage({ job, url, times: need.map((k) => frames[k]), w, h });
  });
}
