import { describe, expect, test } from 'bun:test';
import { centered, dirTo, focalPx, pitchFromEdge, project, rayWorld } from '../../src/lib/solver/camera.ts';
import { BALLISTICS, landing, simulate } from '../../src/lib/solver/ballistics.ts';
import { seeded } from '../../src/lib/solver/montecarlo.ts';
import { fuse, solveProject } from '../../src/lib/solver/result.ts';
import { EYE_HEIGHT_M, SightingSolver, craterGame } from '../../src/lib/solver/sightings.ts';
import { solveShot } from '../../src/lib/solver/solve.ts';
import { intersectTracks, minCrossingAngle } from '../../src/lib/solver/tracks.ts';
import type { Ray } from '../../src/lib/solver/types.ts';
import { sceneProject } from '../synthetic/project.ts';
import { makeScene, shellPx } from '../synthetic/scene.ts';

const tr = makeScene();
const dist = (a: { x: number; y: number }, b: number[]) => Math.hypot(a.x - b[0], a.y - b[1]);

describe('camera', () => {
  test('focal length for horizontal and vertical FOV', () => {
    expect(focalPx(1280, 720, 90, 'h')).toBeCloseTo(640, 9);
    expect(focalPx(1280, 720, 90, 'v')).toBeCloseTo(360, 9);
  });

  test('a projected point comes back as the same ray', () => {
    const P: [number, number, number] = [2500, 4300, 300];
    const px = project(P, tr.O, tr.W, tr.H, tr.f, tr.camH, tr.camP)!;
    const d = rayWorld(centered(px, tr.W, tr.H), tr.f, tr.camH, tr.camP);
    const want = dirTo(tr.O, P);
    for (let i = 0; i < 3; i++) expect(d[i]).toBeCloseTo(want[i], 9);
  });

  test('pitch from a vertical edge is exact', () => {
    for (const [a, b] of tr.edges) {
      expect(pitchFromEdge(centered(a, tr.W, tr.H), centered(b, tr.W, tr.H), tr.f)!).toBeCloseTo(tr.camP, 6);
    }
  });
});

/** Exact rays from the truth, every 0.5 s of the flight. They start above the crater, as the solver assumes. */
function exactRays(tr = makeScene()): Ray[] {
  const rays: Ray[] = [];
  const O: [number, number, number] = [tr.C[0], tr.C[1], tr.C[2] + EYE_HEIGHT_M];
  for (let t = tr.fireTime + 0.5; t < tr.impactTime - 0.2; t += 0.5) {
    const px = shellPx(tr, t)!;
    rays.push({ O, D: rayWorld(centered(px, tr.W, tr.H), tr.f, tr.camH, tr.camP), tau: tr.impactTime - t, clip: 'clip' });
  }
  return rays;
}
const opt = { center: null, tol: 30, zGun: tr.G[2], rmin: 600, rmax: 2600, useRange: true, ballistics: BALLISTICS.L52 };

describe('ballistics', () => {
  const maxRange = (b: typeof BALLISTICS.L52) => {
    let best = 0;
    for (let e = b.elevMinDeg; e <= b.elevMaxDeg; e += 0.25) best = Math.max(best, landing(simulate(b, e), 0)?.R ?? 0);
    return best;
  };
  const flightTime = (b: typeof BALLISTICS.L52, e: number) => landing(simulate(b, e), 0)!.T;

  test('the fitted drag gives the ranges of the community firing tables', () => {
    expect(Math.abs(maxRange(BALLISTICS.L52) - 2629)).toBeLessThan(15);
    expect(Math.abs(maxRange(BALLISTICS.L81) - 691)).toBeLessThan(10);
  });

  test('the flight times agree with the published ones', () => {
    // L52 at 2000 m: about 13.9 deg (low arc, 12.3 s published) and 61.4 deg (high arc, 33 s published)
    expect(Math.abs(landing(simulate(BALLISTICS.L52, 13.9), 0)!.R - 2000)).toBeLessThan(20);
    expect(Math.abs(flightTime(BALLISTICS.L52, 13.9) - 12.3)).toBeLessThan(1);
    expect(Math.abs(flightTime(BALLISTICS.L52, 61.4) - 33)).toBeLessThan(1.5);
    // L81 at 400 m: about 72 deg, 17.4 s published
    expect(Math.abs(flightTime(BALLISTICS.L81, 72) - 17.4)).toBeLessThan(1);
  });
});

