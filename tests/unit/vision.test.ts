import { describe, expect, test } from 'bun:test';
import { trimEnds } from '../../src/lib/vision/shell.ts';
import { extrapolate } from '../../src/lib/vision/impact.ts';
import { fuseHeading } from '../../src/lib/vision/heading.ts';

describe('shell track', () => {
  // clip 1, shot 2: the first mark is on something else, 90 px off the slow shell (reference camera, px)
  const m = [[23.801, 2236.0, 1383.6], [23.884, 2159.7, 1330.7], [23.964, 2161.6, 1328.4], [24.052, 2162.7, 1326.8], [24.145, 2164.9, 1325.8], [24.243, 2166.5, 1324.2],
    [24.343, 2167.2, 1323.0], [24.443, 2169.5, 1322.0], [24.535, 2172.4, 1322.5], [24.626, 2175.4, 1322.6], [24.719, 2178.4, 1324.0], [24.811, 2181.8, 1326.5],
    [24.904, 2184.6, 1330.0], [24.989, 2191.6, 1338.3], [25.072, 2196.5, 1345.0], [25.156, 2201.9, 1353.1], [25.242, 2208.8, 1363.2], [25.322, 2215.4, 1376.4]];
  const times = m.map((x) => x[0]), at = (k: number) => ({ x: m[k][1], y: m[k][2] });

  test('a jump at the start or the end of a track cuts off what lies past it', () => {
    expect(trimEnds(m.map((_, i) => i), at, times)).toEqual(m.slice(1).map((_, i) => i + 1));
    // the same jump at the end: the track reversed in time
    const rev = [...m].reverse().map(([t, x, y]) => [50 - t, x, y]);
    expect(trimEnds(rev.map((_, i) => i), (k) => ({ x: rev[k][1], y: rev[k][2] }), rev.map((x) => x[0]))).toEqual(rev.slice(0, -1).map((_, i) => i));
  });

  test('a change of pace inside the track stays', () => {
    const inner = m.slice(1);
    expect(trimEnds(inner.map((_, i) => i), (k) => ({ x: inner[k][1], y: inner[k][2] }), inner.map((x) => x[0]))).toHaveLength(inner.length);
  });

  test('the track goes on along a parabola', () => {
    const p = (t: number) => ({ t, x: 100 + 50 * t + 20 * t * t, y: 300 - 10 * t });
    const q = extrapolate([p(0), p(0.1), p(0.2)], 0.5);
    expect(q.x).toBeCloseTo(p(0.5).x, 6);
    expect(q.y).toBeCloseTo(p(0.5).y, 6);
  });
});

describe('heading fusion', () => {
  test('display changes narrow the heading, and a misread drops out', () => {
    // the camera turns from yaw -0.6 to +0.6 against a reference that faces 196.3; the display truncates
    const readings = Array.from({ length: 13 }, (_, k) => { const yaw = -0.6 + 0.1 * k; return { shown: Math.floor(196.3 + yaw), yaw }; });
    readings.push({ shown: 186, yaw: 0 }); // a misread
    const h = fuseHeading(readings, 'floor')!;
    expect(h.used).toBe(13);
    expect(Math.abs(h.heading - 196.3)).toBeLessThan(0.06);
    expect(h.sigma).toBeLessThan(0.05);
    // one display value for all: an interval of a whole degree
    expect(fuseHeading([{ shown: 208, yaw: 0 }, { shown: 208, yaw: 0 }], 'floor')!.sigma).toBeCloseTo(1 / Math.sqrt(12), 6);
  });
});
