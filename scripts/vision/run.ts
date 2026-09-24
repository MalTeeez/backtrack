/**
 * Runs scripts/vision/harness.html in headless Chromium against the dev server (bun run dev) and prints its log.
 * usage: node scripts/vision/run.ts "<clip file in test-data>" <a> <b> [key=value ...]
 * It runs on Node: Bun cannot launch the browser of Playwright on Windows. It gives up after LIMIT seconds (default 90).
 */
import { writeFileSync } from 'node:fs';
import { chromium, firefox } from '@playwright/test';

const [clip, a, b, ...rest] = process.argv.slice(2);
const q = new URLSearchParams({ clip, a, b, ...Object.fromEntries(rest.map((kv) => kv.split('='))) });
const limit = Number(process.env.LIMIT ?? 90) * 1000;
const stop = setTimeout(() => { console.log(`gave up after ${limit / 1000} s`); process.exit(1); }, limit);
// WebGPU: the full Chromium build (the headless shell has no DirectX shader compiler), with WebGPU on
const browser = process.env.BROWSER === 'firefox' ? await firefox.launch() : await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu'] });
console.log('browser up');
const page = await browser.newPage();
page.on('console', (m) => console.log(m.text()));
page.on('pageerror', (e) => console.log('page error', e.message));
await page.goto(`http://localhost:5175/scripts/vision/harness.html?${q}`);
await page.waitForFunction(() => (window as { __result?: unknown; __error?: string }).__result || (window as { __error?: string }).__error, null, { timeout: 0, polling: 250 });
const out = await page.evaluate(() => (window as { __result?: unknown }).__result);
if (process.env.OUT && out) writeFileSync(process.env.OUT, JSON.stringify(out, null, 1));
// pictures of the harness, to look at (IMG=<folder>)
if (process.env.IMG) {
  const imgs = await page.evaluate(() => (window as { __images?: Record<string, string> }).__images ?? {});
  for (const [name, url] of Object.entries(imgs)) writeFileSync(`${process.env.IMG}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
}
clearTimeout(stop);
await browser.close();
