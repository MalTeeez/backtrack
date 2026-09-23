/** Milestone 3 tests the rolling buffer with a fake capture stream, the upload and the clips after a reload. */
import { expect, test } from '@playwright/test';
import { fakeCapture } from './fake-capture.ts';

test.beforeEach(async ({ page }) => {
  await fakeCapture(page);
  await page.goto('/'); // every test gets a fresh browser context, so IndexedDB starts empty
});

test('rolling buffer keeps the last N seconds and the clip survives a reload', async ({ page }) => {
  const buffer = page.getByTestId('buffer-s');
  await buffer.fill('5');
  await buffer.press('Enter');
  await page.getByTestId('rec-start').click();
  await expect(page.getByTestId('rec-status')).toContainText('Recording');
  // after 2N, the first recorder restarted at least once
  await page.waitForTimeout(12_500);
  await expect(page.getByTestId('rec-status')).toContainText('Recording, 5 s');
  await page.getByTestId('rec-save').click();
  await expect(page.getByTestId('rec-note')).toHaveText('Clip saved.', { timeout: 10_000 });
  // saving ends the screen share
  await expect(page.getByTestId('rec-status')).toContainText('Idle');
  await expect(page.getByTestId('rec-start')).toBeVisible();

  const row = page.getByTestId('clip-list').locator('tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Buffer')).toBeVisible();
  // between N and 2N seconds, with a real duration (the WebM duration fix)
  const len = await row.locator('td').nth(3).innerText();
  const [m, s] = len.split(':').map(Number);
  expect(m * 60 + s).toBeGreaterThanOrEqual(4);
  expect(m * 60 + s).toBeLessThanOrEqual(11);

  await page.reload();
  await expect(page.getByTestId('clip-list').locator('tbody tr')).toHaveCount(1);
});

test('upload accepts a WebM file', async ({ page }) => {
  // the page makes a 2 s WebM that stands in for a Game Bar or OBS clip
  const bytes = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const g = c.getContext('2d')!;
    let run = true;
    const draw = () => { g.fillStyle = `hsl(${performance.now() / 10 % 360} 60% 50%)`; g.fillRect(0, 0, 320, 180); if (run) requestAnimationFrame(draw); };
    draw();
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((ok) => (rec.onstop = ok));
    rec.start();
    await new Promise((ok) => setTimeout(ok, 2000));
    rec.stop();
    await done;
    run = false;
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
  await page.getByTestId('upload').setInputFiles({ name: 'obs-clip.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes) });
  const row = page.getByTestId('clip-list').locator('tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Upload')).toBeVisible();
  await expect(row.locator('td').nth(4)).toHaveText('320x180');
});

test('without screen capture the page points to upload', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined }));
  await page.reload();
  await expect(page.getByText('This browser cannot record the screen here')).toBeVisible();
});
