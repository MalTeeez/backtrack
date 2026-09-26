/**
 * The position of the HUD of WARDOGS (automation plan section 5.2 and Appendix A.6). The layout is measured at
 * 3840x2160 and scales with the frame height. The minimap stays at the left edge and the compass in the middle.
 */
import type { Mask, Rect } from './image.ts';

/**
 * The minimap crop at 2160p, and the player arrow in it. The crop is the whole map part of the minimap, from its edges
 * in the test clips, with the NAV text at the bottom right (which minimap.ts masks). The arrow sits in its middle.
 */
const MINIMAP = { x0: 64, y0: 1488, x1: 576, y1: 1952 };
export const ARROW = { x: 256.5, y: 229.2 };
/** The height of the minimap crop at 2160p, to scale the arrow to a crop of another frame height. */
export const MINIMAP_H = MINIMAP.y1 - MINIMAP.y0;

export function minimapRegion(w: number, h: number): Rect & { s: number } {
  const s = h / 2160;
  return { x: Math.round(MINIMAP.x0 * s), y: Math.round(MINIMAP.y0 * s), w: Math.round((MINIMAP.x1 - MINIMAP.x0) * s), h: Math.round((MINIMAP.y1 - MINIMAP.y0) * s), s };
}

/**
 * The fixed mask covers the minimap and the compass strip at the top, whose labels move with the heading but not like
 * the world. Every other HUD element stands still, and the stabilization finds it per section.
 */
export function fixedMask(w: number, h: number): Mask {
  const s = h / 2160, m = new Uint8Array(w * h).fill(1);
  const off = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) m.fill(0, y * w + Math.max(0, Math.floor(x0)), y * w + Math.min(w, Math.ceil(x1)));
  };
  // the minimap with a margin for its frame
  off(0, (MINIMAP.y0 - 60) * s, (MINIMAP.x1 + 40) * s, (MINIMAP.y1 + 90) * s);
  // the compass strip and its number box
  off(w / 2 - 900 * s, 0, w / 2 + 900 * s, 125 * s);
  return { data: m, w, h };
}
