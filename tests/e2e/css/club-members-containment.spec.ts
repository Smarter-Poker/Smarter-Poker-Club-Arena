/** Render the production roster stylesheet inside a narrower application shell.
 * Document overflow alone misses controls hidden by the page's overflow clip. */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS = readFileSync(resolve(process.cwd(), 'src/pages/ClubMembersPage.css'), 'utf8');

for (const width of [375, 393]) {
  test(`Simple roster fields avoid phone zoom and fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.setContent(`
      <style>${CSS}
        *, *::before, *::after { box-sizing: border-box; }
        html, body { margin: 0; background: #000; }
        .application-shell { width: calc(100% - 32px); margin: auto; }
      </style>
      <main class="application-shell"><section class="club-members-page members-simple">
        <section class="members-console">
          <label class="members-search"><input type="search" aria-label="Search Club Members" /></label>
          <div class="members-toolbar">
            <button class="members-group-role">Group By Role</button>
            <label class="members-sort"><span class="members-sort__label">Sort By</span>
              <select aria-label="Sort Players"><option>Role Hierarchy</option></select></label>
            <button class="members-refresh">Refresh</button>
          </div>
        </section>
      </section></main>`);
    for (const field of [page.getByRole('searchbox'), page.getByRole('combobox')]) {
      expect(
        await field.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
      ).toBe(16);
    }
    const toolbar = await page.locator('.members-toolbar').boundingBox();
    expect(toolbar).not.toBeNull();
    for (const control of [
      page.getByRole('button', { name: 'Group By Role' }),
      page.getByRole('combobox'),
      page.getByRole('button', { name: 'Refresh' }),
    ]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(toolbar!.x - 0.5);
      expect(box!.x + box!.width).toBeLessThanOrEqual(toolbar!.x + toolbar!.width + 0.5);
      expect(
        await control.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      ).toBe(true);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(1);
  });
}

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

/* THE CONSOLE SCROLLS AWAY ON A PHONE (2026-10-12).
 *
 * The Find A Player console was `position: sticky; top: 0` at every width up
 * to 720px. On 2026-10-11 #6693 added the Export Scope note and the Metric
 * Definitions disclosure to it, and at 375 x 812 the pinned console grew to
 * roughly 570px: the roster beneath it showed one partial row, and opening
 * Metric Definitions made the console taller than the screen, so its last
 * definitions sat under the bottom navigation where no scroll could reach
 * them. Post-Deploy E2E run 38203364589 caught it in production
 * (mobile-chrome-occlusion: "Wallets And Fees Are In Club Chips" 74px under
 * the bar). On a phone the console scrolls with the page; the roster and every
 * definition must be reachable by scrolling. */
const DEFINITIONS = [
  'Downlines: Players In The Recursive Downline, Excluding This Player.',
  'Player Wallet: Current Club Member Chip Balance. Agent Wallet: Current Active Agent Chip Balance. Wallets Are An Optional Column And Never Replace Fees.',
  'Fees Generated (Indiv. Fees): Cash Game Rake Attributed To This Player Plus Their Tournament Entry Fees. Downline Fees: Fees Generated By The Recursive Downline Only, Excluding This Player.',
  'Fees Are Read From The Club Fee Ledgers That Pay Agents And Rakeback, All Time, With No Date Filter On This Roster. Wallets And Fees Are In Club Chips.',
  'Recent Activity Uses Login Time When Available, Otherwise Presence Or Club Activity Time. Online Includes Players At A Live Table Or With Fresh Presence.',
  'Select Loaded Selects Only Players Already Loaded. Export Without A Selection Reads All Authorized Matches Across Every Page. A Selection Is Further Limited By The Current Filter And Search.',
];

for (const width of [375, 393]) {
  for (const definitionsOpen of [false, true]) {
    test(`the roster and every metric definition are reachable at ${width}px with definitions ${
      definitionsOpen ? 'open' : 'closed'
    }`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      const rows = Array.from(
        { length: 40 },
        (_, i) =>
          `<div class="member-row" role="listitem" style="min-height:64px"><button class="member-row__open">Player ${
            i + 1
          }</button></div>`
      ).join('');
      await page.setContent(`
        <style>
          ${CSS}
          *, *::before, *::after { box-sizing: border-box; }
          html, body { margin: 0; background: #000; color: #fff; }
          .application-shell { width: calc(100% - 32px); margin: auto; padding-bottom: 96px; }
          .bottom-nav { position: fixed; left: 0; right: 0; bottom: 0; height: 72px; background: #111; z-index: 50; }
        </style>
        <main class="application-shell"><section class="club-members-page">
          <section class="members-hero"><div class="members-hero__content">Player Command</div></section>
          <section class="members-console">
            <div class="members-console__heading"><h2>Find A Player</h2></div>
            <label class="members-search"><span>Search The Roster</span>
              <input type="search" aria-label="Search Club Members" /></label>
            <div class="members-filter-rail"><div class="members-filters">
              <button>All Players</button><button>At Tables</button><button>Online</button>
            </div></div>
            <div class="members-toolbar">
              <label class="members-sort"><span class="members-sort__label">Sort By</span>
                <select aria-label="Sort Players"><option>Role Hierarchy</option></select></label>
              <details class="members-columns"><summary>Columns</summary></details>
              <button class="members-select-loaded">Select Loaded</button>
              <button class="members-refresh">Refresh</button>
              <button class="members-export">Export CSV</button>
            </div>
            <p class="members-count" role="note" aria-label="Export Scope"><strong>Export Scope: </strong>
              <span>All Matching Players Across Every Page</span> Includes Authorized Fields Regardless Of Visible Columns.</p>
            <details class="members-columns" ${definitionsOpen ? 'open' : ''}>
              <summary>Metric Definitions</summary>
              <div class="members-count">${DEFINITIONS.map((d) => `<p>${d}</p>`).join('')}</div>
            </details>
          </section>
          <section class="members-list" role="list" aria-label="Club Member Directory">
            <div class="members-viewport">${rows}</div>
          </section>
          <div class="members-count" role="status">Loaded 40 Of 40 Players</div>
        </section></main>
        <nav class="bottom-nav" aria-label="Club"></nav>`);

      // Every probe asks the browser what a finger would actually land on.
      const reachable = (selector: string, block: 'center') =>
        page.locator(selector).evaluate((element, b) => {
          element.scrollIntoView({ block: b as ScrollLogicalPosition, behavior: 'instant' });
          const navTop = document.querySelector('.bottom-nav')!.getBoundingClientRect().top;
          const r = element.getBoundingClientRect();
          const x = r.left + Math.min(r.width / 2, 40);
          const y = Math.min(r.top + r.height / 2, navTop - 2);
          const hit = document.elementFromPoint(x, y);
          return {
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            navTop: Math.round(navTop),
            onIt: Boolean(hit && (hit === element || element.contains(hit))),
            hit: hit ? hit.className || hit.tagName : null,
          };
        }, block);

      const firstRow = await reachable('.member-row >> nth=0', 'center');
      expect(
        firstRow.onIt,
        `the first roster row is covered at ${width}px: ${JSON.stringify(firstRow)}`
      ).toBe(true);
      const tenthRow = await reachable('.member-row >> nth=9', 'center');
      expect(
        tenthRow.onIt,
        `a roster row is covered at ${width}px: ${JSON.stringify(tenthRow)}`
      ).toBe(true);

      if (definitionsOpen) {
        for (let i = 0; i < DEFINITIONS.length; i += 1) {
          const definition = await reachable(
            `.members-columns[open] .members-count p >> nth=${i}`,
            'center'
          );
          expect(
            definition.onIt && definition.bottom <= definition.navTop,
            `metric definition ${i + 1} cannot be scrolled clear of the bottom bar at ${width}px: ${JSON.stringify(definition)}`
          ).toBe(true);
        }
      }
    });
  }
}
