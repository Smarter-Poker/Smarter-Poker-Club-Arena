/** What do these four routes ACTUALLY render in production, signed in? NOT COMMITTED. */
import { chromium } from '@playwright/test';
import fs from 'fs';

const state = 'tests/e2e/.auth/state.json';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  storageState: fs.existsSync(state) ? state : undefined,
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();
const BASE = 'https://smarter.poker/hub/club-arena/';

for (const route of ['unions', 'cashier', 'help']) {
  try {
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.log(route, 'GOTO', String(e).split('\n')[0]);
  }
  await page.waitForTimeout(4000);
  const txt = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 260);
  console.log(`\n=== ${route} | url=${page.url().replace(BASE, '')}\n${txt}`);
}
await browser.close();
