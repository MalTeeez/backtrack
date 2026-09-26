/** The timeline of the Mark phase: going to a time or a frame, and a section that playback repeats. */
import { expect, test, type Page } from '@playwright/test';

const now = async (page: Page) => parseFloat((await page.getByTestId('time').getAttribute('data-t'))!);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('upload').setInputFiles('tests/fixtures/chrome-vp9-10s.webm');
  await expect(page.getByTestId('clip-list').locator('tbody tr')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('phase-mark').click();
  await expect(page.getByTestId('viewer')).toBeVisible();
  await expect.poll(() => page.getByTestId('time').getAttribute('data-d').then(Number)).toBeGreaterThan(5);
});

test('G goes to a time and to a frame', async ({ page }) => {
  await page.keyboard.press('g');
  await page.getByTestId('goto').fill('0:02.5');
  await page.getByTestId('goto').press('Enter');
  await expect.poll(() => now(page)).toBeCloseTo(2.5, 1);
  await page.keyboard.press('g');
  await page.getByTestId('goto').fill('#1');
  await page.getByTestId('goto').press('Enter');
  await expect.poll(() => now(page)).toBeLessThan(0.1);
});

test('a drag on the ruler selects a section that playback repeats, and Alt+X clears it', async ({ page }) => {
  const d = Number(await page.getByTestId('time').getAttribute('data-d'));
  const ruler = page.getByTestId('ruler');
  const r = (await ruler.boundingBox())!, at = (t: number) => r.x + (t / d) * r.width, y = r.y + r.height / 2;
  await page.mouse.move(at(2), y);
  await page.mouse.down();
  await page.mouse.move(at(3), y);
  await page.mouse.move(at(4), y);
  await page.mouse.up();
  await expect(page.getByTestId('loop')).toHaveCount(1);

  // playback starts at the section and wraps at its end
  await page.keyboard.press('Space');
  const seen: number[] = [];
  for (let i = 0; i < 12; i++) { await page.waitForTimeout(250); seen.push(await now(page)); }
  await page.keyboard.press('Space');
  expect(Math.min(...seen)).toBeGreaterThan(1.9);
  expect(Math.max(...seen)).toBeLessThan(4.2);
  expect(seen.some((t, i) => i > 0 && t < seen[i - 1])).toBe(true);

  await page.keyboard.press('Alt+x');
  await expect(page.getByTestId('loop')).toHaveCount(0);
});
