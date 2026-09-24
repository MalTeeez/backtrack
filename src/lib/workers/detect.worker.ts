/**
 * Runs the detection of a section off the main thread (automation plan section 14): decodes the frames from the clip in
 * IndexedDB, loads OpenCV and the map tiles, and runs pipeline.ts. It reports each step, and answers with the section.
 */
import { clipBlob } from '../state/persistence.ts';
import { loadCv } from '../vision/cv.ts';
import { decodeFrames, type Frame } from '../vision/decode.ts';
import { detectMap, detectSection } from '../vision/pipeline.ts';
import { Pool } from '../vision/pool.ts';
import type { MapInfo, TileLoader } from '../vision/minimap.ts';
import type { MapId } from '../solver/types.ts';

export interface DetectRequest {
  /** 'map' finds only the map, from the frames at a. */
  kind?: 'section' | 'map';
  token: number; clipId: string; a: number; b: number;
  fovDeg: number; fovAxis: 'h' | 'v';
  map?: MapId; prior?: { map: MapId; x: number; y: number; mpp: number };
}

/** Frames before the section help the heading (a display change); frames after it show the impact. */
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

// the pool stays between runs: its workers have OpenCV loaded
let pool: Pool | null = null;

self.onmessage = async ({ data: q }: MessageEvent<DetectRequest>) => {
  const step = (s: string) => postMessage({ token: q.token, step: s });
  try {
    step('Loading');
    const [blob, { cv }] = await Promise.all([clipBlob(q.clipId), loadCv()]);
    if (!blob) throw new Error('The video of this clip is missing.');
    const maps: MapId[] = ['bakurani', 'ozeti', 'zestafona'];
    if (q.kind === 'map') {
      // half a second of frames: one moment, so the minimap shows one place
      const frames: Frame[] = [];
      for await (const f of decodeFrames(blob, q.a, q.a + 0.5)) frames.push(f);
      postMessage({ token: q.token, map: frames.length ? await detectMap(cv, { frames, maps, tiles, mapInfo }, (pool ??= new Pool())) : undefined });
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
};
