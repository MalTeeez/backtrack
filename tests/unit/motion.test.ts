import { describe, expect, test } from 'bun:test';
import { motionFlags } from '../../src/lib/solver/motion.ts';
import { randn, seeded } from '../../src/lib/solver/montecarlo.ts';
import { sceneProject } from '../synthetic/project.ts';
import { makeScene, shellPx } from '../synthetic/scene.ts';

/**
 * A run of 10 close frames (every 1/12 s, like a real recording) of one camera, with marks off by up to 1 px. With
 * `stallAt`, the frame times stay regular but from that frame on the picture is 0.25 s ahead, as after a stall.
 */
function run(seed: number, stallAt = -1) {
  const rng = seeded(seed), n = () => randn(rng);
  const tr = makeScene();
  const p = sceneProject(tr, { n: 2 });
  const first = p.sightings[0];
  p.sightings = [];
  for (let i = 0; i < 10; i++) {
    const t = tr.fireTime + tr.T * 0.8 + i / 12, px = shellPx(tr, t + (stallAt >= 0 && i >= stallAt ? 0.25 : 0))!;
    p.sightings.push({
      ...first, id: `s${i}`, timeS: t, shell: { x: px.x + n(), y: px.y + n() },
      edges: i ? [] : first.edges, headingDeg: i ? undefined : first.headingDeg, sameCameraAsPrevious: i > 0,
    });
  }
  return p;
}

describe('shell motion', () => {
  test('clean runs of close frames give no warning', () => {
    const flagged = Array.from({ length: 10 }, (_, k) => motionFlags(run(k)).length).filter((c) => c > 0).length;
    expect(flagged).toBeLessThanOrEqual(1);
  });

  test('a stall that puts the picture 0.25 s ahead is found at the jump', () => {
    const flags = motionFlags(run(1, 5));
    expect(flags.some((f) => f.from === 's4' && f.to === 's5' && f.ratio > 2.2)).toBe(true);
  });
});
