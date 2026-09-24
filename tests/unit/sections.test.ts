import { describe, expect, test } from 'bun:test';
import { applySection, frameCameraAt } from '../../src/lib/state/sections.ts';
import { SightingSolver } from '../../src/lib/solver/sightings.ts';
import { angleBetween, apply, axisAngle, bearing, cameraToWorld, mul, pixel, T } from '../../src/lib/vision/rotation.ts';
import { fieldState, offBy } from '../../src/lib/solver/field.ts';
import { smoothPath } from '../../src/lib/vision/minimap.ts';
import type { ProjectData, Section, Vec3 } from '../../src/lib/solver/types.ts';

const W = 3840, H = 2160, f = W / 2 / Math.tan((100 * Math.PI) / 360), K = { f, cx: W / 2 - 0.5, cy: H / 2 - 0.5 };
const ref = { h: 196.3, p: 24, r: 0 };

/** A section of 5 frames: the camera turns a little each frame; the shell is a world direction seen in each frame. */
function section(): { sec: Section; dirs: Vec3[] } {
  const Mref = cameraToWorld(ref.h, ref.p, ref.r), frames: Section['frames'] = [], marks: Section['marks'] = [], dirs: Vec3[] = [];
  for (let k = 0; k < 5; k++) {
    const t = 10 + k / 12, R = axisAngle([0.2, 1, 0.1], 0.4 * k);
    frames.push({ t, R, ok: true, inliers: 300, fitPx: 0.3 });
    const world: Vec3 = apply(Mref, bearing(K, 1500 + 40 * k, 900 + 25 * k)); // a direction in the world
    dirs.push(world);
    const inFrame = pixel(K, apply(mul(R, T(Mref)), world))!; // b_frame = R Mref^T w
    // in the frame as the app counts pixels: centers at .5
    marks.push({ t, x: inFrame.x + 0.5, y: inFrame.y + 0.5, rx: 0, ry: 0, score: 60 });
  }
  const sec: Section = {
    id: 'sec', shotId: 'shot', a: 10, b: 10.4, ranAt: 0, ms: 0, width: W, height: H, ref: 10, frames,
    heading: { auto: { value: ref.h, sigma: 0.06, conf: 0.97 } }, pitch: { auto: { value: ref.p, sigma: 0.05, conf: 0.97 } }, roll: { auto: { value: 0, sigma: 0.02, conf: 1 } },
    marks, lines: [], impact: { value: { a: 10.5, b: 10.58 }, sigma: 0.04, conf: 0.9 },
    minimap: { map: { value: 'ozeti', conf: 0.8 }, at: { value: { x: 97.5, y: 65.7 }, sigma: 0.05, conf: 0.9 }, mpp: 0.5 },
    dropped: [], notes: [],
  };
  return { sec, dirs };
}
const project = (): ProjectData => ({
  settings: { fovDeg: 100, fovAxis: 'h', rangeMinM: 600, rangeMaxM: 2600, limitToRange: true, bufferS: 40, bitrateMbps: 25, markSigmaPx: 1, compassSigmaDeg: 0.5 },
  clips: {}, shots: [{ id: 'shot', name: 'Shot 1', crater: {}, impact: {}, observer: {}, clipId: 'clip' }], sightings: [],
});

