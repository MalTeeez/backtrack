/**
 * Draws the downloaded map imagery under a canvas map in game units. The tiles share one pyramid over `tileBounds`:
 * zoom z has 2^z tiles per side, x counts from minX and y from maxY.
 * - color: local-data/maps/<id>/zoom_<z>/<x>_<y>.webp (tools/fetch-map-data.ts, from wardogs-calculator)
 * - topography: local-data/topo/<id>/<z>/<x>_<y>.png (tools/make-topo.ts), from the terrain, up to zoom 5
 * The style picks the color imagery, the same in gray, or the topography, and the opacity lets marks on top stand out.
 */

import type { MapId } from '../solver/types.ts';

export const MAPS: Record<MapId, string> = { bakurani: 'Bakurani', ozeti: 'Ozeti', zestafona: 'Zestafona' };

interface MapInfo {
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  tileBounds: { minX: number; maxX: number; minY: number; maxY: number };
  tileSize: number;
  maxZoom: number;
}

const ROOT = `${import.meta.env.BASE_URL}local-data/maps`;

export type TileStyle = 'color' | 'gray' | 'topo';
export const TILE_STYLES: Record<TileStyle, string> = { color: 'Color', gray: 'Gray', topo: 'Topo' };
const TOPO_MAX_ZOOM = 5;

const KEY = 'backtrack:map-imagery';
interface TileSettings { style: TileStyle; opacity: number }
function stored(): TileSettings {
  const fallback: TileSettings = { style: 'color', opacity: 0.35 };
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return fallback; }
}
/** The map imagery settings of every map in the app, kept in this browser. */
export const tiles: TileSettings = $state(stored());
export function setTiles(change: Partial<TileSettings>) {
  Object.assign(tiles, change);
  try { localStorage.setItem(KEY, JSON.stringify(tiles)); } catch { /* storage unavailable */ }
}
const tileUrl = (id: MapId, z: number, x: number, y: number) =>
  tiles.style === 'topo'
    ? `${import.meta.env.BASE_URL}local-data/topo/${id}/${z}/${x}_${y}.png`
    : `${ROOT}/${id}/zoom_${z}/${x}_${y}.webp`;
const infos = new Map<MapId, Promise<MapInfo | null>>();
const images = new Map<string, HTMLImageElement>();

/** The map description, or null when the map data was not downloaded. */
export function mapInfo(id: MapId): Promise<MapInfo | null> {
  let p = infos.get(id);
  if (!p) {
    p = fetch(`${ROOT}/${id}/map.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    infos.set(id, p);
  }
  return p;
}

/** A view of the map: game units to canvas pixels. */
export interface View { toPx: (x: number, y: number) => [number, number]; pxPerUnit: number; width: number; height: number }

/**
 * Draws the tiles that the view shows, at the zoom that matches its scale. Tiles that are still loading call
 * `redraw` once they arrive.
 */
export function drawTiles(g: CanvasRenderingContext2D, id: MapId, info: MapInfo, v: View, redraw: () => void) {
  const tb = info.tileBounds;
  const worldW = tb.maxX - tb.minX, worldH = tb.maxY - tb.minY;
  const maxZoom = tiles.style === 'topo' ? Math.min(info.maxZoom, TOPO_MAX_ZOOM) : info.maxZoom;
  const z = Math.max(0, Math.min(maxZoom, Math.round(Math.log2((v.pxPerUnit * worldW) / info.tileSize))));
  const n = 2 ** z, w = worldW / n, h = worldH / n;
  // the game-unit rectangle the canvas shows, clipped to the playable area
  const [x0, y1] = [unitX(0), unitY(0)], [x1, y0] = [unitX(v.width), unitY(v.height)];
  function unitX(px: number) { const a = v.toPx(0, 0)[0], b = v.toPx(1, 0)[0]; return (px - a) / (b - a); }
  function unitY(py: number) { const a = v.toPx(0, 0)[1], b = v.toPx(0, 1)[1]; return (py - a) / (b - a); }
  const left = Math.max(x0, info.bounds.minX), right = Math.min(x1, info.bounds.maxX);
  const bottom = Math.max(y0, info.bounds.minY), top = Math.min(y1, info.bounds.maxY);
  if (left >= right || bottom >= top) return;
  const tx0 = Math.max(0, Math.floor((left - tb.minX) / w)), tx1 = Math.min(n - 1, Math.floor((right - tb.minX) / w));
  const ty0 = Math.max(0, Math.floor((tb.maxY - top) / h)), ty1 = Math.min(n - 1, Math.floor((tb.maxY - bottom) / h));
  g.save();
  const [cl, ct] = v.toPx(info.bounds.minX, info.bounds.maxY), [cr, cb] = v.toPx(info.bounds.maxX, info.bounds.minY);
  g.beginPath(); g.rect(cl, ct, cr - cl, cb - ct); g.clip();
  g.globalAlpha = tiles.opacity;
  if (tiles.style === 'gray') g.filter = 'grayscale(1)';
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
    const url = tileUrl(id, z, tx, ty);
    let img = images.get(url);
    if (!img) {
      img = new Image();
      img.onload = redraw;
      img.src = url;
      images.set(url, img);
    }
    if (!img.complete || !img.naturalWidth) continue;
    const [px, py] = v.toPx(tb.minX + tx * w, tb.maxY - ty * h);
    const [qx, qy] = v.toPx(tb.minX + (tx + 1) * w, tb.maxY - (ty + 1) * h);
    g.drawImage(img, px, py, qx - px + 0.5, qy - py + 0.5); // half a pixel of overlap hides the seams
  }
  g.restore();
}
