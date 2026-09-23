import { describe, expect, test } from 'bun:test';
import { frameIndexAt, frameTimeAt, stepFrom, thumbTimes } from '../../src/lib/video/frames.ts';
import { prepareClip } from '../../src/lib/video/prepareClip.ts';

// uneven frame times, as screen recordings have
const frames = [0, 0.015, 0.04, 0.057, 0.1, 0.2, 0.21];

describe('frame list', () => {
  test('the frame on screen is the last one that starts at or before t', () => {
    expect(frameIndexAt(frames, 0)).toBe(0);
    expect(frameIndexAt(frames, 0.039)).toBe(1);
    expect(frameIndexAt(frames, 0.04)).toBe(2);
    expect(frameIndexAt(frames, 5)).toBe(6);
    expect(frameTimeAt(frames, 0.15)).toBe(0.1);
    expect(frameTimeAt(undefined, 0.15)).toBe(0.15);
  });

  test('a step moves by frames, not by a fixed time, and stops at the ends', () => {
    expect(stepFrom(frames, 0.057, 1)).toBe(0.1);
    expect(stepFrom(frames, 0.1, -3)).toBe(0.015);
    expect(stepFrom(frames, 0.1, 10)).toBe(0.21);
    expect(stepFrom(frames, 0.02, -10)).toBe(0);
  });

  test('thumbnails come every 2 s and never show a frame twice', () => {
    const dense = Array.from({ length: 600 }, (_, i) => i / 60); // 10 s at 60 fps
    expect(thumbTimes(dense, 10, 2)).toHaveLength(5);
    // a clip with a long frozen stretch: the slots that fall on the same frame collapse into one
    const frozen = [0, 0.5, 9.9];
    const t = thumbTimes(frozen, 10, 2);
    expect(new Set(t).size).toBe(t.length);
  });
});

describe('prepareClip', () => {
  test('lists the frames of a MediaRecorder WebM and gives it a duration', async () => {
    const file = Bun.file(new URL('../fixtures/chrome-vp9-10s.webm', import.meta.url));
    const p = await prepareClip(new Blob([await file.arrayBuffer()], { type: 'video/webm' }), 'chrome-vp9-10s.webm');
    expect(p.frames).toHaveLength(556);
    expect(p.frames[0]).toBe(0);
    expect(p.frames.every((t, i) => i === 0 || t > p.frames[i - 1])).toBe(true);
    expect(p.durationS).toBeCloseTo(9.99, 1);
    expect([p.width, p.height]).toEqual([1280, 720]);
    expect(p.blob.type).toBe('video/webm');
  });
});
