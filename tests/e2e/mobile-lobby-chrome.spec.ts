/**
 * THE THREE MOBILE LOBBY DEFECTS DAN PHOTOGRAPHED ON 2026-09-09, MEASURED.
 *
 * `tests/the-mobile-lobby-chrome-stays-fixed.law.test.ts` pins the SOURCE of
 * each fix. This pins the RESULT: it renders the real stylesheets with the real
 * lobby markup at phone widths and measures what a thumb would meet. A future
 * edit that keeps every declaration the law looks for but breaks the layout
 * anyway (a font-size bump that clips the plate again, an ancestor that turns
 * into a scroll container and kills the sticky, a stacking context that puts a
 * card over the sort row) fails here and nowhere else.
 *
 * Same fixture convention as club-mobile-wallet-reach.spec.ts: real CSS read
 * from disk, real nesting, no account, no server, so it runs in CSS Beat E2E
 * before merge. The art does not load under setContent and does not need to:
 * every zone under test is positioned in percentages of a box whose shape comes
 * from `aspect-ratio`, not from the pixels.
 *
 * WHY THE OLD FOOTER SPEC DID NOT CATCH THE GAP. footer-route.spec.ts asserts
 * that the NAV BOX reaches the viewport's bottom edge. It did; the transparent
 * safe-area padding inside it reached the edge while the painted frame floated
 * above it with the lobby showing through. This measures the artwork, which is
 * the thing the eye sees.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const css = (p: string) => readFileSync(p, 'utf8');

const SHEETS = [
  'src/styles/globals.css',
  'src/pages/ClubHomePage.css',
  'src/components/lobby/ClubLobbyCommandTop.css',
  'src/components/lobby/LobbyTable.css',
  'src/components/lobby/LobbySortBar.css',
  'src/pages/ClubHomeMobilePremium.css',
  'src/components/club/ClubBottomNav.module.css',
]
  .map(css)
  .join('\n');

/** The painted MY WALLETS title's optical centre, measured off the master art. */
const TITLE_CENTRE_PCT = 54.65;

/** The real GlobalHeader publishes this after measuring itself. */
const HEADER_HEIGHT_PX = 40;

