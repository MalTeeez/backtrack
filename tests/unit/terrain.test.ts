import { describe, expect, test } from 'bun:test';
import { seeded } from '../../src/lib/solver/montecarlo.ts';
import { solveProject } from '../../src/lib/solver/result.ts';
import { BALLISTICS } from '../../src/lib/solver/ballistics.ts';
import { reach, REACH, slopeAt } from '../../src/lib/terrain/analysis.ts';
import { terrainHeights } from '../../src/lib/terrain/heights.ts';
import { Terrain, type Manifest } from '../../src/lib/terrain/terrain.ts';
import { sceneProject } from '../synthetic/project.ts';
import { makeScene } from '../synthetic/scene.ts';

describe('terrain data', () => {
  // one chunk of 3 x 3 samples over game (0..2, 0..2): 1 game unit per sample, landscape rows run south
  const manifest: Manifest = {
    chunkXMin: 0, chunkXMax: 0, chunkYMin: 0, chunkYMax: 0, chunkQuads: 2, verticesPerSide: 3,
    globalQuadOffsetX: 0, globalQuadOffsetY: 2, gameUnitsToLandscapeQuadsX: 1, gameUnitsToLandscapeQuadsY: -1,
    worldZOffsetMeters: 0.5, worldZScaleMetersPerLocalUnit: 9,
    coverage: { gameXMin: 0, gameXMax: 2, gameYMin: 0, gameYMax: 2 },
    chunks: { '0,0': { file: 'c.bin', minLocalZ: 0, maxLocalZ: 10 } },
  };
  // raw 0 is local z 0 (0.5 m), raw 65535 is local z 10 (90.5 m); the north-west sample is the highest
  const raw = [65535, 0, 0, 0, 0, 0, 0, 0, 0];
  const bytes = new Uint8Array(new Uint16Array(raw).buffer);
  const t = new Terrain(manifest, async (p) => (p === 'c.bin' ? bytes.buffer.slice(0) : null));

  test('decodes samples to meters', async () => {
    expect(await t.height(0, 2)).toBeCloseTo(90.5, 6); // north-west corner
    expect(await t.height(2, 0)).toBeCloseTo(0.5, 6);
  });

  test('interpolates between samples', async () => {
    expect(await t.height(0.5, 2)).toBeCloseTo((90.5 + 0.5) / 2, 6);
    expect(await t.height(0.5, 1.5)).toBeCloseTo((90.5 + 0.5 * 3) / 4, 6);
  });

  test('has no height outside its coverage', async () => {
    expect(await t.height(5, 1)).toBeNull();
  });
});

