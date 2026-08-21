/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIVE E2E — the multi-table surface, in real Chrome, against PRODUCTION CSS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Roadmap batch 6 (2026-08-21). Three agent sessions pushed to this surface
 * in one evening and two silent clobbers happened; this spec is the
 * regression net for everything the PokerBros-parity work shipped:
 *
 *   - tab hole-card previews (4-color deck) and the cards-mode pill
 *   - the depleting turn-timer bar, gold then red+pulsing
 *   - turn pulse / urgent pulse on background tabs
 *   - folded-tab dimming
 *   - the win/loss showdown flash
 *   - transient last-action chips
 *   - the long-press quick menu and quick-join sheet entrances
 *   - the playable tile-view action strip
 *   - prefers-reduced-motion flattening all of it
 *
 * Same grammar as live-animations.spec.ts: load the stylesheets PRODUCTION is
 * serving right now, mount the DOM exactly as the components render it, and
 * ask Chrome (document.getAnimations / getComputedStyle) what is actually
 * happening. A failure here means a real multi-tabler sees a dead beat.
 *
 * Run:  npx playwright test tests/e2e/multi-table.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';

/** CI runs these beats against THIS COMMIT's own build served locally
 *  (ARENA_BASE_URL); a bare local run still defaults to production. */
const ARENA = process.env.ARENA_BASE_URL || 'https://smarter.poker/hub/club-arena';

