/**
 * Decodes the frames of a section of a clip for the detection (automation plan section 14), with mediabunny and
 * WebCodecs, in a worker or a page. Each frame gives its gray picture (the luma of the video, in full range), and the
 * compass and minimap crops the way the app reads them (a canvas, as compassRead.ts).
 */
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink, type VideoSample } from 'mediabunny';
import { compassRegion } from '../video/compass.ts';
import { minimapRegion } from './hud.ts';
import type { Gray8 } from './image.ts';

export interface Frame {
  /** The start time of the frame on the timeline of the app (s). */
  t: number;
  gray: Gray8;
  /** The compass number box in gray, as compassRead.ts reads it, and its scale. */
  compass: Gray8;
  /** The minimap in RGBA. */
  minimap: { data: Uint8ClampedArray; w: number; h: number };
  /** The pixel format the decoder gave, for checks. */
  format: string | null;
}

/** The frames of a clip that start in [a, b), in time order. */
export async function* decodeFrames(blob: Blob, a: number, b: number): AsyncGenerator<Frame> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('The clip has no video.');
  // the app's timeline starts at the first frame (prepareClip.ts)
  // packets come in decode order, so the first frame is the least time among the first packets
  let t0 = Infinity;
  for await (const p of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
    t0 = Math.min(t0, p.timestamp);
    if (p.timestamp > t0 + 1) break;
  }
  // a software decoder gives the YUV planes in every browser (Firefox's default path gives BGRX, converted by it)
  const sink = new VideoSampleSink(track, { hardwareAcceleration: 'prefer-software' });
  for await (const s of sink.samples(t0 + a - 0.0005, t0 + b - 0.0005)) {
    try {
      yield await frameOf(s, s.timestamp - t0);
    } finally {
      s.close();
    }
  }
}

let canvas: OffscreenCanvas | null = null;
function crop(s: VideoSample, R: { x: number; y: number; w: number; h: number }) {
  canvas ??= new OffscreenCanvas(1, 1);
  canvas.width = R.w; canvas.height = R.h;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  s.draw(g, R.x, R.y, R.w, R.h, 0, 0, R.w, R.h);
  return g.getImageData(0, 0, R.w, R.h).data;
}

async function frameOf(s: VideoSample, t: number): Promise<Frame> {
  const w = s.displayWidth, h = s.displayHeight;
  const gray = new Uint8Array(w * h);
  if (s.format === 'I420' || s.format === 'NV12' || s.format === 'I420A') {
    // the Y plane, from the limited range of the video (16 to 235) to full range
    const buf = new Uint8Array(s.allocationSize());
    const [Y] = await s.copyTo(buf);
    const lut = new Uint8Array(256).map((_, v) => Math.max(0, Math.min(255, Math.round(((v - 16) * 255) / 219))));
    for (let y = 0; y < h; y++) {
      const row = Y.offset + y * Y.stride;
      for (let x = 0; x < w; x++) gray[y * w + x] = lut[buf[row + x]];
    }
  } else {
    // RGB that the browser made from the YUV of the video (Firefox gives BGRX): the luma weights of the same color
    // matrix give the Y back, so every browser sees the same gray
    const [kr, kb] = s.colorSpace?.matrix === 'bt709' ? [0.2126, 0.0722] : [0.299, 0.114], kg = 1 - kr - kb;
    const bgr = s.format === 'BGRX' || s.format === 'BGRA', rgb = s.format === 'RGBX' || s.format === 'RGBA';
    if (bgr || rgb) {
      const buf = new Uint8Array(s.allocationSize());
      const [P] = await s.copyTo(buf), [ri, bi] = bgr ? [2, 0] : [0, 2];
      for (let y = 0; y < h; y++) {
        const row = P.offset + y * P.stride;
        for (let x = 0; x < w; x++) { const o = row + 4 * x; gray[y * w + x] = kr * buf[o + ri] + kg * buf[o + 1] + kb * buf[o + bi] + 0.5; }
      }
    } else {
      const d = crop(s, { x: 0, y: 0, w, h });
      for (let i = 0; i < gray.length; i++) gray[i] = kr * d[i * 4] + kg * d[i * 4 + 1] + kb * d[i * 4 + 2] + 0.5;
    }
  }
  const C = compassRegion(w, h), rgba = crop(s, C), cg = new Uint8Array(C.w * C.h);
  for (let i = 0; i < cg.length; i++) cg[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const M = minimapRegion(w, h);
  return { t, gray: { data: gray, w, h }, compass: { data: cg, w: C.w, h: C.h }, minimap: { data: crop(s, M), w: M.w, h: M.h }, format: `${s.format} ${JSON.stringify(s.colorSpace)}` };
}
