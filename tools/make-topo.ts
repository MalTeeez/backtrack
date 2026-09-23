/**
 * Renders topographic map tiles from the downloaded terrain (tools/fetch-map-data.ts): shaded relief with height tints
 * and contour lines, in the same tile pyramid as the color imagery (src/lib/map/tiles.svelte.ts). The tiles go to
 * local-data/topo/<id>/<z>/<x>_<y>.png, for personal use like the rest of local-data/.
 * Run it with `bun tools/make-topo.ts [map ...]`. It rebuilds every tile.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Manifest } from '../src/lib/terrain/terrain.ts';

const DATA = join(import.meta.dir, '..', 'local-data');
const MAX_ZOOM = 5; // about 2 m per pixel, the spacing of the terrain samples
const SIZE = 256;

interface MapJson {
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  tileBounds: { minX: number; maxX: number; minY: number; maxY: number };
}

/** The heights (m) of the playable area on the grid of the terrain samples (2 m), row by row from the north. */
function heightGrid(id: string, m: Manifest, b: MapJson['bounds']) {
  const q = (x: number, y: number) => [m.globalQuadOffsetX + x * m.gameUnitsToLandscapeQuadsX, m.globalQuadOffsetY + y * m.gameUnitsToLandscapeQuadsY];
  const [qx0, qy0] = q(b.minX, b.maxY).map(Math.floor), [qx1, qy1] = q(b.maxX, b.minY).map(Math.ceil);
  const w = qx1 - qx0 + 1, h = qy1 - qy0 + 1;
  const grid = new Float32Array(w * h).fill(NaN);
  const side = m.verticesPerSide;
  for (const [key, c] of Object.entries(m.chunks)) {
    const [cx, cy] = key.split(',').map(Number);
    const path = join(DATA, 'terrain', id, c.file);
    if (!existsSync(path)) continue; // fetch-map-data.ts only downloads the chunks of the playable area
    const f = readFileSync(path);
    const raw = new Uint16Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.length));
    for (let j = 0; j < side; j++) {
      const gy = cy * m.chunkQuads + j - qy0;
      if (gy < 0 || gy >= h) continue;
      for (let i = 0; i < side; i++) {
        const gx = cx * m.chunkQuads + i - qx0;
        if (gx < 0 || gx >= w) continue;
        grid[gy * w + gx] = m.worldZOffsetMeters + (c.minLocalZ + (raw[j * side + i] / 65535) * (c.maxLocalZ - c.minLocalZ)) * m.worldZScaleMetersPerLocalUnit;
      }
    }
  }
  /** The height at a game point, interpolated between the 4 samples around it. NaN outside the grid. */
  const at = (x: number, y: number) => {
    const [fx, fy] = q(x, y).map((v, k) => v - (k ? qy0 : qx0));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) return NaN;
    const tx = fx - x0, ty = fy - y0, i = y0 * w + x0;
    const top = grid[i] + (grid[i + 1] - grid[i]) * tx, bottom = grid[i + w] + (grid[i + w + 1] - grid[i + w]) * tx;
    return top + (bottom - top) * ty;
  };
  // the height range for the tints, without the extremes, from every 16th sample
  const sorted = grid.filter((v, i) => i % 16 === 0 && !Number.isNaN(v)).sort();
  return { at, lo: sorted[Math.floor(sorted.length * 0.01)], hi: sorted[Math.floor(sorted.length * 0.99)] };
}

/** Height tints from low to high: green lowland, tan hills, brown and gray mountains. */
const TINTS: [number, [number, number, number]][] = [
  [0, [120, 150, 100]], [0.3, [175, 180, 125]], [0.55, [200, 180, 140]], [0.8, [165, 135, 110]], [1, [225, 222, 215]],
];
function tint(f: number): [number, number, number] {
  f = Math.max(0, Math.min(1, f));
  for (let i = 1; i < TINTS.length; i++) {
    const [f1, c1] = TINTS[i];
    if (f <= f1) {
      const [f0, c0] = TINTS[i - 1], t = (f - f0) / (f1 - f0);
      return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * t) as [number, number, number];
    }
  }
  return TINTS.at(-1)![1];
}

/** Contour steps (m) that stay at least about 4 pixels apart on a 20 deg slope. */
const contourStep = (mPerPx: number) => [5, 10, 20, 50, 100, 200].find((s) => s / Math.tan((20 * Math.PI) / 180) / mPerPx >= 4) ?? 200;

