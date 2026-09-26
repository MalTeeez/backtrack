/**
 * Small pictures of every frame of a clip, made once per clip by a pool of workers (thumbs.worker.ts): a thumbnail
 * for the film strip, and a preview for the player, which shows it at once while the video still decodes the frame of a
 * seek (player.svelte.ts). A clip has a keyframe every few seconds, and the video decodes a frame from the keyframe
 * before it, so a seek can take a few hundred ms.
 *
 * - First every keyframe decodes, which covers the whole strip in a moment. Then the stretches between keyframes
 *   decode in parallel, the one at the playhead first.
 * - The previews of a clip take about BUDGET bytes as JPEG, so a long clip gets smaller previews. Only the last
 *   MAX_CLIPS clips keep theirs.
 * - The thumbnails are decoded pictures (ImageBitmap), so the strip draws them on a canvas at once, every frame of a
 *   zoom. They take about THUMB_BUDGET bytes, so a long clip keeps every n-th one. They stay for the session.
 */
import type { Id } from '../solver/types.ts';
import { seek } from './frameStepper.ts';
import { frameIndexAt, seekTimeFor } from './frames.ts';

const THUMB_H = 72, BUDGET = 40e6, THUMB_BUDGET = 20e6, MAX_CLIPS = 2;
// JPEG bytes per pixel of a preview, measured on the test clips at quality 0.72
const JPEG_BYTES_PER_PX = 0.12;
const POOL = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 4) - 2));

let pool: Worker[] = [], jobs = 0;
const workers = () => (pool.length ? pool : (pool = Array.from({ length: POOL }, () => new Worker(new URL('../workers/thumbs.worker.ts', import.meta.url), { type: 'module' }))));

/** Runs a job on a worker and hands each message of it to `on` until the job is done. */
function run(w: Worker, msg: Record<string, unknown>, on: (m: any) => void = () => {}): Promise<any> {
  const job = ++jobs;
  return new Promise((ok, fail) => {
    const listen = ({ data: m }: MessageEvent) => {
      if (m.job !== job) return;
      if (m.done || m.keys) { w.removeEventListener('message', listen); ok(m); }
      else if (m.error) { w.removeEventListener('message', listen); fail(new Error(m.error)); }
      else on(m);
    };
    w.addEventListener('message', listen);
    w.postMessage({ job, ...msg });
  });
}

/** `keys` holds the frames of the first pass, one per keyframe, in order. Only every `every`-th frame keeps its thumbnail. */
interface ClipFrames { frames: number[]; thumbs: (ImageBitmap | undefined)[]; previews: (Blob | undefined)[]; keys: number[]; every: number; used: number }
const cache = new Map<Id, ClipFrames>();
/** Goes up as thumbnails arrive, so the strip draws again. */
export const frameCache = $state({ version: 0 });
let bump = 0;
const changed = () => { bump ||= requestAnimationFrame(() => { bump = 0; frameCache.version++; }); };

/** The size of the previews of a clip with n frames, within the budget and at most 960 px wide. */
function previewSize(n: number, w: number, h: number) {
  const px = BUDGET / Math.max(1, n) / JPEG_BYTES_PER_PX, a = w / h;
  const pw = Math.max(320, Math.min(960, Math.sqrt(px * a)));
  return { w: Math.round(pw / 2) * 2, h: Math.round(pw / a / 2) * 2 };
}

/**
 * Starts the pictures of every frame of a clip, from the frame at `focus()` out. Each free worker takes the stretch
 * nearest the playhead as it is then, so a jump moves the work along. A clip that has them or has them on the way is
 * left as it is.
 */
