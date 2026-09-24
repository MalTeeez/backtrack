/**
 * Solves a project off the main thread, because 40 Monte Carlo runs take a moment. With terrain data, the solve also
 * rejects flights that run into the ground, and the result gets the slopes around the possible guns. The safe zones
 * of the gun follow in a second message, because they take longer.
 */
import { BALLISTICS, WEAPONS } from '../solver/ballistics.ts';
import { solveProject } from '../solver/result.ts';
import { anchorGame } from '../solver/sightings.ts';
import { value } from '../solver/field.ts';
import type { GroundAt, MapId, ProjectData } from '../solver/types.ts';
import { reach, slopeAt, slopeGrid, STEEP_DEG } from '../terrain/analysis.ts';
import { terrainHeights } from '../terrain/heights.ts';
import { Terrain } from '../terrain/terrain.ts';

const terrains = new Map<MapId, Promise<Terrain | null>>();
const terrainOf = (map: MapId) => {
  let t = terrains.get(map);
  if (!t) {
    t = Terrain.open(new URL(`${import.meta.env.BASE_URL}local-data/terrain/${map}/`, self.location.origin).href);
    terrains.set(map, t);
  }
  return t;
};

// the reach of the last guns, so an edit that does not move a gun does not compute it again
let safeKey = '', safeGrid: ReturnType<typeof reach> = null;

self.onmessage = async ({ data }: MessageEvent<{ token: number; project: ProjectData }>) => {
  try {
    // ponytail: one map per solve; the app solves the shots of one clip at a time
    const p = data.project, map = p.shots.map((s) => s.clipId && value(p.clips[s.clipId]?.map)).find(Boolean) || undefined;
    const rmax = Math.max(p.settings.rangeMaxM, ...Object.values(WEAPONS).map((w) => w.max));
    let heights, ground: string | undefined = 'The result assumes flat ground. Pick the map of the clip to use terrain heights.';
    let t: Terrain | null = null, at: GroundAt | undefined;
    if (map) {
      t = await terrainOf(map);
      if (t) {
        // everything the gun of each crater can reach, so the flights can be checked against the ground
        const margin = (rmax + 400) / 100;
        for (const s of p.shots) {
          const c = anchorGame(s);
          if (c) await t.preload(c.x - margin, c.y - margin, c.x + margin, c.y + margin);
        }
        const tt = t;
        at = (x, y) => tt.heightNow(x / 100, y / 100);
      }
      heights = t && (await terrainHeights((x, y) => t!.height(x, y), p, (h) => solveProject(p, Math.random, 0, h, at)));
      ground = !t
        ? 'The terrain data of this map is not downloaded (bun tools/fetch-map-data.ts). The result assumes flat ground.'
        : !heights
          ? 'A crater lies outside the terrain data. The result assumes flat ground.'
          : undefined; // terrain that works needs no note
    }
    const result = solveProject(p, Math.random, undefined, heights ?? undefined, heights ? at : undefined);

    if (heights && at) {
      // the slope around the possible guns, and which Monte Carlo guns stand on ground too steep for a gun
      for (const r of result.shots) {
        if (!r.gun || !r.mc.length) continue;
        for (const q of r.mc) q.steep = (slopeAt(at, q.x, q.y) ?? 0) > STEEP_DEG;
        const xs = [r.gun.x, ...r.mc.map((q) => q.x)], ys = [r.gun.y, ...r.mc.map((q) => q.y)];
        const pad = 150;
        r.slope = slopeGrid(at, Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad);
        const steep = r.mc.filter((q) => q.steep).length;
        if (steep) r.notes.push(`${steep} of ${r.mc.length} Monte Carlo guns stand on ground steeper than ${STEEP_DEG} deg, where a gun is unlikely.`);
      }
    }
    postMessage({ token: data.token, result: { ...result, ground } });

    // where the guns can hit: every gun the shots point to
    const guns = result.guns.map((g) => ({ x: g.x, y: g.y }));
    if (!t || !at || !heights || !guns.length) return;
    const key = `${map}:${result.weapon.use}:${rmax}:${guns.map((g) => `${Math.round(g.x / 5)},${Math.round(g.y / 5)}`).join(';')}`;
    if (key !== safeKey) {
      const m = (rmax + 200) / 100;
      for (const g of guns) await t.preload(g.x / 100 - m, g.y / 100 - m, g.x / 100 + m, g.y / 100 + m);
      safeGrid = reach(at, BALLISTICS[result.weapon.use], guns, p.settings.weapon ? p.settings.rangeMaxM : WEAPONS[result.weapon.use].max);
      safeKey = key;
    }
    if (safeGrid) postMessage({ token: data.token, safe: { grid: safeGrid, guns } });
  } catch (e) {
    postMessage({ token: data.token, error: (e as Error).message });
  }
};
