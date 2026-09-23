import { describe, expect, test } from 'bun:test';
import { missing, openPhases } from '../../src/lib/state/missing.ts';
import { sceneProject } from '../synthetic/project.ts';
import { makeScene } from '../synthetic/scene.ts';

const tr = makeScene();
const CLIPS = [{ id: 'clip', name: 'Clip 1' }];

describe('missing', () => {
  test('a complete project needs nothing', () => {
    expect(missing(sceneProject(tr, { n: 15 }), CLIPS)).toEqual({ record: [], mark: [], coordinates: [], warnings: [] });
  });

  test('names what each phase lacks', () => {
    const p = sceneProject(tr, { n: 1, impact: false });
    p.sightings[0].shell = undefined;
    p.shots[0].crater = {};
    const m = missing(p, []);
    expect(m.record).toEqual(['Record or upload a clip.']);
    expect(m.mark).toContain('Shot 1 has 1 sighting(s) without a shell mark.');
    expect(m.mark).toContain('Shot 1 has 1 sighting(s) and needs 2.');
    expect(m.mark).toContain('Shot 1 has no impact mark in 1 clip(s). Mark the frame where the shell lands.');
    expect(m.coordinates).toEqual(['The crater of Shot 1 has no X and Y.']);
  });

  test('a phase opens only when every phase before it is done', () => {
    const p = sceneProject(tr, { n: 15 });
    expect(openPhases(missing(p, CLIPS))).toEqual([true, true, true, true]);
    expect(openPhases(missing(p, []))).toEqual([true, false, false, false]);
    p.shots[0].crater = {};
    expect(openPhases(missing(p, CLIPS))).toEqual([true, true, true, false]);
    p.sightings[3].shell = undefined;
    expect(openPhases(missing(p, CLIPS))).toEqual([true, true, false, false]);
  });

  test('a sighting left out of the calculation does not block a phase', () => {
    const p = sceneProject(tr, { n: 15 });
    p.sightings[3].shell = undefined;
    expect(openPhases(missing(p, CLIPS))[2]).toBe(false);
    p.sightings[3].excluded = true;
    expect(openPhases(missing(p, CLIPS))).toEqual([true, true, true, true]);
  });
});
