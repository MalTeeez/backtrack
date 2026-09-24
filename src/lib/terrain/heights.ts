/**
 * Ground heights for a project from terrain data (docs/terrain-plan.md). The craters sample the terrain directly. The gun height depends on the gun position, which the solve finds: the loop solves with a gun height,
 * samples the terrain at the gun, and solves again, until the height changes by less than 0.5 m (at most 4 rounds).
 */
import { GAME_UNIT_M, anchorGame, observerGame } from '../solver/sightings.ts';
import type { ProjectResult } from '../solver/result.ts';
import type { Heights, ProjectData } from '../solver/types.ts';

/** The ground height (m) at a game point, or null without data there. */
export type Ground = (x: number, y: number) => Promise<number | null>;

/** Null when a crater has no terrain data: the solve then keeps flat ground for everything. */
export async function terrainHeights(ground: Ground, data: ProjectData, solve: (h: Heights) => ProjectResult): Promise<Heights | null> {
  const h: Heights = { crater: {}, gun: {}, observer: {} };
  for (const shot of data.shots) {
    const c = anchorGame(shot);
    if (!c) continue;
    const z = await ground(c.x, c.y);
    if (z == null) return null;
    h.crater[shot.id] = h.gun[shot.id] = z; // the first round puts the gun as high as the crater
    const o = observerGame(shot);
    h.observer![shot.id] = (o && (await ground(o.x, o.y))) ?? z; // where the minimap puts the user, or the crater
  }
  for (let round = 0; round < 4; round++) {
    let moved = 0;
    // the solved spots: where the user stood, and the crater when only the user's spot was known
    const refine = async (key: 'observer' | 'crater', id: string, p?: number[]) => {
      const z = p && (await ground(p[0] / GAME_UNIT_M, p[1] / GAME_UNIT_M));
      if (z == null) return;
      moved = Math.max(moved, Math.abs(z - (h[key]![id] ?? z)));
      h[key]![id] = z;
    };
    for (const r of solve(h).shots) {
      await refine('observer', r.shotId, r.observers[0]);
      if (r.crater) await refine('crater', r.shotId, r.C);
      if (!r.gun) continue;
      const z = await ground(r.gun.x / GAME_UNIT_M, r.gun.y / GAME_UNIT_M);
      if (z == null) continue; // a gun outside the data keeps its last height
      moved = Math.max(moved, Math.abs(z - h.gun[r.shotId]));
      h.gun[r.shotId] = z;
    }
    if (moved < 0.5) break;
  }
  return h;
}
