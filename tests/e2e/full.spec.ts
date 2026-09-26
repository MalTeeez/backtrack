/**
 * Milestone 7. The test records the synthetic shot through the fake capture stream, marks the impact
 * and 15 sightings with two vertical edges and the compass heading, and enters the coordinates. It then checks that the solver finds
 * the gun within 100 m. It finds the shell in each frame by its color, the way a user finds it by eye.
 */
import { expect, test, type Page } from '@playwright/test';
import { makeScene } from '../synthetic/scene.ts';
import { fakeCapture, sceneFrames } from './fake-capture.ts';

const tr = makeScene();
const game = (m: number) => String(Math.round(m) / 100);

/** The pixels of the frame the <video> shows (the viewer canvas holds only the marks). */
const FRAME = `(() => {
  const v = document.querySelector('video');
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const g = c.getContext('2d');
  g.drawImage(v, 0, 0);
  return { c, d: g.getImageData(0, 0, c.width, c.height).data };
})()`;

/** The weighted center of the shell-colored pixels, or null. */
const findShell = (page: Page) =>
  page.evaluate((frame) => {
    const { c, d } = eval(frame) as { c: HTMLCanvasElement; d: Uint8ClampedArray };
    let sx = 0, sy = 0, sw = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (r > 200 && g > 170 && b > 50 && b < 175 && r - b > 60) {
        const w = (r - 150) + (g - 120);
        const p = i / 4;
        sx += (p % c.width) * w; sy += Math.floor(p / c.width) * w; sw += w;
      }
    }
    return sw > 0 ? { x: sx / sw + 0.5, y: sy / sw + 0.5 } : null;
  }, FRAME);

const flashVisible = (page: Page) =>
  page.evaluate((frame) => {
    const { d } = eval(frame) as { d: Uint8ClampedArray };
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 110 && d[i + 1] < 195 && d[i + 2] < 110) n++;
    return n > 30;
  }, FRAME);

const timeText = (page: Page) => page.getByTestId('time').innerText();
/** Does something that moves the video, and waits for the new frame. */
async function moved(page: Page, act: () => Promise<void>) {
  const before = await timeText(page);
  await act();
  await expect.poll(() => timeText(page)).not.toBe(before);
  // Firefox shows the new time before it has the new frame: a frame read then is the old one or black
  await page.waitForFunction(() => { const v = document.querySelector('video'); return !!v && !v.seeking && v.readyState >= 2; });
  await page.waitForTimeout(60);
}
const now = async (page: Page) => parseFloat((await page.getByTestId('time').getAttribute('data-t'))!);
const clipLength = async (page: Page) => parseFloat((await page.getByTestId('time').getAttribute('data-d'))!);

async function seekTo(page: Page, t: number, duration: number) {
  const track = page.getByRole('slider').first();
  const r = (await track.boundingBox())!;
  await moved(page, () => track.click({ position: { x: (t / duration) * r.width, y: r.height / 2 } }));
}

async function setTool(page: Page, tool: 'shell' | 'edge') {
  const b = page.getByTestId(`tool-${tool}`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
}

/** Marks a video pixel through the magnifier (sub-pixel), like a careful user. */
async function markAt(page: Page, p: { x: number; y: number }) {
  const v = (await page.getByTestId('viewer').boundingBox())!;
  const W = tr.W, H = tr.H;
  const hx = Math.round(v.x + (p.x * v.width) / W), hy = Math.round(v.y + (p.y * v.height) / H);
  await page.mouse.move(hx, hy);
  const c = { x: ((hx - v.x) * W) / v.width, y: ((hy - v.y) * H) / v.height }; // what the app sees
  const m = (await page.getByTestId('magnifier').boundingBox())!;
  const k = (m.width / 480) * 16; // CSS px per video px at 8x zoom
  await page.mouse.click(m.x + m.width / 2 + (p.x - c.x) * k, m.y + m.height / 2 + (p.y - c.y) * k);
}

test('synthetic shot: 15 sightings with edges and compass find the gun within 100 m', async ({ page }) => {
  await fakeCapture(page, sceneFrames(tr));
  await page.goto('/');

  // 1 Record
  await page.getByTestId('buffer-s').fill('30');
  await page.getByTestId('buffer-s').press('Enter');
  await page.getByTestId('rec-start').click();
  await page.waitForTimeout((tr.duration + 1.5) * 1000);
  await page.getByTestId('rec-save').click();
  await expect(page.getByTestId('rec-note')).toHaveText('Clip saved.', { timeout: 15_000 });

  // 2 Mark
  await page.getByTestId('phase-mark').click();
  await expect(page.getByTestId('viewer')).toBeVisible();
  await expect.poll(() => clipLength(page)).toBeGreaterThan(1);
  const duration = await clipLength(page);
  await expect(page.getByTestId('phase-result')).toBeDisabled();
  // the synthetic scene has no map: close the question for it
  await page.getByRole('button', { name: 'Not now' }).click();

  // scan back from the end for the impact flash, then step to its first frame
  let t = duration - 0.1;
  await seekTo(page, t, duration);
  while (!(await flashVisible(page))) {
    t -= 0.2;
    expect(t).toBeGreaterThan(0);
    await seekTo(page, t, duration);
  }
  while (await flashVisible(page)) await moved(page, () => page.keyboard.press('ArrowLeft'));
  await moved(page, () => page.keyboard.press('ArrowRight'));
  await page.keyboard.press('i');
  await expect(page.getByTestId('impact-status')).not.toContainText('not marked');
  const impact = await now(page);

  // 15 sightings over the visible part of the flight
  for (let i = 0; i < 15; i++) {
    const f = 0.14 + (0.8 * i) / 14;
    await seekTo(page, impact - tr.T * (1 - f), duration);
    let shell = await findShell(page);
    while (!shell) { await moved(page, () => page.keyboard.press('ArrowRight')); shell = await findShell(page); }
    await setTool(page, 'shell');
    await markAt(page, shell);
    await setTool(page, 'edge');
    for (const [a, b] of tr.edges) { await markAt(page, a); await markAt(page, b); }
    const card = page.locator('[data-testid=sighting][aria-current=true]');
    await card.getByRole('spinbutton', { name: 'Compass heading (deg)' }).fill(String(tr.camH));
    await card.getByRole('spinbutton', { name: 'Compass heading (deg)' }).press('Enter');
  }
  await expect(page.getByTestId('sighting')).toHaveCount(15);
  // every sighting is complete: the crater comes in phase 3, and nothing else is missing
  await expect(page.locator('[data-testid=sighting] .note.bad')).toHaveCount(0);

  // 3 Coordinates open once every sighting is complete
  await page.getByTestId('phase-coordinates').click();
  const shots = page.getByTestId('shots');
  await shots.getByRole('spinbutton', { name: 'Crater X' }).fill(game(tr.C[0]));
  await shots.getByRole('spinbutton', { name: 'Crater Y' }).fill(game(tr.C[1]));

  // 4 Result
  await page.getByTestId('phase-result').click();
  const gun = page.getByTestId('gun');
  await expect(gun).toBeVisible({ timeout: 30_000 });
  const [, x, y] = (await gun.innerText()).match(/X ([\d.-]+)\s+Y ([\d.-]+)/)!.map(Number);
  const err = Math.hypot(x * 100 - tr.G[0], y * 100 - tr.G[1]);
  console.log(`gun X ${x} Y ${y}, truth X ${tr.G[0] / 100} Y ${tr.G[1] / 100}, error ${err.toFixed(1)} m`);
  expect(err).toBeLessThan(100);
});