describe('terrain heights', () => {
  // a slope rising 5 m per 100 m to the east: the crater lies about 87 m above the gun
  const slope = (x: number) => 0.05 * (x - 3000);
  const tr = makeScene({ ground: (x) => slope(x) });
  const data = sceneProject(tr, { n: 15 });
  const ground = async (x: number) => slope(x * 100);
  const dist = (g: { x: number; y: number } | null | undefined) => (g ? Math.hypot(g.x - tr.G[0], g.y - tr.G[1]) : Infinity);

  test('with terrain heights, exact data gives the gun within 2 m on sloped ground', async () => {
    const h = (await terrainHeights(ground, data, (hh) => solveProject(data, seeded(1), 0, hh)))!;
    expect(h.gun.shot).toBeCloseTo(tr.G[2], 0);
    expect(dist(solveProject(data, seeded(1), 0, h).shots[0].gun)).toBeLessThan(2);
  });

  test('the terrain check keeps the right flight on sloped ground', async () => {
    // the check launches each candidate from the ground at its own gun, not from the gun height of the last round
    const h = (await terrainHeights(ground, data, (hh) => solveProject(data, seeded(1), 0, hh)))!;
    const r = solveProject(data, seeded(1), 0, h, (x, y) => slope(x)).shots[0];
    expect(dist(r.gun)).toBeLessThan(2);
  });

  test('flat ground misses the gun on the same slope', () => {
    expect(dist(solveProject(data, seeded(1), 0).shots[0].gun)).toBeGreaterThan(20);
  });

  test('a user on a roof: the ground where the minimap puts the user sets the rays, not the crater', async () => {
    // a 15 m block under the user, 40 m from the crater
    const O0 = makeScene().O, roof = (x: number, y: number) => (Math.hypot(x - O0[0], y - O0[1]) < 15 ? 15 : 0);
    const tr = makeScene({ ground: roof }), data = sceneProject(tr, { n: 15 });
    // a small roof needs the minimap position: from the crater height, the solve puts the user 40 m off the block
    data.shots[0].observer.clip = { manual: { x: tr.O[0] / 100, y: tr.O[1] / 100 } };
    const h = (await terrainHeights(async (x, y) => roof(x * 100, y * 100), data, (hh) => solveProject(data, seeded(1), 0, hh)))!;
    expect(h.observer!.shot).toBe(15);
    const d = (hh?: typeof h) => { const g = solveProject(data, seeded(1), 0, hh).shots[0].gun!; return Math.hypot(g.x - tr.G[0], g.y - tr.G[1]); };
    expect(d(h)).toBeLessThan(2);
    expect(d({ ...h, observer: undefined })).toBeGreaterThan(2 * d(h));
  });

  test('a walk down a slope: each sighting starts at the ground of its frame', async () => {
    // 1.5 m/s west down a 20 percent slope that runs east-west through the spot of the user: 0.3 m lower per second
    const O0 = makeScene().O, hill = (x: number) => 0.2 * (x - O0[0]);
    const wt = makeScene({ ground: (x) => hill(x), walk: [-1.5, 0], craterZ: hill(makeScene().C[0]) }), data = sceneProject(wt, { n: 15, last: 3, walk: 'exact' });
    data.shots[0].observer.clip = { manual: { x: wt.O[0] / 100, y: wt.O[1] / 100 } };
    const h = (await terrainHeights(async (x) => hill(x * 100), data, (hh) => solveProject(data, seeded(1), 0, hh)))!;
    const d = (hh?: typeof h) => { const g = solveProject(data, seeded(1), 0, hh).shots[0].gun!; return Math.hypot(g.x - wt.G[0], g.y - wt.G[1]); };
    expect(Object.keys(h.walk!)).toHaveLength(15);
    expect(d(h)).toBeLessThan(2);
    expect(d({ ...h, walk: undefined })).toBeGreaterThan(d(h));
  });

  test('a position outside the terrain data means flat ground', async () => {
    expect(await terrainHeights(async () => null, data, (hh) => solveProject(data, seeded(1), 0, hh))).toBeNull();
  });
});

describe('terrain analysis', () => {
  const count = (g: { data: Uint8Array }, v: number) => g.data.filter((x) => x === v).length;

  test('on flat ground the L52 reaches everything in range with its low arc', () => {
    const g = reach(() => 0, BALLISTICS.L52, [{ x: 0, y: 0 }], 2600)!;
    expect(count(g, REACH.safe) + count(g, REACH.high)).toBeLessThan(count(g, REACH.low) * 0.01);
  });

  test('a wall shadows the ground behind it and not the ground on the other side', () => {
    // 100 m high, 500 to 520 m east of the gun
    const wall = (x: number, y: number) => (x > 500 && x < 520 && Math.abs(y) < 200 ? 100 : 0);
    const g = reach(wall, BALLISTICS.L52, [{ x: 0, y: 0 }], 2600)!;
    const at = (x: number, y: number) => g.data[Math.floor((g.y0 - y) / g.cell) * g.w + Math.floor((x - g.x0) / g.cell)];
    expect(at(560, 0)).toBe(REACH.safe);
    expect(at(-560, 0)).toBe(REACH.low);
  });

  test('the slope of a 10 percent ramp is about 5.7 deg', () => {
    expect(slopeAt((x) => 0.1 * x, 0, 0)).toBeCloseTo(5.71, 1);
  });

  test('flat terrain changes nothing for a flight that clears it', () => {
    const tr = makeScene();
    const data = sceneProject(tr, { n: 15 });
    const g0 = solveProject(data, seeded(1), 0).shots[0].gun!;
    const g1 = solveProject(data, seeded(1), 0, undefined, () => 0).shots[0].gun!;
    expect(Math.hypot(g1.x - g0.x, g1.y - g0.y)).toBeLessThan(0.5);
  });
});
