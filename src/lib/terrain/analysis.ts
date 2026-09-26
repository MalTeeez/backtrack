/**
 * What the terrain says beyond heights. It tells how steep the ground is where the gun might stand, and where the gun
 * can hit. Everything works in meters on a synchronous ground function (Terrain.heightNow after a preload). The terrain has no
 * buildings or trees, so a safe zone behind a house does not show.
 */
import { flights, heightAt, landing, simulate, type Ballistics } from '../solver/ballistics.ts';
import type { Grid, GroundAt } from '../solver/types.ts';

/** Slopes above this (deg) are too steep for a gun vehicle. */
export const STEEP_DEG = 15;

/** The slope (deg) at a point, from the heights 5 m to each side. Null without terrain there. */
export function slopeAt(ground: GroundAt, x: number, y: number): number | null {
  const h = 5;
  const e = ground(x + h, y), w = ground(x - h, y), n = ground(x, y + h), s = ground(x, y - h);
  if (e == null || w == null || n == null || s == null) return null;
  return (Math.atan(Math.hypot((e - w) / (2 * h), (n - s) / (2 * h))) * 180) / Math.PI;
}

/** The slope in whole degrees (255 without terrain) over a rectangle in meters, on cells of `cell` m. */
export function slopeGrid(ground: GroundAt, x0: number, y0: number, x1: number, y1: number, cell = 10): Grid {
  const w = Math.ceil((x1 - x0) / cell), h = Math.ceil((y1 - y0) / cell);
  const data = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const s = slopeAt(ground, x0 + (i + 0.5) * cell, y1 - (j + 0.5) * cell);
    data[j * w + i] = s == null ? 255 : Math.min(90, Math.round(s));
  }
  return { x0, y0: y1, cell, w, h, data };
}

/** Codes of the safe zone grid. */
export const REACH = { none: 0, low: 1, high: 2, safe: 3 } as const;

/**
 * Where the guns can hit. Each gun fires shells in every direction (0.4 deg apart) and at every elevation (0.1 deg
 * apart) over the terrain, and marks the cell where each shell comes down. Cells in range of a gun that no shell
 * reaches are out of reach. `low` means that a shell below the elevation of the longest range reaches the cell, and
 * `high` means that only steeper ones do. A small jump between neighboring elevations fills the cells between. A large
 * jump is a ridge with a shadow behind it. With several guns, a cell is as reachable as the gun that reaches it best.
 */
export function reach(ground: GroundAt, b: Ballistics, guns: { x: number; y: number }[], rmax: number, cell = 20): Grid | null {
  const placed = guns.map((g) => ({ ...g, z: ground(g.x, g.y) })).filter((g): g is { x: number; y: number; z: number } => g.z != null);
  if (!placed.length) return null;
  const STEP = 10, R = rmax + 100;
  const x0 = Math.min(...placed.map((g) => g.x)) - R, y0 = Math.max(...placed.map((g) => g.y)) + R;
  const w = Math.ceil((Math.max(...placed.map((g) => g.x)) + R - x0) / cell), h = Math.ceil((y0 - (Math.min(...placed.map((g) => g.y)) - R)) / cell);
  const grid: Grid = { x0, y0, cell, w, h, data: new Uint8Array(w * h) };
  const idx = (x: number, y: number) => {
    const i = Math.floor((x - grid.x0) / cell), j = Math.floor((grid.y0 - y) / cell);
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
  };

  // the elevation of the longest range on flat ground separates the low arcs from the high ones
  let eMax = b.elevMinDeg, best = 0;
  for (const f of flights(b, 0.5)) { const r = landing(f, 0)?.R ?? 0; if (r > best) { best = r; eMax = f.e; } }
  // a mortar only fires above that elevation, so all of its arcs count as one kind
  const oneKind = eMax <= b.elevMinDeg + 0.5;
  // Each flight keeps its height every STEP meters, so the fan needs no flight twice and keeps little memory.
  const steps = Math.ceil(R / STEP);
  const arcs: { low: boolean; z: Float32Array }[] = [];
  for (let e = b.elevMinDeg; e <= b.elevMaxDeg + 1e-9; e += 0.1) {
    const f = simulate(b, e), z = new Float32Array(steps);
    for (let k = 0; k < steps; k++) z[k] = heightAt(f, k * STEP);
    arcs.push({ low: oneKind || e < eMax, z });
  }
  // A mark never makes a cell safer. Low beats high, and high beats out of reach.
  const mark = (x: number, y: number, low: boolean) => {
    const k = idx(x, y);
    if (k < 0 || grid.data[k] === REACH.none) return;
    if (low) grid.data[k] = REACH.low;
    else if (grid.data[k] === REACH.safe) grid.data[k] = REACH.high;
  };

  const profile = new Float32Array(steps);
  for (const { x: gx, y: gy, z: zGun } of placed) {
    // cells in range of this gun and on the terrain start out of reach, unless another gun reaches them already
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const x = grid.x0 + (i + 0.5) * cell, y = grid.y0 - (j + 0.5) * cell;
      if (grid.data[j * w + i] === REACH.none && Math.hypot(x - gx, y - gy) <= best && ground(x, y) != null) grid.data[j * w + i] = REACH.safe;
    }
    for (let a = 0; a < 360; a += 0.4) {
      const dx = Math.sin((a * Math.PI) / 180), dy = Math.cos((a * Math.PI) / 180);
      for (let k = 0; k < steps; k++) profile[k] = ground(gx + k * STEP * dx, gy + k * STEP * dy) ?? -Infinity;
      let prev = -1, prevLow = false;
      for (const arc of arcs) {
        // the first step past the gun where the shell is below the ground
        let hit = -1;
        for (let k = 3; k < steps; k++) if (zGun + arc.z[k] < profile[k]) { hit = k; break; }
        if (hit < 0) { prev = -1; continue; }
        mark(gx + hit * STEP * dx, gy + hit * STEP * dy, arc.low);
        if (prev >= 0 && prevLow === arc.low && Math.abs(hit - prev) * STEP <= 3 * cell) {
          for (let k = Math.min(hit, prev) + 1; k < Math.max(hit, prev); k++) mark(gx + k * STEP * dx, gy + k * STEP * dy, arc.low);
        }
        prev = hit; prevLow = arc.low;
      }
    }
  }
  return grid;
}
