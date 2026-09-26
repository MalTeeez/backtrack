/**
 * Runs the detection of a section off the main thread (automation plan section 14). It decodes the frames from the clip
 * in IndexedDB, loads OpenCV and the map tiles, and runs pipeline.ts. It reports each step and answers with the section.
 */
import { clipBlob } from '../state/persistence.ts';
import { loadCv } from '../vision/cv.ts';
import { decodeFrames, type Frame } from '../vision/decode.ts';
import { detectMap, detectSection, fovCheck } from '../vision/pipeline.ts';
import { Pool } from '../vision/pool.ts';
import type { MapInfo, TileLoader } from '../vision/minimap.ts';
import type { MapId } from '../solver/types.ts';

export interface DetectRequest {
  /**
   * 'map' finds only the map, from the frames at a. 'fov' checks the FOV on the frames of a to b (`fovs`). 'warm'
   * starts the workers and answers nothing.
   */
  kind?: 'section' | 'map' | 'fov' | 'warm';
  fovs?: number[];
  token: number; clipId: string; a: number; b: number;
  fovDeg: number; fovAxis: 'h' | 'v';
  map?: MapId; prior?: { map: MapId; x: number; y: number; mpp: number };
}

/** Frames before the section help the heading (a display change). Frames after it show the impact. */
const BEFORE_S = 0.5, AFTER_S = 1.2;

const root = new URL(`${import.meta.env.BASE_URL}local-data/maps/`, self.location.origin).href;
const infos = new Map<MapId, Promise<MapInfo | null>>();
const mapInfo = (id: MapId) => {
  if (!infos.has(id)) infos.set(id, fetch(`${root}${id}/map.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return infos.get(id)!;
};
const tiles: TileLoader = async (map, z, x, y) => {
  const r = await fetch(`${root}${map}/zoom_${z}/${x}_${y}.webp`).catch(() => null);
  if (!r?.ok || !r.headers.get('content-type')?.includes('image')) return null;
  const bmp = await createImageBitmap(await r.blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data, out = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  return { data: out, w: bmp.width, h: bmp.height };
};

// the pool stays between runs, because its workers have OpenCV loaded
let pool: Pool | null = null;

// The jobs run one at a time, so a burst of requests does not decode many sections of video at once. A FOV check that
// a newer one for the same clip replaced before it started is skipped. A drag of a section sends one per pointer move.
let queue = Promise.resolve();
const newestFov = new Map<string, number>();
self.onmessage = ({ data: q }: MessageEvent<DetectRequest>) => {
  if (q.kind === 'fov') newestFov.set(q.clipId, q.token);
  queue = queue.then(() => run(q));
};

async function run(q: DetectRequest) {
  if (q.kind === 'warm') { await Promise.all([loadCv(), (pool ??= new Pool()).warm()]); return; }
  if (q.kind === 'fov' && newestFov.get(q.clipId) !== q.token) { postMessage({ token: q.token, skipped: true }); return; }
  const step = (s: string) => postMessage({ token: q.token, step: s });
  try {
    step('Loading');
    const [blob, { cv }] = await Promise.all([clipBlob(q.clipId), loadCv()]);
    if (!blob) throw new Error('The video of this clip is missing.');
    const maps: MapId[] = ['bakurani', 'ozeti', 'zestafona'];
    if (q.kind === 'map') {
      // half a second of frames is one moment, so the minimap shows one place
      const frames: Frame[] = [];
      for await (const f of decodeFrames(blob, q.a, q.a + 0.5)) frames.push(f);
      postMessage({ token: q.token, map: frames.length ? await detectMap(cv, { frames, maps, tiles, mapInfo }, (pool ??= new Pool())) : undefined });
      return;
    }
    if (q.kind === 'fov') {
      // use at most 2 s of the section, because the fit says the same over a longer one
      const frames: Frame[] = [];
      for await (const f of decodeFrames(blob, q.a, Math.min(q.b, q.a + 2))) frames.push(f);
      postMessage({ token: q.token, fov: await fovCheck(cv, frames, q.fovs ?? [q.fovDeg], q.fovAxis, (pool ??= new Pool())) });
      return;
    }
    step('Decoding');
    const frames: Frame[] = [];
    for await (const f of decodeFrames(blob, Math.max(0, q.a - BEFORE_S), q.b + AFTER_S)) frames.push(f);
    const section = await detectSection(cv, {
      frames, a: q.a, b: q.b, fovDeg: q.fovDeg, fovAxis: q.fovAxis, map: q.map, prior: q.prior,
      maps, tiles, mapInfo, progress: step,
    }, (pool ??= new Pool()));
    postMessage({ token: q.token, section });
  } catch (e) {
    let msg = String((e as Error)?.message ?? e);
    // OpenCV throws C++ exceptions as numbers
    if (typeof e === 'number') msg = (await loadCv()).cv.exceptionFromPtr(e).msg;
    postMessage({ token: q.token, error: msg });
  }
}