describe('ballistic model', () => {
  const l81 = makeScene({ weapon: 'L81' });
  const cases: [string, typeof tr, number, typeof BALLISTICS.L52][] = [
    ['L52, 2 sightings', tr, 2, BALLISTICS.L52],
    ['L52, 5 sightings', tr, 5, BALLISTICS.L52],
    ['L81, 2 sightings', l81, 2, BALLISTICS.L81],
    ['L81, 5 sightings', l81, 5, BALLISTICS.L81],
  ];
  for (const [name, scene, n, b] of cases) {
    test(`${name} find the gun within 2 m and where the user stood from exact data`, () => {
      const all = exactRays(scene);
      const rays = Array.from({ length: n }, (_, i) => all[Math.round((i * (all.length - 1)) / Math.max(1, n - 1))]);
      const r = solveShot(rays, scene.C, { center: null, tol: 30, zGun: scene.G[2], rmin: 0, rmax: 5000, useRange: false, ballistics: b });
      if (r.error !== undefined) throw new Error(r.error);
      expect(dist(r.gun, scene.G)).toBeLessThan(2);
      const [dx, dy] = r.fit.shifts.clip;
      expect(Math.hypot(scene.C[0] + dx - scene.O[0], scene.C[1] + dy - scene.O[1])).toBeLessThan(2);
    });
  }

  test('a suspected heading limits the search', () => {
    const back = (tr.dirDeg + 180) % 360;
    const near = solveShot(exactRays(), tr.C, { ...opt, center: back + 10, tol: 20 });
    if (near.error !== undefined) throw new Error(near.error);
    expect(dist(near.gun, tr.G)).toBeLessThan(2);
    // a wrong heading with a small tolerance gives no good fit
    const wrong = solveShot(exactRays(), tr.C, { ...opt, center: back + 90, tol: 10 });
    if (wrong.error === undefined) expect(wrong.fit.rms).toBeGreaterThan(1);
  });

  test('too few sightings is an error, not a guess', () => {
    expect(solveShot(exactRays().slice(0, 1), tr.C, opt).error).toContain('2 or more');
  });
});

describe('sightings', () => {
  test('edges and the compass heading reproduce the true camera', () => {
    const data = sceneProject(tr, { n: 5 });
    const s = new SightingSolver(data).solve(data.sightings[2]);
    if (!s.ok) throw new Error(s.error);
    expect(s.cam.h).toBeCloseTo(tr.camH, 5);
    expect(s.cam.p).toBeCloseTo(tr.camP, 5);
    // the 110 px edges of the scene really give about +/-1 deg each, so the pitch is only good to about +/-0.7 deg
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toContain('only accurate to');
  });

  test('a rangefinder reading puts the crater at the heading and distance from where the user stood', () => {
    const shot = { id: 's', name: 'Shot 1', impactTimeS: {}, crater: { from: { x: 10, y: 20, headingDeg: 90, distanceM: 500 } } };
    expect(craterGame(shot)!.x).toBeCloseTo(15, 9);
    expect(craterGame(shot)!.y).toBeCloseTo(20, 9);
    shot.crater.from.headingDeg = 0;
    expect(craterGame(shot)!.y).toBeCloseTo(25, 9);
    expect(craterGame({ ...shot, crater: { from: { x: 10, y: 20, headingDeg: 90 } } })).toBeNull();
  });

  test('a zoomed frame gives the same directions when its marks are zoomed too', () => {
    const data = sceneProject(tr, { n: 3 });
    const s = data.sightings[1], plain = new SightingSolver(data).aim(s);
    // the same camera through a 4x zoom: every mark lies 4 times as far from the center of the frame
    const zoom = (p: { x: number; y: number }) => ({ x: tr.W / 2 + (p.x - tr.W / 2) * 4, y: tr.H / 2 + (p.y - tr.H / 2) * 4 });
    Object.assign(s, { zoom: 4, shell: zoom(s.shell!), edges: s.edges.map(([a, b]) => [zoom(a), zoom(b)]) });
    const zoomed = new SightingSolver(data).aim(s);
    if (!plain.ok || !zoomed.ok) throw new Error('no aim');
    expect(zoomed.az).toBeCloseTo(plain.az, 6);
    expect(zoomed.el).toBeCloseTo(plain.el, 6);
  });

  test('"same camera as previous" copies the earlier camera', () => {
    const data = sceneProject(tr, { n: 4 });
    for (const s of data.sightings.slice(1)) { s.edges = []; s.headingDeg = undefined; s.sameCameraAsPrevious = true; }
    const r = new SightingSolver(data).solve(data.sightings[3]);
    if (!r.ok) throw new Error(r.error);
    expect(r.cam.source).toBe('copied');
    expect(r.cam.h).toBeCloseTo(tr.camH, 5);
  });

  test('the solver reports missing data and bad edges', () => {
    const data = sceneProject(tr, { n: 3 });
    const s = data.sightings[0];
    const solver = () => new SightingSolver(data);
    s.headingDeg = undefined; s.edges = [];
    expect((solver().solve(s) as { error: string }).error).toContain('has no camera data');
    s.headingDeg = tr.camH;
    // a short edge near the center gives an imprecise pitch
    s.edges = [[{ x: 650, y: 400 }, { x: 650.5, y: 380 }]];
    expect(solver().solve(s).warnings[0]).toContain('only accurate to');
    // two edges 1 deg apart agree within their errors, and a strongly tilted third edge does not
    s.edges = [tr.edges[0], [tr.edges[1][0], { x: tr.edges[1][1].x + 25, y: tr.edges[1][1].y }]];
    expect(solver().solve(s).warnings.some((w) => w.includes('differs'))).toBe(false);
    s.edges = [tr.edges[0], tr.edges[1], [tr.edges[1][0], { x: tr.edges[1][1].x + 120, y: tr.edges[1][1].y }]];
    expect(solver().solve(s).warnings.some((w) => w.includes('Edge 3 differs'))).toBe(true);
    data.shots[0].impactTimeS = {};
    expect((solver().solve(s) as { error: string }).error).toContain('no impact mark');
    data.shots[0].impactTimeS = { clip: 100 };
    data.shots[0].crater = { x: 1 };
    expect((solver().solve(s) as { error: string }).error).toContain('The crater of this shot has no X and Y');
  });
});

