/** Reads the compass heading from the frame a video shows, in the browser, with the reader of compass.ts. */
import { compassRegion, readCompass, type CompassReading, type Gray } from './compass.ts';

let canvas: HTMLCanvasElement | null = null;

/** The compass region of the frame a video shows now, in grayscale, and its scale. Null without a frame. */
function regionOf(v: HTMLVideoElement): { g: Gray; s: number } | null {
  if (!v.videoWidth) return null;
  const R = compassRegion(v.videoWidth, v.videoHeight);
  canvas ??= document.createElement('canvas');
  canvas.width = R.w; canvas.height = R.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(v, R.x, R.y, R.w, R.h, 0, 0, R.w, R.h);
  const rgba = ctx.getImageData(0, 0, R.w, R.h).data, gray = new Uint8Array(R.w * R.h);
  // the luminance, as the video's own Y channel that the templates come from
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return { g: { data: gray, w: R.w, h: R.h }, s: R.s };
}

/** The compass reading of the frame a video shows now, or null when it cannot read it. */
export function readVideoCompass(v: HTMLVideoElement): CompassReading | null {
  return readVideoCompassRaw(v)?.sure ?? null;
}

/**
 * The reading of the frame a video shows now, with the best guess even when it is not sure (for the console when a
 * reading fails). Null without a frame.
 */
export function readVideoCompassRaw(v: HTMLVideoElement): { sure: CompassReading | null; guess: CompassReading | null } | null {
  const r = regionOf(v);
  return r && { sure: readCompass(r.g, r.s), guess: readCompass(r.g, r.s, { corr: -2, margin: -2 }) };
}
