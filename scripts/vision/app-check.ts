/**
 * Runs the detection in the app, as a user does: uploads a clip of test-data/, picks the map, selects the section on
 * the ruler and presses Detect. Prints what the panel and the sightings show. Needs the dev server (bun run dev).
 * usage: node scripts/vision/app-check.ts "<clip file>" <map> <a> <b>
 */
import { chromium } from '@playwright/test';

const [clip, map, a, b] = process.argv.slice(2);
const stop = setTimeout(() => { console.log('gave up'); process.exit(1); }, Number(process.env.LIMIT ?? 120) * 1000);
const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log('page error', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text()); });
await page.goto('http://localhost:5175/');
await page.getByTestId('upload').setInputFiles(`test-data/${clip}`);
await page.getByTestId('clip-list').locator('tbody tr').first().waitFor({ timeout: 60_000 });
await page.getByTestId('phase-mark').click();
await page.getByTestId('viewer').waitFor();
await page.getByTestId('map-choice').getByRole('button', { name: new RegExp(map, 'i') }).click();
// the FOV of the test clips
await page.getByTestId('settings').click();
await page.getByTestId('fov-input').fill(process.env.FOV ?? '100');
await page.getByTestId('settings-save').click();
const d = Number(await page.getByTestId('time').getAttribute('data-d'));
const ruler = page.locator('[title^="Drag to select a section"]');
const r = (await ruler.boundingBox())!, at = (t: number) => r.x + (t / d) * r.width, y = r.y + r.height / 2;
await page.mouse.move(at(Number(a)), y);
await page.mouse.down();
await page.mouse.move(at((Number(a) + Number(b)) / 2), y);
await page.mouse.move(at(Number(b)), y);
await page.mouse.up();
const t0 = Date.now();
await page.getByTestId('detect').click();
await page.getByTestId('section-panel').getByText('Section', { exact: true }).waitFor({ timeout: 110_000 });
console.log(`detected in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log((await page.getByTestId('section-panel').innerText()).replace(/\n+/g, ' | '));
console.log('sightings', await page.getByTestId('sighting').count());
console.log('first sighting:', (await page.getByTestId('sighting').first().innerText()).replace(/\n+/g, ' | ').slice(0, 400));
// the stabilized view next to the video, on a frame of the section
await page.getByTestId('view-both').click();
await page.getByTestId('sighting').nth(Math.floor((await page.getByTestId('sighting').count()) / 2)).getByRole('button', { name: /^Sighting/ }).click();
await page.waitForTimeout(1500);
const shot = process.env.SHOT ?? 'app-check.png';
await page.screenshot({ path: shot });
// the video with what the detection used on this frame, and the result with its map and the misses
await page.getByTestId('view-video').click();
await page.waitForTimeout(800);
await page.screenshot({ path: shot.replace(/[.]png$/, '-video.png') });
await page.getByTestId('phase-result').click();
await page.getByTestId('shot-result').first().waitFor({ timeout: 60_000 });
await page.getByTestId('miss-chart').first().waitFor({ timeout: 60_000 }).catch(() => console.log('no miss chart'));
await page.waitForTimeout(1500);
console.log('result:', (await page.getByTestId('shot-result').first().innerText()).replace(/\n+/g, ' | ').slice(0, 500));
await page.screenshot({ path: shot.replace(/[.]png$/, '-result.png'), fullPage: true });
// the sightings near the crater: zoom the map in on the crater of the first shot (the map starts on the whole result)
const box = (await page.getByTestId('result-map').boundingBox())!;
const zoomAt = { x: Number(process.env.MAPX ?? box.x + box.width / 2), y: Number(process.env.MAPY ?? box.y + box.height / 2) };
await page.mouse.move(zoomAt.x, zoomAt.y);
for (let k = 0; k < Number(process.env.WHEEL ?? 8); k++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(100); }
await page.waitForTimeout(1500);
await page.screenshot({ path: shot.replace(/[.]png$/, '-map.png') });
clearTimeout(stop);
await browser.close();
