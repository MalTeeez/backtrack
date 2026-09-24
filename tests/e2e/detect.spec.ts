/**
 * The automatic detection (automation plan sections 5 to 10) on the real clip 1: upload, pick the map, select the
 * section of shot 2 on the ruler, detect. The detection must find the shell on most frames, the impact and where the
 * user stood. Without WebGPU (the headless browsers of the test) it runs on the CPU, which tests the fallback.
 */
import { expect, test } from '@playwright/test';

test('the detection finds the shell, the impact and the position in a section of clip 1', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await page.getByTestId('upload').setInputFiles('test-data/Clip 1 (44 s).webm');
  await expect(page.getByTestId('clip-list').locator('tbody tr')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('phase-mark').click();
  await expect(page.getByTestId('viewer')).toBeVisible();
  await page.getByTestId('map-choice').getByRole('button', { name: /Ozeti/ }).click();
  await page.getByTestId('settings').click();
  await page.getByTestId('fov-input').fill('100');
  await page.getByTestId('settings-save').click();
  // the FOV is a setting of the browser: it stays over a reload
  await page.reload();
  await expect(page.getByTestId('settings')).toHaveText(/FOV 100$/);
  // the reload may come before the app saved the phase
  await page.getByTestId('phase-mark').click();
  await expect(page.getByTestId('viewer')).toBeVisible({ timeout: 30_000 });

  // shot 2 flies from about 23.3 s to 25.6 s
  const d = Number(await page.getByTestId('time').getAttribute('data-d'));
  const ruler = page.locator('[title^="Drag to select a section"]');
  const r = (await ruler.boundingBox())!, at = (t: number) => r.x + (t / d) * r.width, y = r.y + r.height / 2;
  await page.mouse.move(at(23.3), y);
  await page.mouse.down();
  await page.mouse.move(at(24.5), y);
  await page.mouse.move(at(25.6), y);
  await page.mouse.up();

  await page.getByTestId('detect').click();
  const panel = page.getByTestId('section-panel');
  await expect(panel.getByText('Section', { exact: true })).toBeVisible({ timeout: 240_000 });
  expect(await page.getByTestId('sighting').count()).toBeGreaterThanOrEqual(15);
  // the impact from the track: 26.026 s to 26.112 s, the middle at 26.069 s
  await expect(panel).toContainText('26.069 s');
  await expect(panel).toContainText('Ozeti X 97.4');
  // the position makes the crater optional, and the camera is automatic: nothing is missing for the result
  await expect(page.getByTestId('phase-result')).toBeEnabled();
});