describe('sections', () => {
  test('the sightings of a section give the world directions of its marks', () => {
    const p = project(), { sec, dirs } = section();
    let n = 0;
    applySection(p, 'clip', sec, { uid: () => `s${n++}` });
    expect(p.sightings).toHaveLength(5);
    const solver = new SightingSolver(p);
    p.sightings.forEach((s, k) => {
      expect(fieldState('shell', s.shell)).toBe('auto');
      const a = solver.aim(s);
      if (!a.ok) throw new Error(a.error);
      // the stored values are rounded: angles to 1e-4 deg, marks to 0.01 px
      expect(angleBetween(a.D as Vec3, dirs[k])).toBeLessThan(1e-3);
    });
    expect(p.shots[0].impact.clip.auto?.value).toEqual({ a: 10.5, b: 10.58 });
    expect(p.shots[0].observer.clip.auto?.value).toEqual({ x: 97.5, y: 65.7 });
    expect(p.clips.clip.map.auto?.value).toBe('ozeti');
    // the camera of a frame carries the section as its error group
    expect(frameCameraAt(sec, 10)!.h.group).toBe('sec');
  });

  test('a new run keeps what the user did and drops what it no longer finds', () => {
    const p = project(), { sec } = section();
    let n = 0;
    const make = { uid: () => `s${n++}` };
    applySection(p, 'clip', sec, make);
    p.sightings[1].shell.manual = { x: 1, y: 2 };
    sec.pitch.manual = 23.5;
    const again = section().sec;
    again.marks = again.marks.filter((_, k) => k !== 1 && k !== 3);
    applySection(p, 'clip', again, make);
    // the user's sighting stays (its automatic mark goes), the other lost one goes
    expect(p.sightings.map((s) => s.timeS.toFixed(3))).toEqual(['10.000', '10.083', '10.167', '10.333']);
    expect(p.sightings[1].shell).toEqual({ manual: { x: 1, y: 2 } });
    // the pitch the user typed for the section stays, and every sighting follows it
    expect(p.clips.clip.sections![0].pitch.manual).toBe(23.5);
    expect(p.clips.clip.sections).toHaveLength(1);
    expect(frameCameraAt(p.clips.clip.sections![0], 10)!.p.value).toBeCloseTo(23.5, 3);
  });
});

describe('fields', () => {
  test('a manual value far from a sure automatic one gets a warning, a near one does not', () => {
    const f = { auto: { value: 196.5, sigma: 0.06, conf: 0.97 }, manual: 196.8 };
    expect(fieldState('heading', f)).toBe('manual');
    f.manual = 198;
    expect(fieldState('heading', f)).toBe('warned');
    expect(offBy('heading', f)).toBeCloseTo(1.5, 6);
    // an unsure automatic value warns no one
    expect(fieldState('heading', { ...f, auto: { ...f.auto, conf: 0.3 } })).toBe('manual');
    expect(fieldState('heading', { auto: { value: 1, conf: 0.3 } })).toBe('required');
  });

  test('a walk gives each sighting its offset from where the user was at the impact', () => {
    const p = project(), { sec } = section();
    // 1.5 m/s to the east: 0.015 game units per second
    sec.walk = [10, 10.25, 10.54].map((t) => ({ t, x: 97.5 + 0.015 * (t - 10.54), y: 65.7 }));
    let n = 0;
    applySection(p, 'clip', sec, { uid: () => `s${n++}` });
    expect(p.sightings[0].walkM![0]).toBeCloseTo(-1.5 * 0.54, 2);
    expect(p.sightings[4].walkM![0]).toBeCloseTo(-1.5 * (0.54 - 4 / 12), 2);
    expect(p.sightings[0].walkM![1]).toBeCloseTo(0, 6);
    // a new run without a walk: the offsets go
    delete sec.walk;
    applySection(p, 'clip', sec, { uid: () => `s${n++}` });
    expect(p.sightings.every((s) => s.walkM == null)).toBe(true);
  });

  test('the walking path is smooth and ignores a match on the wrong spot', () => {
    const pts = Array.from({ length: 12 }, (_, k) => ({ t: k / 4, x: 50 + 0.015 * (k / 4) + (k % 2 ? 0.003 : -0.003), y: 20 }));
    pts[5].x += 0.5; // 50 m off
    const at = smoothPath(pts)!;
    expect(Math.abs(at(1.25).x - (50 + 0.015 * 1.25)) * 100).toBeLessThan(0.5);
    expect(smoothPath(pts.slice(0, 3))).toBeNull();
  });
});
