/**
 * The automatic detection (automation plan sections 5 to 10) on the real clip 1, through the guided flow: upload, the
 * automatic flow of Setup (the detected map, the FOV and its check, the section of shot 2, drawn with the section tool), the Process button,
 * then Review as it fills in, and Result. The detection must
 * find the shell on most frames, the impact and the sighting position. Without WebGPU (the headless browsers of the
 * test) it runs on the CPU, which tests the fallback.
 */
import { expect, test } from '@playwright/test';

test('the detection finds the shell, the impact and the position in a section of clip 1', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await page.getByTestId('upload').setInputFiles('test-data/Clip 1 (44 s).webm');
  await expect(page.getByTestId('clip-list').locator('tbody tr')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('phase-setup').click();
  await page.getByTestId('mode-auto').click();
  // the minimap search finds the map on its own while the user marks
  await expect(page.getByTestId('detected-map')).toContainText('Detected map: Ozeti', { timeout: 90_000 });
  await page.getByTestId('settings').click();
  await page.getByTestId('fov-input').fill('100');
  await page.getByTestId('settings-save').click();
  // the FOV is a setting of the browser: it stays over a reload
  await page.reload();
  await expect(page.getByTestId('settings')).toHaveText(/FOV 100$/);
  // the reload may come before the app saved the phase; the flow of the clip stays
  await page.getByTestId('phase-setup').click();
  await expect(page.getByTestId('viewer')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('process-clip')).toBeDisabled();

  // shot 2 flies from about 23.3 s to 25.6 s
  // the length of the clip shows once the player loaded it
  await expect.poll(async () => Number(await page.getByTestId('setup-time').getAttribute('data-d'))).toBeGreaterThan(1);
  const d = Number(await page.getByTestId('setup-time').getAttribute('data-d'));
  await expect(page.getByTestId('section-tool')).toHaveAttribute('aria-pressed', 'true');
  // the section tool draws in the lane of the first shot, which is free
  const r = (await page.getByTestId('track-lane-0').boundingBox())!, at = (t: number) => r.x + (t / d) * r.width, y = r.y + r.height / 2;
  await page.mouse.move(at(23.3), y);
  await page.mouse.down();
  await page.mouse.move(at(24.5), y);
  await page.mouse.move(at(25.6), y);
  await page.mouse.up();
  await expect(page.getByTestId('pending-section')).toHaveCount(1);
  // the FOV check runs on the first section: 100 deg fits the turns of the camera
  await expect(page.getByTestId('fov-ok')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('process-clip').click();

  // Review fills in as the detection runs
  await expect(page.getByTestId('processing')).toBeVisible();
  await expect(page.getByTestId('finding-shell').first()).toBeAttached({ timeout: 240_000 });
  await expect(page.getByTestId('processing')).toHaveCount(0, { timeout: 60_000 });

  // Review lists the findings: the shell on most frames, the impact from the track, the position from the minimap
  await expect(page.getByTestId('signoff')).toBeVisible();
  await page.getByTestId('filter-all').click();
  // the list before and after the switch are both on the page while they slide (0.25 s)
  await page.waitForTimeout(400);
  const shells = await page.getByTestId('finding-shell').count();
  expect(shells).toBeGreaterThanOrEqual(15);
  const panel = page.getByTestId('section-panel');
  // the impact from the track: 26.026 s to 26.112 s, the middle at 26.069 s
  await expect(panel).toContainText('26.069 s');
  await expect(panel).toContainText('Ozeti X 97.4');
  // the quick sign-off signs off those at or above its threshold
  const doneBefore = Number((await page.getByTestId('filter-done').innerText()).replace(/\D/g, ''));
  await page.getByTestId('signoff-all').click();
  await expect.poll(async () => Number((await page.getByTestId('filter-done').innerText()).replace(/\D/g, ''))).toBeGreaterThan(doneBefore);
  // a window expands alone and restores the layout
  await page.getByTestId('expand-scene').click();
  await expect(page.getByTestId('tab-video')).toHaveCount(0);
  await page.getByTestId('restore-scene').click();
  await expect(page.getByTestId('tab-video')).toHaveCount(1);
  // the position makes the crater optional, and the camera is automatic: nothing is missing for the result
  await expect(page.getByTestId('phase-result')).toBeEnabled();
  // the result draws every shell position against the fit, and the fit is good: under 0.1 deg RMS
  await page.getByTestId('phase-result').click();
  await expect(page.getByTestId('miss-chart').locator('g[role="button"]')).toHaveCount(shells, { timeout: 60_000 });
  await expect(page.getByTestId('shot-result')).toContainText(/0\.0\d deg RMS/);
});
