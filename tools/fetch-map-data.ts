/**
 * Downloads the map imagery (color tiles) and the terrain chunks of the WARDOGS maps from the wardogs-calculator
 * hosting into local-data/, for personal use. local-data/ stays out of git and out of the build (vite.config.ts).
 * The script skips files that exist, so a second run resumes. Run it with `bun tools/fetch-map-data.ts [--dry]`.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = 'https://assets.wardogs-artillery.com/releases/assets-v1';
const OUT = join(import.meta.dir, '..', 'local-data');
const MAX_ZOOM = 6; // about 1 m per pixel
const CONCURRENCY = 3;
const PAUSE_MS = 150;
const DRY = process.argv.includes('--dry');

/** From maps/<id>.json of wardogs-calculator: the playable area and the extent of the tile pyramid, in game units. */
const MAPS = {
  bakurani: { name: 'Bakurani', bounds: { minX: 23.35, maxX: 133.6, minY: 19.34, maxY: 129.65 } },
  ozeti: { name: 'Ozeti', bounds: { minX: 57.58, maxX: 143.07, minY: 21.81, maxY: 99.56 } },
  zestafona: { name: 'Zestafona', bounds: { minX: 19.9, maxX: 124.89, minY: 50.7, maxY: 141.9 } },
};
const TILE_BOUNDS = { minX: -0.03, maxX: 163.81, minY: -0.01, maxY: 163.83 };
const TILE_SIZE = 256;

interface Job { url: string; file: string }

/** Tiles of zoom z that overlap the playable area. x counts from minX, y from maxY (the top). */
function tileJobs(id: string, b: (typeof MAPS)['bakurani']['bounds']): Job[] {
  const jobs: Job[] = [];
  for (let z = 0; z <= MAX_ZOOM; z++) {
    const n = 2 ** z;
    const w = (TILE_BOUNDS.maxX - TILE_BOUNDS.minX) / n, h = (TILE_BOUNDS.maxY - TILE_BOUNDS.minY) / n;
    const x0 = Math.max(0, Math.floor((b.minX - TILE_BOUNDS.minX) / w)), x1 = Math.min(n - 1, Math.floor((b.maxX - TILE_BOUNDS.minX) / w));
    const y0 = Math.max(0, Math.floor((TILE_BOUNDS.maxY - b.maxY) / h)), y1 = Math.min(n - 1, Math.floor((TILE_BOUNDS.maxY - b.minY) / h));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      jobs.push({ url: `${BASE}/maps/tiles-color/${id}/zoom_${z}/${x}_${y}.webp`, file: join(OUT, 'maps', id, `zoom_${z}`, `${x}_${y}.webp`) });
    }
  }
  return jobs;
}

interface Manifest {
  chunkXMin: number; chunkXMax: number; chunkYMin: number; chunkYMax: number; chunkQuads: number;
  globalQuadOffsetX: number; globalQuadOffsetY: number; gameUnitsToLandscapeQuadsX: number; gameUnitsToLandscapeQuadsY: number;
  chunks: Record<string, { file: string }>;
}

/** Terrain chunks under the playable area, with one chunk of margin (the mapping of docs/terrain-plan.md). */
function chunkJobs(id: string, m: Manifest, b: (typeof MAPS)['bakurani']['bounds']): Job[] {
  const chunk = (gx: number, gy: number) => [
    Math.floor((m.globalQuadOffsetX + gx * m.gameUnitsToLandscapeQuadsX) / m.chunkQuads),
    Math.floor((m.globalQuadOffsetY + gy * m.gameUnitsToLandscapeQuadsY) / m.chunkQuads),
  ];
  const corners = [chunk(b.minX, b.minY), chunk(b.maxX, b.maxY)];
  const cx0 = Math.max(m.chunkXMin, Math.min(corners[0][0], corners[1][0]) - 1), cx1 = Math.min(m.chunkXMax, Math.max(corners[0][0], corners[1][0]) + 1);
  const cy0 = Math.max(m.chunkYMin, Math.min(corners[0][1], corners[1][1]) - 1), cy1 = Math.min(m.chunkYMax, Math.max(corners[0][1], corners[1][1]) + 1);
  const jobs: Job[] = [];
  for (let x = cx0; x <= cx1; x++) for (let y = cy0; y <= cy1; y++) {
    const entry = m.chunks[`${x},${y}`];
    if (entry) jobs.push({ url: `${BASE}/data/terrain/${id}/${entry.file}`, file: join(OUT, 'terrain', id, entry.file) });
  }
  return jobs;
}

const have = (f: string) => existsSync(f) && statSync(f).size > 0;

async function fetchTo(job: Job) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(job.url);
    if (res.ok) {
      mkdirSync(dirname(job.file), { recursive: true });
      await Bun.write(job.file, await res.arrayBuffer());
      return;
    }
    if (res.status === 404) return; // a tile with no imagery
    await Bun.sleep(1000 * attempt);
  }
  throw new Error(`${job.url} failed three times`);
}

const jobs: Job[] = [];
for (const [id, map] of Object.entries(MAPS)) {
  const manifestFile = join(OUT, 'terrain', id, 'manifest.json');
  if (!have(manifestFile)) await fetchTo({ url: `${BASE}/data/terrain/${id}/manifest.json`, file: manifestFile });
  const manifest: Manifest = await Bun.file(manifestFile).json();
  await Bun.write(join(OUT, 'maps', id, 'map.json'), JSON.stringify({ id, name: map.name, bounds: map.bounds, tileBounds: TILE_BOUNDS, tileSize: TILE_SIZE, maxZoom: MAX_ZOOM }, null, 2));
  const t = tileJobs(id, map.bounds), c = chunkJobs(id, manifest, map.bounds);
  console.log(`${map.name}: ${t.length} tiles, ${c.length} terrain chunks`);
  jobs.push(...t, ...c);
}
const todo = jobs.filter((j) => !have(j.file));
console.log(`${jobs.length} files, ${todo.length} still to fetch`);
if (DRY) process.exit(0);

let done = 0, failed = 0;
async function worker() {
  for (let job = todo.shift(); job; job = todo.shift()) {
    try { await fetchTo(job); } catch (e) { failed++; console.error((e as Error).message); }
    if (++done % 100 === 0) console.log(`${done} fetched`);
    await Bun.sleep(PAUSE_MS);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`Done: ${done} fetched, ${failed} failed.`);
