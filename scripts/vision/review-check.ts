/**
 * Opens the Review phase on a detected section, as a user does: uploads a clip of test-data/, picks the map, selects
 * the section on the ruler of Mark, detects, then opens Review. Saves screenshots and prints page errors. Needs the dev
 * server (bun run dev --port 5175).
 * usage: node scripts/vision/review-check.ts "<clip file>" <map> <a> <b>   (SHOT=<png path>)
 */
import { chromium } from '@playwright/test';

const [clip, map, a, b] = process.argv.slice(2);
const shot = process.env.SHOT ?? 'review-check.png';
const stop = setTimeout(() => { console.log('gave up'); process.exit(1); }, Number(process.env.LIMIT ?? 150) * 1000);
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
await page.getByTestId('settings').click();
await page.getByTestId('fov-input').fill(process.env.FOV ?? '100');
await page.getByTestId('settings-save').click();
const d = Number(await page.getByTestId('time').getAttribute('data-d'));
const ruler = page.getByTestId('ruler');
const r = (await ruler.boundingBox())!, at = (t: number) => r.x + (t / d) * r.width, y = r.y + r.height / 2;
await page.mouse.move(at(Number(a)), y);
await page.mouse.down();
await page.mouse.move(at((Number(a) + Number(b)) / 2), y);
await page.mouse.move(at(Number(b)), y);
await page.mouse.up();
await page.getByTestId('detect').click();
await page.getByTestId('section-panel').getByText('Section', { exact: true }).waitFor({ timeout: 110_000 });
await page.getByTestId('phase-review').click();
// halfway through the slide from Mark to Review
await page.waitForTimeout(110);
await page.screenshot({ path: shot.replace(/[.]png$/, '-slide.png') });
await page.getByTestId('dock').waitFor();
await page.waitForTimeout(4000);
await page.screenshot({ path: shot });
console.log('findings', await page.locator('[data-testid^="finding-"]').count());
// a shell finding opens its numbers and moves the player to its time
const f = page.locator('[data-testid="finding-shell"] .tx').first();
if (await f.count()) { await f.click(); await page.waitForTimeout(2500); await page.screenshot({ path: shot.replace(/[.]png$/, '-open.png') }); }
// the dock: drag the result tab to the right side of the video, look at the preview after the dwell, and drop it
const tab = (await page.getByTestId('tab-result').boundingBox())!, vid = (await page.locator('[data-win="video"]').boundingBox())!;
await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
await page.mouse.down();
await page.mouse.move(vid.x + vid.width * 0.9, vid.y + vid.height * 0.5, { steps: 12 });
await page.waitForTimeout(250);
await page.screenshot({ path: shot.replace(/[.]png$/, '-zones.png') });
await page.waitForTimeout(700);
await page.screenshot({ path: shot.replace(/[.]png$/, '-preview.png') });
await page.mouse.up();
await page.waitForTimeout(500);
await page.screenshot({ path: shot.replace(/[.]png$/, '-dropped.png') });
await page.getByTestId('expand-scene').click();
await page.waitForTimeout(600);
await page.screenshot({ path: shot.replace(/[.]png$/, '-expanded.png') });
await page.getByTestId('restore-scene').click();
await page.waitForTimeout(600);
clearTimeout(stop);
await browser.close();