export async function cacheFrames(id: Id, url: string, frames: number[], size: { w: number; h: number }, focus: () => number) {
  if (cache.has(id) || typeof VideoDecoder === 'undefined' || !frames.length) return;
  const c: ClipFrames = { frames, thumbs: [], previews: [], keys: [], every: 1, used: performance.now() };
  cache.set(id, c);
  forgetOld();
  const ws = workers(), p = previewSize(frames.length, size.w, size.h);
  // the share of the thumbnails a clip keeps within THUMB_BUDGET (4 bytes a pixel), every n-th frame
  const every = (c.every = Math.max(1, Math.ceil((frames.length * 4 * THUMB_H * Math.round((THUMB_H * size.w) / size.h)) / THUMB_BUDGET)));
  const take = (m: { t: number; thumb: ImageBitmap; proxy: ArrayBuffer }, key = false) => {
    if (cache.get(id) !== c) { m.thumb.close(); return; }
    const i = frameIndexAt(frames, m.t);
    if (key) { c.keys.push(i); c.keys.sort((a, b) => a - b); }
    if ((key || i % every === 0) && !c.thumbs[i]) c.thumbs[i] = m.thumb;
    else m.thumb.close();
    // a clip whose previews were dropped (forgetOld) keeps only the thumbnails
    if (c.used) c.previews[i] = new Blob([m.proxy], { type: 'image/jpeg' });
    changed();
  };
  const job = (w: Worker, ranges: [number, number][], key = false) => run(w, { kind: 'frames', url, ranges, thumbH: THUMB_H, proxyW: p.w, proxyH: p.h }, (m) => take(m, key));
  try {
    const { keys } = await run(ws[0], { kind: 'plan', url });
    // every keyframe alone first: each decodes on its own, so the strip fills end to end at once
    await Promise.all(ws.map((w, k) => job(w, keys.filter((_: number, i: number) => i % ws.length === k).map((t: number): [number, number] => [t, t + 1e-3]), true)));
    // then the stretches between the keyframes, nearest to the playhead first, each to the next free worker
    const gops = keys.map((t: number, i: number): [number, number] => [t, keys[i + 1] ?? frames[frames.length - 1] + 1]);
    const next = () => {
      const f = focus();
      gops.sort((a: [number, number], b: [number, number]) => dist(a, f) - dist(b, f));
      return gops.shift();
    };
    await Promise.all(ws.map(async (w) => { for (let g; cache.get(id) === c && (g = next());) await job(w, [g]); }));
  } catch (e) {
    console.warn('[frames] The pictures of the frames failed.', e);
  }
}
const dist = ([a, b]: [number, number], t: number) => (t < a ? a - t : t > b ? t - b : 0);

/** Drops the previews of the clips used longest ago, beyond MAX_CLIPS. */
function forgetOld() {
  const withPreviews = [...cache.entries()].filter(([, c]) => c.used).sort((a, b) => b[1].used - a[1].used);
  for (const [, c] of withPreviews.slice(MAX_CLIPS)) { c.previews = []; c.used = 0; }
}

/**
 * The thumbnail of the frame at t (or the nearest kept one of a long clip), or else the one of the nearest keyframe. A tile of the strip so changes its picture
 * at most once, from the keyframe to its own frame. With every thumbnail as it came in, a tile would run through the
 * frames of a stretch as they decode, like a small video.
 */
export function thumbAt(id: Id, t: number): ImageBitmap | undefined {
  const c = cache.get(id);
  if (!c) return undefined;
  const i = frameIndexAt(c.frames, t), own = c.thumbs[i] ?? c.thumbs[Math.round(i / c.every) * c.every];
  if (own) return own;
  let best: number | undefined;
  for (const k of c.keys) if (best == null || Math.abs(k - i) < Math.abs(best - i)) best = k;
  return best == null ? undefined : c.thumbs[best];
}

/** The preview of exactly the frame at t, if it is made. */
export function previewAt(id: Id, t: number): Blob | undefined {
  const c = cache.get(id);
  if (!c) return undefined;
  c.used = performance.now();
  return c.previews[frameIndexAt(c.frames, t)];
}

/** Drops the pictures of a deleted clip. */
export function forgetFrames(id: Id) {
  for (const b of cache.get(id)?.thumbs ?? []) b?.close();
  cache.delete(id);
  frameCache.version++;
}

/**
 * Draws the frames that start at `times` and hands each one to `onthumb` as a JPEG data URL, in order. It stops early
 * when `cancelled()` returns true. A worker makes them. A browser without WebCodecs draws them from a video element on
 * the page instead.
 */
export async function makeThumbnails(url: string, times: number[], onthumb: (i: number, src: string) => void, cancelled: () => boolean) {
  if (typeof VideoDecoder === 'undefined') return onPage(url, times, onthumb, cancelled);
  const w = workers()[0];
  let stop = 0;
  await run(w, { kind: 'thumbs', url, times, height: THUMB_H }, (m) => {
    if (!cancelled()) onthumb(m.i, m.src);
    else if (!stop) w.postMessage({ cancel: (stop = m.job) });
  });
}

async function onPage(url: string, times: number[], onthumb: (i: number, src: string) => void, cancelled: () => boolean) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise((ok, fail) => { v.onloadeddata = ok; v.onerror = fail; });
    const w = Math.round((THUMB_H * v.videoWidth) / (v.videoHeight || 1));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = THUMB_H;
    const g = canvas.getContext('2d')!;
    for (let i = 0; i < times.length && !cancelled(); i++) {
      await seek(v, seekTimeFor(times[i]));
      g.drawImage(v, 0, 0, w, THUMB_H);
      onthumb(i, canvas.toDataURL('image/jpeg', 0.7));
    }
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}