describe('project', () => {
  test('exact data with 15 sightings gives the gun within 2 m and a Monte Carlo accuracy', () => {
    const r = solveProject(sceneProject(tr, { n: 15 }), seeded(1)).shots[0];
    expect(r.error).toBeUndefined();
    expect(dist(r.gun!, tr.G)).toBeLessThan(2);
    expect(r.mc.length).toBeGreaterThanOrEqual(10);
    expect(r.err90).toBeGreaterThan(0);
  });

  test('a shot left out of the calculation has no result', () => {
    const data = sceneProject(tr, { n: 15 });
    data.shots[0].excluded = true;
    const r = solveProject(data, seeded(1), 0).shots[0];
    expect(r.excluded).toBe(true);
    expect(r.gun).toBeUndefined();
  });

  test('a position from the minimap fixes where the user stood, and a copied camera copies it', () => {
    const data = sceneProject(tr, { n: 8 });
    data.sightings[0].position = { x: tr.O[0] / 100, y: tr.O[1] / 100 };
    for (const s of data.sightings.slice(1)) { s.edges = []; s.headingDeg = undefined; s.sameCameraAsPrevious = true; }
    const solver = new SightingSolver(data);
    expect(solver.position(data.sightings[5])).toEqual(data.sightings[0].position as { x: number; y: number });
    const r = solveProject(data, seeded(1), 0).shots[0];
    expect(dist(r.gun!, tr.G)).toBeLessThan(2);
  });

  test('the result shows where the user stood', () => {
    const r = solveProject(sceneProject(tr, { n: 15 }), seeded(1), 0).shots[0];
    expect(r.observers).toHaveLength(1);
    expect(dist({ x: r.observers[0][0], y: r.observers[0][1] }, tr.O)).toBeLessThan(2);
  });
});

describe('guns', () => {
  /** One project with a shot per scene, each in its own clip. */
  function shots(specs: Parameters<typeof makeScene>[0][]) {
    const parts = specs.map((sp, i) => {
      const p = sceneProject(makeScene(sp), { n: 8 });
      for (const x of p.sightings) { x.id += i; x.shotId = `shot${i}`; x.clipId = `clip${i}`; }
      p.shots[0] = { ...p.shots[0], id: `shot${i}`, name: `Shot ${i + 1}`, impactTimeS: { [`clip${i}`]: p.shots[0].impactTimeS.clip } };
      return p;
    });
    return { ...parts[0], shots: parts.flatMap((p) => p.shots), sightings: parts.flatMap((p) => p.sightings) };
  }

  test('shots of one gun combine into one gun', () => {
    const r = solveProject(shots([{ dirDeg: 60, rangeM: 1500 }, { dirDeg: 100, rangeM: 1800 }]), seeded(3));
    expect(r.guns).toHaveLength(1);
    expect(r.guns[0].shotIds).toHaveLength(2);
  });

  test('a shot from a gun 1.5 km away makes a second gun', () => {
    const r = solveProject(shots([{ dirDeg: 60, rangeM: 1500 }, { dirDeg: 100, rangeM: 1800 }, { gun: [4500, 4000, 0], dirDeg: 80, rangeM: 2100 }]), seeded(3));
    expect(r.guns.map((g) => g.shotIds.length).sort()).toEqual([1, 2]);
  });
});

describe('tracks', () => {
  test('two tracks cross at the gun', () => {
    const G = [3000, 4000];
    const track = (dir: number, r: number) => ({ x: G[0] + r * Math.sin((dir * Math.PI) / 180), y: G[1] + r * Math.cos((dir * Math.PI) / 180), th: (dir + 180) % 360 });
    const X = intersectTracks([track(60, 2000), track(150, 1200), track(100, 1700)])!;
    expect(dist(X, G)).toBeLessThan(1e-6);
  });

  test('parallel tracks have no crossing', () => {
    expect(intersectTracks([{ x: 0, y: 0, th: 10 }, { x: 100, y: 0, th: 190 }])).toBeNull();
  });

  test('combined shots take each coordinate from the shot that knows it best', () => {
    // one shot is sure of x only, the other of y only
    const X = fuse([{ x: 10, y: 500 }, { x: 900, y: 20 }], [[1, 0, 1e-6], [1e-6, 0, 1]])!;
    expect(X.x).toBeCloseTo(10, 2);
    expect(X.y).toBeCloseTo(20, 2);
  });

  test('crossing angle', () => {
    expect(minCrossingAngle([10, 20])).toBeCloseTo(10, 9);
    expect(minCrossingAngle([10, 185])).toBeCloseTo(5, 9);
    expect(minCrossingAngle([0, 90, 45])).toBeCloseTo(45, 9);
  });
});