/** Stylesheets that carry the multi-table styles. Resolved from the live index. */
async function loadLiveCss(page: Page) {
  await page.goto(`${ARENA}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (arenaBase: string) => {
    const base = arenaBase;
    const html = await fetch(base + 'index.html').then((r) => r.text());
    const entry = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
    const js = entry ? await fetch(base + entry).then((r) => r.text()) : '';
    const names = new Set<string>();
    for (const m of js.matchAll(/assets\/[A-Za-z0-9_.-]+\.css/g)) names.add(m[0]);
    for (const m of html.matchAll(/assets\/[A-Za-z0-9_.-]+\.css/g)) names.add(m[0]);
    document.body.innerHTML = '';
    for (const n of names) {
      try {
        const css = await fetch(base + n).then((r) => r.text());
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
      } catch {
        /* a chunk that 404s is not this test's problem */
      }
    }
  }, `${ARENA}/`);
}

/** Mount the tab bar DOM exactly as TableTabBar renders it. */
async function mountTabBar(page: Page) {
  await page.evaluate(() => {
    const bar = document.createElement('div');
    bar.className = 'table-tab-bar';
    bar.innerHTML = `<div class="table-tab-bar__tabs" id="tabs">
      <button class="table-tab-bar__tab table-tab-bar__tab--active table-tab-bar__tab--cards" id="tabActive">
        <span class="table-tab-bar__mini-cards" id="miniCards">
          <span class="table-tab-bar__mini-card table-tab-bar__mini-card--s"><span class="table-tab-bar__mini-card-rank">A</span><span class="table-tab-bar__mini-card-suit">S</span></span>
          <span class="table-tab-bar__mini-card table-tab-bar__mini-card--h"><span class="table-tab-bar__mini-card-rank">10</span><span class="table-tab-bar__mini-card-suit">H</span></span>
        </span>
        <span class="table-tab-bar__timer-bar" id="timerBar" style="width:60%"></span>
      </button>
      <button class="table-tab-bar__tab table-tab-bar__tab--turn" id="tabTurn">
        <span class="table-tab-bar__tab-label"><span class="table-tab-bar__tab-name">NLH 1/2</span>
        <span class="table-tab-bar__tab-sub">Pot 120</span></span>
        <span class="table-tab-bar__turn-dot" id="turnDot">12s</span>
      </button>
      <button class="table-tab-bar__tab" id="tabIdle">
        <span class="table-tab-bar__tab-label"><span class="table-tab-bar__tab-name">PLO4 2/5</span></span>
      </button>
      <button class="table-tab-bar__tab" id="tabFold">
        <span class="table-tab-bar__tab-label"><span class="table-tab-bar__tab-name">NLH 5/10</span></span>
      </button>
    </div>`;
    document.body.appendChild(bar);
  });
}

/** Apply a beat, settle two frames, return Chrome's running animations. */
async function beat(page: Page, mutate: string): Promise<Record<string, number>> {
  return page.evaluate(async (src) => {
    const $ = (id: string) => document.getElementById(id)!;
    new Function('$', 'document', src)($, document);
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const out: Record<string, number> = {};
    for (const a of document.getAnimations()) {
      const name = (a as unknown as { animationName?: string }).animationName;
      if (!name) continue;
      const d = a.effect?.getTiming().duration;
      out[name] = typeof d === 'number' ? Math.round(d) : -1;
    }
    return out;
  }, mutate);
}

test.describe('LIVE E2E — the multi-table tab bar, beat by beat', () => {
  test.beforeEach(async ({ page }) => {
    await loadLiveCss(page);
    await mountTabBar(page);
  });

  test('a background table calling for action pulses, and its badge ticks', async ({ page }) => {
    const b = await beat(page, `void 0;`);
    expect(b.pulseGlow, 'the turn tab must pulse gold').toBe(800);
    expect(b.turnDotPulse, 'the countdown badge must breathe').toBe(1000);
  });

  test('urgency goes red: tab pulse, badge, and the timer bar itself', async ({ page }) => {
    const b = await beat(
      page,
      `$('tabTurn').classList.add('table-tab-bar__tab--urgent');
       $('timerBar').classList.add('table-tab-bar__timer-bar--urgent');`
    );
    expect(b.tabUrgentPulse, 'an urgent tab must pulse red').toBe(800);
    expect(b.turnDotUrgent, 'the badge must switch to the urgent cadence').toBe(500);
    expect(b.timerBarUrgent, 'the depleting bar must pulse in the final seconds').toBe(500);
  });

  test('the depleting bar drains smoothly: width transition on the engine tick', async ({
    page,
  }) => {
    const transition = await page.evaluate(() => {
      const el = document.getElementById('timerBar')!;
      return getComputedStyle(el).transitionDuration;
    });
    // Width steps once a second; a 1s linear transition is what smooths it.
    expect(transition, 'the bar must interpolate between 1s clock steps').toBe('1s');
  });

  test('mini hole cards render the 4-color deck on a white card face', async ({ page }) => {
    const colors = await page.evaluate(() => {
      const spade = document.querySelector('.table-tab-bar__mini-card--s')!;
      const heart = document.querySelector('.table-tab-bar__mini-card--h')!;
      return {
        spade: getComputedStyle(spade).color,
        heart: getComputedStyle(heart).color,
        face: getComputedStyle(spade).backgroundColor,
      };
    });
    expect(colors.spade, 'spades must be near-black').toBe('rgb(17, 19, 24)');
    expect(colors.heart, 'hearts must be red').toBe('rgb(220, 38, 38)');
    expect(colors.face, 'the mini card must have a white face').toBe('rgb(248, 249, 251)');
  });

  test('a folded tab dims: "nothing to do here" must be visible at a glance', async ({ page }) => {
    const opacity = await page.evaluate(() => {
      const el = document.getElementById('tabFold')!;
      el.classList.add('table-tab-bar__tab--folded');
      return getComputedStyle(el).opacity;
    });
    expect(Number(opacity), 'a folded tab must sit dimmed').toBeLessThan(0.7);
    expect(Number(opacity), 'but must stay readable').toBeGreaterThan(0.3);
  });

  test('the showdown flash: green for a pot won, red for a pot lost', async ({ page }) => {
    const won = await beat(page, `$('tabIdle').classList.add('table-tab-bar__tab--won');`);
    expect(won.tabResultWon, 'a win must flash green for a readable moment').toBe(2500);

    const lost = await beat(
      page,
      `$('tabIdle').classList.remove('table-tab-bar__tab--won');
       $('tabFold').classList.add('table-tab-bar__tab--lost');`
    );
    expect(lost.tabResultLost, 'a loss must flash red for the same moment').toBe(2500);
  });

  test('the last-action chip arrives, it does not blink into place', async ({ page }) => {
    const b = await beat(
      page,
      `const c=document.createElement('span');c.className='table-tab-bar__action-chip';
       c.textContent='Fold';$('tabTurn').appendChild(c);`
    );
    expect(b.actionChipIn, 'the action chip must enter').toBe(180);
  });

  test('the long-press quick menu and quick-join sheet both make an entrance', async ({ page }) => {
    const menu = await beat(
      page,
      `const m=document.createElement('div');m.className='table-tab-bar__qmenu';
       m.style.left='20px';m.style.top='60px';
       m.innerHTML='<div class="table-tab-bar__qmenu-title">NLH 1/2</div>'+
         '<button class="table-tab-bar__qmenu-item">Sit Out</button>'+
         '<div class="table-tab-bar__qmenu-sep"></div>'+
         '<button class="table-tab-bar__qmenu-item table-tab-bar__qmenu-item--danger">Leave Table</button>';
       document.body.appendChild(m);`
    );
    expect(menu.qmenuIn, 'the quick menu must slide in').toBe(140);

    const sheet = await beat(
      page,
      `const q=document.createElement('div');q.className='multi-table-page__quickjoin';
       q.innerHTML='<div class="multi-table-page__quickjoin-title">Quick Join</div>'+
         '<button class="multi-table-page__quickjoin-row">'+
         '<span class="multi-table-page__quickjoin-name">NLH Deep</span>'+
         '<span class="multi-table-page__quickjoin-cta">Join</span></button>';
       document.body.appendChild(q);`
    );
    expect(sheet.quickJoinIn, 'the quick-join sheet must drop in').toBe(160);
  });

  test('the tile-view action strip: fold reads red, call reads green, clock reads gold', async ({
    page,
  }) => {
    const styles = await page.evaluate(() => {
      const strip = document.createElement('div');
      strip.className = 'multi-table-grid__actions';
      strip.innerHTML =
        '<button class="multi-table-grid__action multi-table-grid__action--fold">Fold</button>' +
        '<button class="multi-table-grid__action multi-table-grid__action--call">Call 40</button>' +
        '<span class="multi-table-grid__action-clock">7s</span>';
      document.body.appendChild(strip);
      const fold = getComputedStyle(strip.children[0]);
      const call = getComputedStyle(strip.children[1]);
      const clock = getComputedStyle(strip.children[2]);
      return {
        foldImage: fold.backgroundImage,
        callImage: call.backgroundImage,
        clockColor: clock.color,
        stripPosition: getComputedStyle(strip).position,
      };
    });
    expect(styles.foldImage, 'fold must be the red gradient').toContain('185, 28, 28');
    expect(styles.callImage, 'call must be the green gradient').toContain('22, 163, 74');
    expect(styles.clockColor, 'the countdown must read gold').toBe('rgb(250, 204, 21)');
    expect(styles.stripPosition, 'the strip must overlay its tile').toBe('absolute');
  });

  test('reduced motion is honoured across the multi-table surface', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await loadLiveCss(page);
    await mountTabBar(page);
    const b = await beat(
      page,
      `$('timerBar').classList.add('table-tab-bar__timer-bar--urgent');
       $('tabIdle').classList.add('table-tab-bar__tab--won');
       const c=document.createElement('span');c.className='table-tab-bar__action-chip';
       c.textContent='Call';$('tabTurn').appendChild(c);`
    );
    for (const name of ['timerBarUrgent', 'tabResultWon', 'actionChipIn']) {
      if (name in b) {
        expect(b[name], `${name} must be flattened under prefers-reduced-motion`).toBeLessThanOrEqual(
          1
        );
      }
    }
    await ctx.close();
  });
});
