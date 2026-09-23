import { describe, expect, test } from 'bun:test';
import { annotation, applyAnnotation } from '../../src/lib/capture/annotation.ts';
import type { ClipMeta, ProjectData, Shot } from '../../src/lib/solver/types.ts';
import { sceneProject } from '../synthetic/project.ts';
import { makeScene } from '../synthetic/scene.ts';

const tr = makeScene();
const clip: ClipMeta = { id: 'clip', name: 'Clip 1 (17 s)', source: 'buffer', durationS: tr.duration, width: tr.W, height: tr.H, createdAt: 0 };
let n = 0;
const make = { uid: () => `new${n++}`, shot: (k: number): Shot => ({ id: `shot${k}`, name: `Shot ${k}`, crater: {}, impactTimeS: {} }) };
const empty = (): ProjectData => ({ settings: { ...sceneProject(tr, { n: 1 }).settings, fovDeg: 70 }, shots: [make.shot(1)], sightings: [] });

describe('annotation files', () => {
  test('a clip exports and imports back into an empty project unchanged', () => {
    const src = sceneProject(tr, { n: 5 });
    const a = annotation(src, clip)!;
    const dst = empty();
    const notes = applyAnnotation(dst, 'imported', a, make, clip);
    expect(notes).toEqual([]);
    // an empty project takes the settings of the file
    expect(dst.settings.fovDeg).toBe(src.settings.fovDeg);
    expect(dst.shots).toHaveLength(1);
    expect(dst.shots[0].crater).toEqual(src.shots[0].crater);
    expect(dst.shots[0].impactTimeS.imported).toBe(src.shots[0].impactTimeS.clip);
    const strip = ({ id: _i, clipId: _c, shotId: _s, ...s }: ProjectData['sightings'][number]) => s;
    expect(dst.sightings.map(strip)).toEqual(src.sightings.map(strip));
  });

  test('a clip without marks has no annotation file', () => {
    expect(annotation({ ...empty(), shots: [] }, clip)).toBeNull();
  });

  test('a project with sightings keeps its FOV and says so', () => {
    const dst = sceneProject(tr, { n: 2 });
    dst.settings.fovDeg = 70;
    const notes = applyAnnotation(dst, 'other', annotation(sceneProject(tr, { n: 2 }), clip)!, make, clip);
    expect(dst.settings.fovDeg).toBe(70);
    expect(notes[0]).toContain('The project keeps 70 deg');
  });

  test('the suspected heading travels with the crater', () => {
    const src = sceneProject(tr, { n: 2 });
    Object.assign(src.shots[0], { sourceDeg: 240, sourceTolDeg: 15 });
    const dst = empty();
    applyAnnotation(dst, 'imported', annotation(src, clip)!, make, clip);
    expect([dst.shots[0].sourceDeg, dst.shots[0].sourceTolDeg]).toEqual([240, 15]);
  });

  test('marks from a video of another size get a note', () => {
    const notes = applyAnnotation(empty(), 'imported', annotation(sceneProject(tr, { n: 2 }), clip)!, make, { width: 1920, height: 1080 });
    expect(notes.some((x) => x.includes('this video is 1920x1080'))).toBe(true);
  });
});
