import { chromium } from 'playwright';
const [, , url, out] = process.argv;
const b = await chromium.launch({ executablePath: process.env.CHROME });
const p = await b.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
p.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
await p.goto(url, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(1500);
for (const el of await p.$$('[data-card]')) {
  const key = await el.getAttribute('data-card');
  await p.screenshot({ path: `${out}/${key}.png`, fullPage: true });
}
await b.close();
