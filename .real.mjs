import { chromium } from 'playwright';
const b = await chromium.launch({ headless: false, args: ['--auto-select-tab-capture-source-by-title=Backtrack', '--use-fake-ui-for-media-stream'] });
const p = await b.newPage();
p.on('console', (m) => console.log('console', m.type(), m.text()));
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto('http://localhost:5175/');
await p.getByTestId('buffer-s').fill('5'); await p.getByTestId('buffer-s').press('Enter');
await p.getByTestId('rec-start').click();
for (let i = 0; i < 8; i++) { await p.waitForTimeout(1000); console.log('status', await p.getByTestId('rec-status').innerText()); }
await p.getByTestId('rec-save').click();
for (let i = 0; i < 10; i++) {
  await p.waitForTimeout(1000);
  const note = await p.locator('[data-testid=rec-note]').allInnerTexts();
  const err = await p.locator('[role=alert]').allInnerTexts();
  const rows = await p.locator('[data-testid=clip-list] tbody tr').count();
  console.log('after save', i, note, err, 'rows', rows);
}
await b.close();
