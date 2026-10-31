/** Render the production roster stylesheet inside a narrower application shell.
 * Document overflow alone misses controls hidden by the page's overflow clip. */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS = readFileSync(resolve(process.cwd(), 'src/pages/ClubMembersPage.css'), 'utf8');
const PAGE_BAR_CSS = readFileSync(
  resolve(process.cwd(), 'src/components/help/PageHelp.css'),
  'utf8'
);

// The real PageBar prints controls before its title. Include its owning sheet:
// roster-only fixtures cannot detect a title painted over the Advanced button.
for (const width of [320, 375, 393, 568, 1440]) {
  for (const textScale of [100, 200]) {
    test(`page titles and live actions remain reachable at ${width}px and ${textScale}% text`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 812 });
      await page.setContent(`
        <style>${CSS}\n${PAGE_BAR_CSS}
          *, *::before, *::after { box-sizing: border-box; }
          html { font-size: ${textScale}%; }
          body { margin: 0; background: #000; color: #fff; }
          main { width: calc(100% - 32px); margin: auto; }
        </style>
        <main><header class="ca-page-bar members-page-bar">
          <div class="ca-page-bar__live"><div class="members-mode-toggle">
            <button type="button">Simple</button><button type="button">Advanced</button>
          </div></div>
          <h1 class="ca-page-bar__title">Player Management</h1>
          <button type="button" class="ca-page-help" aria-label="Page Help">?</button>
        </header></main>`);
      const advanced = page.getByRole('button', { name: 'Advanced', exact: true });
      await advanced.click({ timeout: 1500 });
      await page.getByRole('button', { name: 'Page Help', exact: true }).click({ timeout: 1500 });
      for (const title of ['Player Management', 'Monthly Challenges']) {
        await page.locator('h1').evaluate((heading, text) => {
          heading.textContent = text;
        }, title);
        const geometry = await page.locator('h1').evaluate((heading) => {
          const box = heading.getBoundingClientRect();
          const bar = heading.parentElement!.getBoundingClientRect();
          return {
            inside: box.left >= bar.left - 1 && box.right <= bar.right + 1,
            readable: heading.scrollWidth <= heading.clientWidth + 1,
            centerError: Math.abs((box.left + box.right - bar.left - bar.right) / 2),
          };
        });
        expect(geometry.inside, `${title} escapes its page at enlarged text`).toBe(true);
        expect(geometry.readable, `${title} clips its text`).toBe(true);
        expect(geometry.centerError, `${title} is not centered`).toBeLessThanOrEqual(1);
      }
      await page.locator('h1').evaluate((heading) => heading.remove());
      await advanced.click({ timeout: 1500 });
      const [live, help] = await Promise.all([
        page.locator('.ca-page-bar__live').boundingBox(),
        page.getByRole('button', { name: 'Page Help', exact: true }).boundingBox(),
      ]);
      expect(live).not.toBeNull();
      expect(help).not.toBeNull();
      expect(live!.y, 'mode controls must sit below Page Help').toBeGreaterThanOrEqual(
        help!.y + help!.height
      );
      const mode = await page.locator('.members-mode-toggle').boundingBox();
      expect(mode).not.toBeNull();
      expect(
        Math.abs(mode!.x + mode!.width - help!.x - help!.width),
        'mode controls must align with the right edge of Page Help'
      ).toBeLessThanOrEqual(1);
    });
  }
}

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
            <label class="members-sort members-winloss-period"><span class="members-sort__label">Win / Loss</span>
              <select aria-label="Win And Loss Period"><option>Win / Loss This Week</option></select></label>
            <label class="members-sort"><span class="members-sort__label">Sort By</span>
              <select aria-label="Sort Players"><option>Newest Players First</option></select></label>
          </div>
        </section>
      </section></main>`);
    for (const field of [
      page.getByRole('searchbox'),
      ...(await page.getByRole('combobox').all()),
    ]) {
      expect(
        await field.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
      ).toBe(16);
    }
    const toolbar = await page.locator('.members-toolbar').boundingBox();
    expect(toolbar).not.toBeNull();
    for (const control of [
      page.getByRole('button', { name: 'Group By Role' }),
      ...(await page.getByRole('combobox').all()),
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
        <header class="ca-page-bar members-page-bar"><h1 class="ca-page-bar__title">Player Management</h1><div class="ca-page-bar__live"><div class="members-mode-toggle"><button>Simple</button><button>Advanced</button></div></div><button class="ca-page-help" aria-label="Page Help"></button></header>
        <section class="members-console">
          <div class="members-console__heading"><h2>Find A Player</h2></div>
          <label class="members-search"><span>Search Players</span>
            <input type="search" aria-label="Search Club Members" placeholder="Search Name, Number, Club, Or Upline" /></label>
          <div class="members-toolbar">
            <label class="members-sort"><span class="members-sort__label">Sort</span>
              <select aria-label="Sort Players"><option>Role Hierarchy</option></select></label>
            <button class="members-select-loaded">Select Loaded</button>
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
      '.members-page-bar',
      '.members-console',
      '.members-bulk',
      '.members-list',
      '.members-count',
      '.members-search',
      '.members-search input',
      '.members-sort',
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
  'Fees Are Read From The Club Fee Ledgers That Pay Agents And Rakeback. They Count From The Week Of October 12, 2026 (Monday Midnight Pacific) And Keep Accumulating From Then On, With No Weekly Reset. Wallets And Fees Are In Club Chips.',
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
          <header class="ca-page-bar members-page-bar"><h1 class="ca-page-bar__title">Player Management</h1><div class="ca-page-bar__live"><div class="members-mode-toggle"><button>Simple</button><button>Advanced</button></div></div><button class="ca-page-help" aria-label="Page Help"></button></header>
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

/* THE PLAYERS LIST FITS A PHONE (Dan, 2026-10-25): "PLAYER MANAGEMENT ON
 * MOBILE NEEDS TO BE OPTIMIZED FOR MOBILE. DATA IS CUT OFF, FONTS ARE TOO
 * LARGE ITS A MESS." At 320px (an iPhone with Display Zoom) the name, upline,
 * PlayerID and last-seen were each clipped mid-word and the last line fell out
 * of the fixed-height row. Every ordinary name, upline, PlayerID, role and
 * status prints in full and inside its row at every phone width. */
const PHONE_ROWS = [
  { alias: 'PostDealerDelux', role: 'Admin', id: '1004114', status: 'Online' },
  {
    alias: 'CoachTimTheGreat',
    upline: 'TrustedAgentMike',
    id: '4418820931',
    status: 'Seen 23 Hours Ago',
  },
  {
    alias: 'Bhrine',
    upline: 'KingFishSupreme',
    role: 'Agent',
    id: '2299001845',
    status: 'At Table',
    downline: '12.3K',
  },
];
for (const width of [320, 360, 375, 393, 430]) {
  test(`every player row prints its name, upline, PlayerID and status in full at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    const rows = PHONE_ROWS.map(
      (
        m
      ) => `<div class="member-row" role="listitem"><button type="button" class="member-row__open">
        <span class="member-avatar"><span>${m.alias[0]}</span></span>
        <span class="member-main"><span class="member-identity"><span class="member-alias">${m.alias}</span>${
          m.upline ? `<span class="member-upline">Upline: ${m.upline}</span>` : ''
        }</span><span class="member-subline">${m.role ? `<span class="member-role">${m.role}</span>` : ''}<span class="member-number">PlayerID: ${m.id}</span><span class="member-seen">${m.status}</span></span>
        <span class="member-simple-balance"><strong>5.73</strong><span>Fees Generated</span>${
          m.downline
            ? `<span class="member-simple-balance__downline">Downline ${m.downline}</span>`
            : ''
        }<strong class="member-simple-balance__winloss">-1.2K</strong></span></span>
        <span class="member-chevron" aria-hidden="true">&rsaquo;</span></button></div>`
    ).join('');
    await page.setContent(`
      <style>${CSS}
        *, *::before, *::after { box-sizing: border-box; }
        html, body { margin: 0; background: #000; color: #fff; }
        .application-shell { width: calc(100% - 32px); margin: auto; }
      </style>
      <main class="application-shell"><section class="club-members-page members-simple">
        <section class="members-list" role="list">${rows}</section>
      </section></main>`);
    const problems = await page.evaluate(() => {
      const found: string[] = [];
      document.querySelectorAll('.member-row').forEach((row) => {
        const r = row.getBoundingClientRect();
        row
          .querySelectorAll(
            '.member-alias, .member-upline, .member-number, .member-role, .member-seen, .member-simple-balance > *'
          )
          .forEach((e) => {
            const b = e.getBoundingClientRect();
            if (e.scrollWidth > e.clientWidth + 1) found.push(`clipped: ${e.textContent}`);
            if (b.top < r.top || b.bottom > r.bottom || b.right > r.right)
              found.push(`outside its row: ${e.textContent}`);
          });
        const alias = row.querySelector('.member-alias')!;
        if (
          alias.getBoundingClientRect().height >
          parseFloat(getComputedStyle(alias).fontSize) * 1.6
        )
          found.push(`name broke over two lines: ${alias.textContent}`);
      });
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
        found.push('page scrolls sideways');
      return found;
    });
    expect(problems, `player rows at ${width}px`).toEqual([]);
  });
}
