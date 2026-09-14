import { after, before, it } from 'node:test';
import { webkit } from '@playwright/test';
import { verifyLobbyScrollClearance } from '../e2e/helpers/lobby-scroll-clearance.mjs';
let browser;
before(async () => {
  browser = await webkit.launch();
});
after(async () => {
  await browser?.close();
});
for (const width of [375, 390])
  it(`actual CSS WebKit View clearance at ${width}px`, async () => {
    const page = await browser.newPage({ isMobile: true, hasTouch: true });
    try {
      await verifyLobbyScrollClearance(page, width, (proof) => console.log(JSON.stringify(proof)));
    } finally {
      await page.close();
    }
  });
