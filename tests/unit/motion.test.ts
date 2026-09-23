import { describe, expect, test } from 'bun:test';
import { motionFlags } from '../../src/lib/solver/motion.ts';
import { randn, seeded } from '../../src/lib/solver/montecarlo.ts';
import { sceneProject } from '../synthetic/project.ts';
import { makeScene, shellPx } from '../synthetic/scene.ts';

/**
 * A run of 10 close frames (every 1/12 s, like a real recording) of one camera, with marks off by up to 1 px. With
 * `stallAt`, the frame times stay regular but from that frame on the picture is 0.25 s ahead, as after a stall. With
 * `repeatAt`, that frame shows the picture of the frame before it, as a repeated frame. The run starts at `from` of the
 * flight time.
 */
function run(seed: number, stallAt = -1, repeatAt = -1, from = 0.8) {
  const rng = seeded(seed), n = () => randn(rng);
  const tr = makeScene();
  const p = sceneProject(tr, { n: 2 });
  const first = p.sightings[0];
  p.sightings = [];
  for (let i = 0; i < 10; i++) {
    const t = tr.fireTime + tr.T * from + i / 12;
    const px = shellPx(tr, t + (stallAt >= 0 && i >= stallAt ? 0.25 : 0) - (i === repeatAt ? 1 / 12 : 0))!;
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

  test('a repeated frame is flagged on that frame only', () => {
    // late in the flight, where the shell moves fast enough for one frame to show beyond the mark errors
    const flags = motionFlags(run(1, -1, 5, 0.9));
    // the shell stands still into the repeated frame; the catch-up step after it is only twice as fast, and the
    // neighbors judge the later steps without the broken one
    expect(flags.map((f) => [f.to, f.ratio < 1 / 2.2])).toEqual([['s5', true]]);
  });
});