function lobby(opts: { countText: string; publishControlsHeight: boolean; inTab?: boolean }) {
  return `
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      ${SHEETS}
      /* Fixture-only: stand-ins for the header and the card component. */
      html, body { margin: 0; background: #000; }
      .fx-header { position: fixed; inset: 0 0 auto 0; height: ${HEADER_HEIGHT_PX}px; z-index: 900; background: #0b1117; }
      .fx-spacer { height: ${HEADER_HEIGHT_PX}px; }
      .fx-plaque { height: 84px; margin: 4px; }
      .fx-card { width: 100%; height: 640px; background: #0d141a; }
    </style>
    <div class="fx-header"></div>
    <div class="fx-spacer"></div>
    <div class="club-home club-home--unified-mobile">
      <header class="lobby-top">
        <div class="lobby-top__main">
          <div class="fx-plaque"></div>
          <div class="fx-plaque"></div>
          <div class="lobby-top__wallet">
            <button type="button" class="lobby-wallets-trigger" aria-expanded="false">
              <span class="lobby-wallets-trigger__icon" aria-hidden="true"></span>
              <span class="lobby-wallets-trigger__copy">
                <strong>My Wallets</strong>
                <small>${opts.countText}</small>
              </span>
              <span class="lobby-wallets-trigger__chevron" aria-hidden="true"></span>
            </button>
          </div>
        </div>
      </header>
      <section class="club-lobby-machine" aria-label="Game Lobby">
        <div class="club-lobby-command-top">
          <div class="club-lobby-command-top__welcome club-lobby-command-top__welcome--approved-universal">
            <div class="lobby-top__notice"><div class="club-lobby-command-top__welcome-copy">
              <span class="club-lobby-command-top__welcome-eyebrow">Welcome To The</span>
              <h2 class="club-lobby-command-top__club-name">Shark Club</h2>
            </div></div>
          </div>
          <div class="club-lobby-command-top__controls">
            <section class="lobby-controls" aria-label="Browse Games">
              <div class="lobby-controls__heading">
                <div>
                  <span class="lobby-controls__eyebrow">Live Club Schedule</span>
                  <strong class="lobby-controls__title">Find Your Game</strong>
                </div>
                <div class="lobby-controls__operator-actions"><span class="lobby-controls__total"><strong>258</strong> Games</span></div>
              </div>
              <div class="game-bar">
                <div class="game-bar__types" role="tablist">
                  ${['All', 'MTT', 'NLH', 'PLO', 'Limit', 'Spins', 'Heads Up']
                    .map(
                      (t) =>
                        `<button type="button" role="tab" class="game-bar__type${t === 'NLH' ? ' is-active' : ''}">${t}</button>`
                    )
                    .join('')}
                </div>
                <button type="button" class="game-bar__filter-btn"><span>Filters</span></button>
              </div>
              <div class="quickprefs"><div class="quickprefs__row quickprefs__row--status">
                ${['All', 'Full', 'Empty', 'Open Seats', 'Favorites']
                  .map(
                    (s) =>
                      `<button type="button" class="quickprefs__chip${s === 'All' ? ' is-on' : ''}">${s}</button>`
                  )
                  .join('')}
              </div></div>
            </section>
          </div>
          <div class="club-lobby-command-top__campaign"><div class="fx-plaque"></div></div>
        </div>
        <div class="club-home__games club-home__games--v2">
          <div class="lobby-sortbar" role="toolbar" aria-label="Sort Games">
            <span class="lobby-sortbar__eyebrow">Sort</span>
            <div class="lobby-sortbar__chips">
              ${['Game', 'Stakes', 'Variant', 'Players', 'Buy-In', 'Status']
                .map(
                  (c) =>
                    `<button type="button" class="lobby-sortbar__chip${c === 'Stakes' ? ' is-active' : ''}"><span class="lobby-sortbar__label">${c}</span><span class="lobby-sortbar__mark" aria-hidden="true">&#9652;&#9662;</span></button>`
                )
                .join('')}
            </div>
          </div>
          <div class="arena-lobby-card-list" aria-label="Game Cards">
            <div><div class="fx-card"></div></div>
            <div><div class="fx-card"></div></div>
            <div><div class="fx-card"></div></div>
            <div><div class="fx-card"></div></div>
          </div>
        </div>
      </section>
    </div>
    <!-- Where a fixed element at bottom: 0 lands IS the bottom edge. innerHeight
         is not: WebKit's mobile emulation reports it 12px taller than the layout
         viewport fixed elements attach to; Chromium reports them equal. -->
    <div class="fx-edge" style="position: fixed; bottom: 0; left: 0; width: 1px; height: 1px; pointer-events: none"></div>
    <nav class="bottomNav" aria-label="Poker Arena" data-footer-hidden="false">
      <div class="viewport"><div class="artwork">
        <img class="artworkImage" alt="" width="1916" height="256" />
        <ul class="navItems">
          ${['Settings', 'Players', 'Cashier', 'Market', 'Data', 'Stats']
            .map(
              (l) =>
                `<li class="navCell"><a class="navItem" href="#" aria-label="${l}"><span class="visuallyHidden">${l}</span></a></li>`
            )
            .join('')}
        </ul>
      </div></div>
    </nav>
    <script>
      ${
        opts.inTab
          ? /* In the multi-table "+" tab the GlobalHeader publishes its height
               on the TAB element, not the root, as --ca-in-tab-header-height.
               The fixture puts it on .club-home, the nearest ancestor. */
            `document.querySelector('.club-home').style.setProperty('--ca-in-tab-header-height', '${HEADER_HEIGHT_PX}px');`
          : `document.documentElement.style.setProperty('--ca-global-header-height', '${HEADER_HEIGHT_PX}px');`
      }
      ${
        opts.publishControlsHeight
          ? /* Mirrors ClubLobbyCommandTop exactly: publish now, and again
               whenever the deck changes height - fonts landing, a tab change,
               a rotation. A single early read is stale the moment a web font
               arrives, which is a 10px lie at this width. */
            `const c = document.querySelector('.club-lobby-command-top__controls');
             const publish = () => document.documentElement.style.setProperty('--ca-lobby-controls-h', c.getBoundingClientRect().height + 'px');
             publish();
             new ResizeObserver(publish).observe(c);`
          : ''
      }
    </script>
  `;
}

async function measureCountLine(page: Page) {
  await settle(page);
  return page.evaluate((titleCentrePct) => {
    const btn = document.querySelector('.lobby-wallets-trigger')!;
    const small = btn.querySelector('small')!;
    const range = document.createRange();
    range.selectNodeContents(small);
    const b = btn.getBoundingClientRect();
    const z = small.getBoundingClientRect();
    const t = range.getBoundingClientRect();
    return {
      text: small.textContent ?? '',
      zoneWidth: z.width,
      textWidth: t.width,
      clipped: t.width > z.width + 0.5,
      offCentreByPct: Math.abs(((t.left + t.width / 2 - b.left) / b.width) * 100 - titleCentrePct),
    };
  }, TITLE_CENTRE_PCT);
}

/**
 * Measure only once the page has stopped moving. Two things move it after
 * load, both of them correct: web fonts land and the deck republishes its
 * height, and `.club-home__games` plays its 0.5s `gamesGridFade` entrance
 * (translateY(10px) to 0), which the sort row rides because it lives inside
 * that block. Under the animation law that entrance MUST play, so the test
 * waits for it rather than measuring a frame in the middle of it - which
 * reads as an 8px "gap" that a player never sees.
 */
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

async function measureChrome(page: Page) {
  await settle(page);
  return page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const sortbar = document.querySelector('.lobby-sortbar')!;
    const s = sortbar.getBoundingClientRect();
    const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
    const edgeBottom = r('.fx-edge').bottom;
    return {
      sortbarPosition: getComputedStyle(sortbar).position,
      sortbarTop: s.top,
      sortbarOnScreen: s.bottom > 0 && s.top < edgeBottom,
      sortbarIsTopmost: sortbar === hit || sortbar.contains(hit),
      deckTop: r('.club-lobby-command-top__controls').top,
      deckBottom: r('.club-lobby-command-top__controls').bottom,
      frameBottom: r('.bottomNav .artwork').bottom,
      viewportBottom: edgeBottom,
    };
  });
}

test.describe('mobile lobby chrome', () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });

  test('the wallets count is centred on the painted title and never clipped', async ({ page }) => {
    for (const countText of ['1 Balance', '5 Balances', '12 Balances']) {
      await page.setContent(lobby({ countText, publishControlsHeight: true }));
      const m = await measureCountLine(page);
      expect(m.text).toBe(countText);
      expect(m.clipped, `${countText} is clipped: ${m.textWidth}px in ${m.zoneWidth}px`).toBe(
        false
      );
      expect(m.offCentreByPct, `${countText} is off the painted title's centre`).toBeLessThan(0.5);
    }
    // The dropped-connection case prints NOTHING - not a placeholder.
    await page.setContent(lobby({ countText: '', publishControlsHeight: true }));
    const empty = await measureCountLine(page);
    expect(empty.text.trim()).toBe('');
  });

  test('the filter row locks flush under Find Your Game and stays above the cards', async ({
    page,
  }) => {
    await page.setContent(lobby({ countText: '5 Balances', publishControlsHeight: true }));
    await page.evaluate(() => window.scrollTo(0, 700));
    const m = await measureChrome(page);
    expect(m.sortbarPosition).toBe('sticky');
    expect(m.sortbarOnScreen).toBe(true);
    expect(Math.abs(m.sortbarTop - m.deckBottom), 'gap between deck and row').toBeLessThan(1);
    expect(m.sortbarIsTopmost, 'a card is painting over the sort row').toBe(true);
  });

  test('without the published deck height the row degrades to the header, never off the page', async ({
    page,
  }) => {
    await page.setContent(lobby({ countText: '5 Balances', publishControlsHeight: false }));
    await page.evaluate(() => window.scrollTo(0, 700));
    const m = await measureChrome(page);
    expect(m.sortbarPosition).toBe('sticky');
    expect(m.sortbarOnScreen).toBe(true);
    // With no deck height to add, the row parks at the header, exactly where
    // the deck parks: under it, never off the page.
    expect(Math.abs(m.sortbarTop - m.deckTop), 'row should park where the deck parks').toBeLessThan(
      1
    );
  });

  test('the Variant menu opens under the stuck row and above the cards', async ({ page }) => {
    /* Dan 2026-09-05: the dropdowns "aren't clickable ... you click what's
       behind the page". Giving the row a z-index made it a stacking context
       around the menus that anchor inside it, so this proves the menu still
       paints above every card once the row is stuck. */
    await page.setContent(lobby({ countText: '5 Balances', publishControlsHeight: true }));
    await page.evaluate(() => window.scrollTo(0, 700));
    await settle(page);
    const m = await page.evaluate(() => {
      const bar = document.querySelector('.lobby-sortbar')!;
      const anchor = document.createElement('div');
      anchor.className = 'lt-variant-menu-anchor lt-variant-menu-anchor--bar';
      anchor.innerHTML =
        '<div class="lt-variant-menu" role="menu">' +
        ['No Limit', 'Pineapple', 'Short Deck']
          .map(
            (g) =>
              `<button type="button" class="lt-variant-menu__item" role="menuitemcheckbox">${g}</button>`
          )
          .join('') +
        '</div>';
      bar.appendChild(anchor);
      const item = anchor.querySelector('.lt-variant-menu__item')!;
      const i = item.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const hit = document.elementFromPoint(i.left + i.width / 2, i.top + i.height / 2);
      return {
        menuBelowBar: anchor.getBoundingClientRect().top - b.bottom,
        itemIsTopmost: hit === item,
        itemOnScreen: i.top >= 0 && i.bottom <= innerHeight,
      };
    });
    expect(m.itemOnScreen).toBe(true);
    expect(m.menuBelowBar).toBeGreaterThanOrEqual(0);
    expect(m.menuBelowBar).toBeLessThan(12);
    expect(m.itemIsTopmost, 'a card is painting over the open menu').toBe(true);
  });

  test('inside the multi-table tab the row reads the tab header height', async ({ page }) => {
    await page.setContent(
      lobby({ countText: '5 Balances', publishControlsHeight: true, inTab: true })
    );
    await page.evaluate(() => window.scrollTo(0, 700));
    const m = await measureChrome(page);
    expect(m.sortbarPosition).toBe('sticky');
    expect(Math.abs(m.sortbarTop - m.deckBottom), 'gap between deck and row').toBeLessThan(1);
    expect(m.sortbarOnScreen).toBe(true);
  });

  test('the footer frame sits on the bottom edge with nothing under it', async ({ page }) => {
    await page.setContent(lobby({ countText: '5 Balances', publishControlsHeight: true }));
    await page.evaluate(() => window.scrollTo(0, 700));
    const m = await measureChrome(page);
    expect(Math.abs(m.viewportBottom - m.frameBottom), 'strip under the frame').toBeLessThan(1);
  });
});

test.describe('mobile lobby chrome on the narrowest phone', () => {
  /* Below 357px the artwork's own aspect ratio is shorter than the 44px touch
     floor. The remainder used to sit BELOW the frame; it belongs above it. */
  test.use({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });

  test('the touch floor cannot reopen a gap under the frame', async ({ page }) => {
    await page.setContent(lobby({ countText: '5 Balances', publishControlsHeight: true }));
    await page.evaluate(() => window.scrollTo(0, 700));
    const m = await measureChrome(page);
    expect(Math.abs(m.viewportBottom - m.frameBottom), 'strip under the frame').toBeLessThan(1);
    expect(Math.abs(m.sortbarTop - m.deckBottom), 'gap between deck and row').toBeLessThan(1);
  });
});
