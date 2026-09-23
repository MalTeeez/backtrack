/** The least-squares intersection of the tracks of two or more shots (plan section 6.10). */
import { D2R } from './camera.ts';

/** A track is a line through the crater (x, y) at direction th (deg, clockwise from north). */
export interface Track { x: number; y: number; th: number }

export function intersectTracks(tracks: Track[]): { x: number; y: number } | null {
  let a = 0, b = 0, c = 0, r1 = 0, r2 = 0;
  for (const t of tracks) {
    const d = [Math.sin(t.th * D2R), Math.cos(t.th * D2R)];
    // projector onto the normal of the line
    const m11 = 1 - d[0] * d[0], m12 = -d[0] * d[1], m22 = 1 - d[1] * d[1];
    a += m11; b += m12; c += m22;
    r1 += m11 * t.x + m12 * t.y; r2 += m12 * t.x + m22 * t.y;
  }
  const det = a * c - b * b;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (r1 * c - b * r2) / det, y: (a * r2 - b * r1) / det };
}

/** The smallest angle (deg, 0 to 90) between any two tracks. */
export function minCrossingAngle(ths: number[]): number {
  let min = 90;
  for (let i = 0; i < ths.length; i++) {
    for (let j = i + 1; j < ths.length; j++) {
      const d = (((ths[i] - ths[j]) % 180) + 180) % 180;
      min = Math.min(min, d, 180 - d);
    }
  }
  return min;
}
