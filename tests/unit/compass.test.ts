import { describe, expect, test } from 'bun:test';
import { compassRegion, readCompass } from '../../src/lib/video/compass.ts';

/**
 * Compass regions of a 3840 x 2160 recording (tests/fixtures/compass, raw grayscale, 180 x 70), named by the heading
 * they show: bright sky (102, 196, 070, 136) and dark ground (002).
 */
const R = compassRegion(3840, 2160);
const region = async (h: string) => ({ data: new Uint8Array(await Bun.file(new URL(`../fixtures/compass/${h}.gray`, import.meta.url)).arrayBuffer()), w: R.w, h: R.h });

describe('compass reader', () => {
  test('the region of a 4K frame is the box at the top middle', () => {
    expect(R).toEqual({ x: 1830, y: 35, w: 180, h: 70, s: 1 });
  });

  for (const h of ['102', '002', '196', '070', '136']) {
    test(`reads ${h}`, async () => {
      expect(readCompass(await region(h), R.s)?.heading).toBe(Number(h));
    });
  }

  test('a frame without the compass gives no reading', () => {
    const flat = { data: new Uint8Array(R.w * R.h).fill(128), w: R.w, h: R.h };
    expect(readCompass(flat, R.s)).toBeNull();
  });
});
