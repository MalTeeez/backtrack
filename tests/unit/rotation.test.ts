import { describe, expect, test } from 'bun:test';
import { anglesOf, apply, axisAngle, bearing, cameraToWorld, fitRotation, frameCamera, mul, norm, pixel, rotationAngle, T, type V3 } from '../../src/lib/vision/rotation.ts';
import { centered, rayWorld } from '../../src/lib/solver/camera.ts';
import { seeded } from '../../src/lib/solver/montecarlo.ts';

describe('rotation', () => {
  test('fitRotation recovers a rotation from noisy bearings', () => {
    const rng = seeded(4), R = axisAngle([0.3, 1, -0.2], 7.5);
    const a: V3[] = Array.from({ length: 50 }, () => norm([rng() - 0.5, rng() - 0.5, 1]));
    const b = a.map((v) => norm(apply(R, v).map((x) => x + (rng() - 0.5) * 1e-5) as V3));
    expect(rotationAngle(mul(fitRotation(a, b), T(R)))).toBeLessThan(0.002);
  });

  test('camera angles survive a round trip, and a frame camera matches rayWorld', () => {
    const M = cameraToWorld(123.4, 17.2, -2.1);
    const a = anglesOf(M);
    expect([a.h, a.p, a.r].map((x) => +x.toFixed(9))).toEqual([123.4, 17.2, -2.1]);
    // a pixel of a turned frame points where rayWorld with the frame camera points
    const K = { f: 1611, cx: 1920, cy: 1080 }, Ri = axisAngle([0.1, 1, 0.05], 3);
    const cam = frameCamera(M, Ri);
    const world = apply(mul(M, T(Ri)), bearing(K, 2500, 700));
    const ray = rayWorld(centered({ x: 2500, y: 700 }, 3840, 2160), K.f, cam.h, cam.p, cam.r);
    for (let i = 0; i < 3; i++) expect(world[i]).toBeCloseTo(ray[i], 9);
    expect(pixel(K, bearing(K, 2500, 700))!.x).toBeCloseTo(2500, 9);
  });
});