function renderTile(hg: ReturnType<typeof heightGrid>, x0: number, y0: number, unitsPerPx: number): Buffer | null {
  const mPerPx = unitsPerPx * 100;
  // heights with a border of one pixel, for slopes and contours
  const N = SIZE + 2, h = new Float32Array(N * N);
  let any = false;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const v = hg.at(x0 + (i - 0.5) * unitsPerPx, y0 - (j - 0.5) * unitsPerPx);
    h[j * N + i] = v;
    if (!Number.isNaN(v)) any = true;
  }
  if (!any) return null;
  const step = contourStep(mPerPx), major = step * 5;
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let j = 1; j <= SIZE; j++) for (let i = 1; i <= SIZE; i++) {
    const c = h[j * N + i], o = ((j - 1) * SIZE + (i - 1)) * 4;
    if (Number.isNaN(c)) continue; // transparent outside the terrain
    const l = h[j * N + i - 1], r = h[j * N + i + 1], u = h[(j - 1) * N + i], d = h[(j + 1) * N + i];
    const ok = (v: number) => (Number.isNaN(v) ? c : v);
    // hillshade: light from the north-west, 45 deg above the horizon, with the slopes exaggerated 2 times
    const dzdx = ((ok(r) - ok(l)) / (2 * mPerPx)) * 2, dzdy = ((ok(u) - ok(d)) / (2 * mPerPx)) * 2;
    const n = Math.hypot(dzdx, dzdy, 1), L = [-0.5, 0.5, Math.SQRT1_2]; // toward the light, x east and y north
    const shade = Math.max(0, (-dzdx * L[0] - dzdy * L[1] + L[2]) / n) / L[2];
    let [R, G, B] = tint((c - hg.lo) / (hg.hi - hg.lo)).map((v) => v * (0.45 + 0.55 * Math.min(1.25, shade)));
    // a contour where this pixel and its right or lower neighbor lie on different sides of a step
    const crosses = (s: number) => [ok(r), ok(d)].some((v) => Math.floor(c / s) !== Math.floor(v / s));
    if (crosses(major)) [R, G, B] = [R * 0.35 + 50 * 0.65, G * 0.35 + 35 * 0.65, B * 0.35 + 20 * 0.65];
    else if (crosses(step)) [R, G, B] = [R * 0.7 + 70 * 0.3, G * 0.7 + 50 * 0.3, B * 0.7 + 30 * 0.3];
    rgba[o] = Math.min(255, R); rgba[o + 1] = Math.min(255, G); rgba[o + 2] = Math.min(255, B); rgba[o + 3] = 255;
  }
  return png(rgba, SIZE, SIZE);
}

// a minimal PNG encoder: 8-bit RGBA, no filters, one zlib stream
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b: Buffer) { let c = -1; for (const v of b) c = CRC[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}
function png(rgba: Buffer, w: number, h: number) {
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(rows, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['bakurani', 'ozeti', 'zestafona'];
for (const id of ids) {
  const started = performance.now();
  const m = JSON.parse(readFileSync(join(DATA, 'terrain', id, 'manifest.json'), 'utf8')) as Manifest;
  const mj = JSON.parse(readFileSync(join(DATA, 'maps', id, 'map.json'), 'utf8')) as MapJson;
  const hg = heightGrid(id, m, mj.bounds);
  const tb = mj.tileBounds, b = mj.bounds;
  let count = 0, bytes = 0;
  for (let z = 0; z <= MAX_ZOOM; z++) {
    const n = 2 ** z, w = (tb.maxX - tb.minX) / n, hh = (tb.maxY - tb.minY) / n;
    const x0 = Math.max(0, Math.floor((b.minX - tb.minX) / w)), x1 = Math.min(n - 1, Math.floor((b.maxX - tb.minX) / w));
    const y0 = Math.max(0, Math.floor((tb.maxY - b.maxY) / hh)), y1 = Math.min(n - 1, Math.floor((tb.maxY - b.minY) / hh));
    mkdirSync(join(DATA, 'topo', id, String(z)), { recursive: true });
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const file = renderTile(hg, tb.minX + x * w, tb.maxY - y * hh, w / SIZE);
      if (!file) continue;
      writeFileSync(join(DATA, 'topo', id, String(z), `${x}_${y}.png`), file);
      count++; bytes += file.length;
    }
  }
  writeFileSync(join(DATA, 'topo', id, 'topo.json'), JSON.stringify({ maxZoom: MAX_ZOOM, heightRange: [hg.lo, hg.hi] }, null, 2));
  console.log(`${id}: ${count} tiles, ${(bytes / 1e6).toFixed(0)} MB, heights ${hg.lo.toFixed(0)} to ${hg.hi.toFixed(0)} m, ${((performance.now() - started) / 1000).toFixed(0)} s`);
}
