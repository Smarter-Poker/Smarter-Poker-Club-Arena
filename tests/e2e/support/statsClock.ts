import { expect, type Locator, type Page } from '@playwright/test';

/** Drive the real exit animation without spending the initial debounce budget. */
export async function mountStatsPaneBeforeDebounce(page: Page, pane: Locator): Promise<number> {
  let advanced = 0;
  await expect
    .poll(
      async () => {
        await page.clock.runFor(0);
        if (await pane.count()) return true;
        const frame = Math.min(16, 299 - advanced);
        if (frame > 0) {
          await page.clock.runFor(frame);
          advanced += frame;
        }
        return (await pane.count()) > 0;
      },
      { intervals: [0] }
    )
    .toBe(true);
  return advanced;
}
