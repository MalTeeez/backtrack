import { describe, expect, test } from 'bun:test';
import { annotation, applyAnnotation, oneClipPerShot } from '../../src/lib/capture/annotation.ts';
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
    src.sightings[1].excluded = true;
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

  test('a shot of the same name in another clip stays a separate shot of that clip', () => {
    const one = sceneProject(tr, { n: 2 }), two = sceneProject(tr, { n: 3 });
    two.shots[0].crater = { x: 10, y: 20 };
    const dst = empty();
    applyAnnotation(dst, 'a', annotation(one, clip)!, make, clip);
    applyAnnotation(dst, 'b', annotation(two, { ...clip, name: 'Clip 2' })!, make, clip);
    expect(dst.shots.map((s) => [s.name, s.clipId])).toEqual([['Shot 1', 'a'], ['Shot 1', 'b']]);
    expect(dst.shots[1].crater).toEqual({ x: 10, y: 20 });
    expect(dst.sightings.filter((s) => s.shotId === dst.shots[1].id).every((s) => s.clipId === 'b')).toBe(true);
    // even with the same crater, another clip gets its own shot
    applyAnnotation(dst, 'c', annotation(one, clip)!, make, clip);
    expect(dst.shots.map((s) => s.clipId)).toEqual(['a', 'b', 'c']);
  });

  test('two shots of one name in a clip keep their own sightings through a file', () => {
    const src = sceneProject(tr, { n: 4 });
    src.shots.push({ ...make.shot(2), name: src.shots[0].name, impactTimeS: { clip: 1 } });
    src.sightings.slice(2).forEach((s) => (s.shotId = src.shots[1].id));
    const dst = empty();
    applyAnnotation(dst, 'x', annotation(src, clip)!, make, clip);
    expect(dst.shots.map((s) => [s.name, dst.sightings.filter((x) => x.shotId === s.id).length])).toEqual([['Shot 1', 2], ['Shot 1 (2)', 2]]);
  });

  test('an old file brings the default range of its weapon', () => {
    const a = annotation(sceneProject(tr, { n: 2 }), clip)!;
    a.settings = { fovDeg: 90, fovAxis: 'h', weapon: 'L81' };
    const dst = empty();
    applyAnnotation(dst, 'x', a, make, clip);
    expect([dst.settings.weapon, dst.settings.rangeMinM, dst.settings.rangeMaxM]).toEqual(['L81', 80, 684]);
  });

  test('a second import of the same file adds nothing, and a left out shot stays left out', () => {
    const src = sceneProject(tr, { n: 3 });
    src.shots[0].excluded = true;
    const a = annotation(src, clip)!;
    const dst = empty();
    applyAnnotation(dst, 'imported', a, make, clip);
    const notes = applyAnnotation(dst, 'imported', a, make, clip);
    expect(dst.sightings).toHaveLength(3);
    expect(dst.shots).toHaveLength(1);
    expect(dst.shots[0].excluded).toBe(true);
    expect(notes).toContain('3 sighting(s) of the file were already there and were skipped.');
  });

  test('a sighting without a known shot never joins a shot of another clip', () => {
    const dst = sceneProject(tr, { n: 2 });
    const a = annotation(sceneProject(tr, { n: 2 }), clip)!;
    a.shots = [];
    a.sightings.forEach((s) => (s.shot = null));
    applyAnnotation(dst, 'b', a, make, clip);
    const other = dst.shots[0].id;
    expect(dst.sightings.filter((s) => s.clipId === 'b').every((s) => s.shotId !== other)).toBe(true);
    expect(dst.shots).toHaveLength(2);
  });

  test('a shot spread over two clips splits into one shot per clip', () => {
    const p = sceneProject(tr, { n: 4 });
    p.sightings.slice(2).forEach((s) => (s.clipId = 'other'));
    p.shots[0].impactTimeS.other = 12;
    expect(oneClipPerShot(p, make)).toEqual(['Shot 1 (2)']);
    const [a, b] = p.shots;
    expect(Object.keys(a.impactTimeS)).toEqual(['clip']);
    expect(b.impactTimeS).toEqual({ other: 12 });
    expect(b.crater).toEqual({});
    expect(p.sightings.map((s) => [s.clipId, s.shotId === a.id ? 'a' : 'b'])).toEqual([['clip', 'a'], ['clip', 'a'], ['other', 'b'], ['other', 'b']]);
    // a project without mixed shots stays as it is
    expect(oneClipPerShot(p, make)).toEqual([]);
    expect(p.shots).toHaveLength(2);
    expect(p.shots.map((s) => s.clipId)).toEqual(['clip', 'other']);
    // a shot of an old project that a deleted clip left behind goes; a new blank shot and a shot of a clip stay
    b.crater = { x: 1, y: 2 };
    p.sightings = p.sightings.filter((s) => s.clipId !== 'other');
    delete b.impactTimeS.other;
    p.shots.push({ ...make.shot(8), crater: { x: 3, y: 4 } }, make.shot(9));
    oneClipPerShot(p, make);
    expect(p.shots.map((s) => s.name)).toEqual(['Shot 1', 'Shot 1 (2)', 'Shot 9']);
  });

  test('marks from a video of another size get a note', () => {
    const notes = applyAnnotation(empty(), 'imported', annotation(sceneProject(tr, { n: 2 }), clip)!, make, { width: 1920, height: 1080 });
    expect(notes.some((x) => x.includes('this video is 1920x1080'))).toBe(true);
  });
});
