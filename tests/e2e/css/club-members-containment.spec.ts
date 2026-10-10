/** Render the production roster stylesheet inside a narrower application shell.
 * Document overflow alone misses controls hidden by the page's overflow clip. */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS = readFileSync(resolve(process.cwd(), 'src/pages/ClubMembersPage.css'), 'utf8');

for (const width of [1449, 375, 393]) {
  test(`roster surfaces and controls fit their containing page at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.setContent(`
      <style>
        ${CSS}
        *, *::before, *::after { box-sizing: border-box; }
        html, body { margin: 0; background: #000; }
        .application-shell { width: calc(100% - ${width > 720 ? 97 : 32}px); margin: auto; }
      </style>
      <main class="application-shell"><section class="club-members-page">
        <section class="members-hero"><div class="members-hero__content">Player Command</div></section>
        <section class="members-console">
          <div class="members-console__heading"><h2>Find A Player</h2></div>
          <label class="members-search"><span>Search Players</span>
            <input type="search" aria-label="Search Club Members" placeholder="Search Name, Number, Club, Or Upline" /></label>
          <div class="members-toolbar">
            <label class="members-sort"><span class="members-sort__label">Sort</span>
              <select aria-label="Sort Players"><option>Role Hierarchy</option></select></label>
            <button class="members-select-loaded">Select Loaded</button>
            <button class="members-refresh">Refresh</button>
            <details class="members-columns"><summary>Columns</summary></details>
            <button class="members-export">Export CSV</button>
          </div>
        </section>
        <div class="members-bulk"><strong>1 Player Selected</strong><button>Clear</button></div>
        <section class="members-list" role="list" aria-label="Club Member Directory">
          <div class="member-row" role="listitem"><button class="member-row__open">Alice</button></div>
        </section>
        <div class="members-count">Loaded 1 Of 1 Players</div>
      </section></main>`);
    const frame = await page.locator('.club-members-page').boundingBox();
    expect(frame).not.toBeNull();
    const shell = await page.locator('.application-shell').boundingBox();
    expect(shell).not.toBeNull();
    expect(
      frame!.x,
      'the roster page escapes its application shell on the left'
    ).toBeGreaterThanOrEqual(shell!.x - 0.5);
    expect(
      frame!.x + frame!.width,
      'the roster page escapes its application shell on the right'
    ).toBeLessThanOrEqual(shell!.x + shell!.width + 0.5);
    // Old CSS still reports zero document overflow because the page clips it.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(1);
    for (const selector of [
      '.members-hero',
      '.members-console',
      '.members-bulk',
      '.members-list',
      '.members-count',
      '.members-search',
      '.members-search input',
      '.members-sort',
      '.members-refresh',
      '.members-columns',
      '.members-select-loaded',
      '.members-export',
      '.member-row__open',
    ]) {
      const box = await page.locator(selector).boundingBox();
      expect(box, `${selector} must render`).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.x, `${selector} is clipped at the left page edge`).toBeGreaterThanOrEqual(
        frame!.x - 0.5
      );
      expect(
        box!.x + box!.width,
        `${selector} is clipped at the right page edge`
      ).toBeLessThanOrEqual(frame!.x + frame!.width + 0.5);
    }
    const consoleBox = await page.locator('.members-console').boundingBox();
    for (const selector of [
      '.members-search input',
      '.members-sort',
      '.members-refresh',
      '.members-columns',
      '.members-select-loaded',
      '.members-export',
    ]) {
      const box = await page.locator(selector).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(consoleBox!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(consoleBox!.x + consoleBox!.width);
      const readable = await page
        .locator(selector)
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
      expect(readable, `${selector} clips its own control content`).toBe(true);
    }
  });
}
