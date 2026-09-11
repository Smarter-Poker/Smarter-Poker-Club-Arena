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
      </button>
      <button class="table-tab-bar__tab" id="tabIdle">
        <span class="table-tab-bar__tab-label"><span class="table-tab-bar__tab-name" id="idleCode">PLO5</span>
        <span class="table-tab-bar__tab-sub" id="idleStakes">2/5</span></span>
      </button>
      <button class="table-tab-bar__tab" id="tabFold">
        <span class="table-tab-bar__tab-label"><span class="table-tab-bar__tab-name">NLH 5/10</span></span>
      </button>
    </div>`;
    document.body.appendChild(bar);
  });
}

/** Apply a beat, resolve its styles, and return Chrome's running animations. */
async function beat(page: Page, mutate: string): Promise<Record<string, number>> {
  return page.evaluate((src) => {
    const $ = (id: string) => document.getElementById(id)!;
    new Function('$', 'document', src)($, document);
    /* getAnimations() performs the style update needed to instantiate CSS
       animations. Waiting for two requestAnimationFrame callbacks was not
       part of the assertion and can wait forever when headless Chromium
       throttles a reduced-motion/background page under CI contention. */
    void document.documentElement.offsetWidth;
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

  /* The `table-tab-bar__turn-dot` countdown badge was DELETED 2026-08-28 (Dan:
     "THE ACTION PILL SHOULD ONLY EVER SHOW THE CARDS (CENTERED IN THE PILL) AND
     THE DISAPPEARING TIMER BAR... THATS IT"). The pill's own pulse and the
     draining bar are what remain, and both are still pinned below. */
  test('a background table calling for action pulses', async ({ page }) => {
    const b = await beat(page, `void 0;`);
    expect(b.pulseGlow, 'the turn tab must pulse gold').toBe(800);
  });

  test('urgency goes red: the tab pulse and the timer bar itself', async ({ page }) => {
    const b = await beat(
      page,
      `$('tabTurn').classList.add('table-tab-bar__tab--urgent');
       $('timerBar').classList.add('table-tab-bar__timer-bar--urgent');`
    );
    expect(b.tabUrgentPulse, 'an urgent tab must pulse red').toBe(800);
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
    // These two must equal SUIT_COLOR in CardImage.tsx, which paints the real
    // cards on the felt. They used to be #111318 / #dc2626 - a second shade of
    // each suit - so the same card was one colour in this mini preview and
    // another in the hand it previewed. #1e293b is still near-black and
    // #ef4444 is still red; the intent below is unchanged, the shade now
    // matches the felt. tests/gameplay-wears-the-house-colours.test.ts pins
    // both ends so they cannot drift apart again.
    expect(colors.spade, 'spades must be near-black').toBe('rgb(30, 41, 59)');
    expect(colors.heart, 'hearts must be red').toBe('rgb(239, 68, 68)');
    expect(colors.face, 'the mini card must have a white face').toBe('rgb(248, 249, 251)');
  });

  test('an idle tab reads its GAME CODE, with the stakes underneath', async ({ page }) => {
    // Dan 2026-08-21: "if i don't have a hand it should say the game type."
    // The code is the primary line and must out-weigh the stakes sub-line.
    const read = await page.evaluate(() => {
      const code = document.getElementById('idleCode')!;
      const stakes = document.getElementById('idleStakes')!;
      const cs = getComputedStyle(code);
      const ss = getComputedStyle(stakes);
      return {
        codeText: code.textContent,
        codeWeight: Number(cs.fontWeight),
        codeSize: parseFloat(cs.fontSize),
        stakesSize: parseFloat(ss.fontSize),
        direction: getComputedStyle(code.parentElement!).flexDirection,
      };
    });
    expect(read.codeText).toBe('PLO5');
    expect(read.codeWeight, 'the game code must be the heavy line').toBeGreaterThanOrEqual(700);
    expect(read.codeSize, 'the code must be larger than its stakes').toBeGreaterThan(
      read.stakesSize
    );
    expect(read.direction, 'code stacks over stakes').toBe('column');
  });

  test('a folded tab dims: "nothing to do here" must be visible at a glance', async ({ page }) => {
    const opacity = await page.evaluate(async () => {
      const el = document.getElementById('tabFold')!;
      // Measure the folded state ALONE. Read on its own, this pill can still
      // be carrying a state another beat left on it (a result flash, a
      // countdown flash), and those animate background/box-shadow on the same
      // element - so strip the tab to exactly "a folded tab" first, then let
      // one frame settle before reading. Flaked once in a full-file run
      // before this; deterministic now.
      el.className = 'table-tab-bar__tab table-tab-bar__tab--folded';
      el.getAnimations().forEach((a) => a.cancel());
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
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
    /* Variant A (Dan 2026-08-30): the strip moved INTO the reserved in-flow
       band below the felt — an absolute overlay here is the old bug that
       covered the hero's hole cards. The mechanism this pin guards moved, so
       the pin moved with it (in the same commit, per the red-test rule). */
    expect(styles.stripPosition, 'the strip must be in-flow, never an overlay').toBe('static');
  });

  test('Variant A: the tile band reserves space and the cell is a column', async ({ page }) => {
    // Dan 2026-08-30: "YOU CAN NOT SEE YOUR CARDS WHEN THE ACTION BAR
    // APPEARS." The fix is structural: the cell is a flex column, the stage
    // shrinks, and the band is in-flow below it. Pin all three so the overlay
    // bug cannot come back by CSS drift.
    const read = await page.evaluate(() => {
      const cell = document.createElement('div');
      cell.className = 'multi-table-grid__cell';
      cell.innerHTML =
        '<div class="multi-table-grid__stage"></div>' +
        '<div class="multi-table-grid__band">' +
        '<div class="multi-table-grid__slider-row">' +
        '<input type="range" class="multi-table-grid__slider"/>' +
        '<span class="multi-table-grid__slider-amount">120</span></div>' +
        '<div class="multi-table-grid__raises"></div>' +
        '<div class="multi-table-grid__actions"></div></div>';
      document.body.appendChild(cell);
      const cellS = getComputedStyle(cell);
      const stage = getComputedStyle(cell.children[0]);
      const band = getComputedStyle(cell.children[1]);
      const amount = getComputedStyle(cell.querySelector('.multi-table-grid__slider-amount')!);
      return {
        cellDisplay: cellS.display,
        cellDirection: cellS.flexDirection,
        stagePosition: stage.position,
        stageFlexGrow: stage.flexGrow,
        bandPosition: band.position,
        bandZIndex: band.zIndex,
        amountColor: amount.color,
      };
    });
    expect(read.cellDisplay, 'the cell must be a flex column').toBe('flex');
    expect(read.cellDirection, 'the cell must stack stage over band').toBe('column');
    expect(read.stagePosition, 'the stage anchors the scaled felt').toBe('relative');
    expect(read.stageFlexGrow, 'the stage must take the remaining height').toBe('1');
    /* The band must RESERVE its height, which is what Variant A is. `static`
       and `relative` both do; `absolute`/`fixed`/`sticky` take it out of flow
       and put the chrome back over the hero's cards. Pinned as "not taken out
       of flow" rather than the literal `static` it shipped as on 2026-08-30 —
       that spelling forbade `relative`, which the band now needs so its
       z-index is not inert. */
    expect(
      ['absolute', 'fixed', 'sticky'].includes(read.bandPosition),
      'the band must stay in flow and reserve its height, never overlay the felt'
    ).toBe(false);
    /* A declared z-index on a static box is silently ignored, so the band
       would only LOOK protected. If it carries a z-index, it must be
       positioned for that z-index to mean anything. */
    if (read.bandZIndex !== 'auto') {
      expect(read.bandPosition, 'a band with a z-index must be positioned').not.toBe('static');
    }
    expect(read.amountColor, 'the raise amount must read gold').toBe('rgb(250, 204, 21)');
  });

  test('no dead pseudo-element smudges the tile action keys', async ({ page }) => {
    /* 2026-08-31: `.multi-table-grid__cell::after` was `content:
       attr(data-table-name)` for an attribute nothing ever set. content:""
       still GENERATES a box, and that one had padding, a black background and
       a blur — an empty smudge pinned bottom-left of the cell, which after
       Variant A is the Fold button. Deleted. This pin fails if any cell-level
       pseudo-element comes back with a paintable box. */
    const read = await page.evaluate(() => {
      const cell = document.createElement('div');
      cell.className = 'multi-table-grid__cell';
      cell.style.cssText = 'height:400px;width:300px';
      cell.innerHTML =
        '<div class="multi-table-grid__stage"></div>' +
        '<div class="multi-table-grid__band"><div class="multi-table-grid__actions">' +
        '<button class="multi-table-grid__action multi-table-grid__action--fold">Fold</button>' +
        '</div></div>';
      document.body.appendChild(cell);
      const out: Record<string, string> = {};
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(cell, pseudo);
        out[pseudo] = `${cs.content}|${cs.backgroundColor}`;
      }
      return out;
    });
    for (const pseudo of ['::before', '::after']) {
      const [content] = read[pseudo].split('|');
      expect(
        content === 'none' || content === 'normal',
        `cell ${pseudo} must not generate a box over the action band (got ${read[pseudo]})`
      ).toBe(true);
    }
  });

  test('CARD ART: nothing crops the indices and nothing stair-steps the pips', async ({ page }) => {
    // Dan 2026-08-21: "the cards ... are no longer crisp and clean, they seem
    // distorted with edges cut off." Both halves of that regression are
    // CSS-visible, so they are pinned here.
    const read = await page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.className = 'card-image card-image--md';
      const img = document.createElement('img');
      img.className = 'card-image__img';
      wrap.appendChild(img);
      document.body.appendChild(wrap);
      const cw = getComputedStyle(wrap);
      const ci = getComputedStyle(img);
      return {
        fit: ci.objectFit,
        rendering: ci.imageRendering,
        w: parseFloat(cw.width),
        h: parseFloat(cw.height),
      };
    });
    // COVER shaves the difference off the edges of every card.
    expect(read.fit, 'card art must never be cropped').toBe('contain');
    // crisp-edges turns a 1050px-tall card scaled to 70px into stair-steps.
    expect(
      ['crisp-edges', 'pixelated', '-webkit-optimize-contrast'].includes(read.rendering),
      'a downscaled card must be smoothed, not nearest-neighboured'
    ).toBe(false);
    // The art is 750x1050 = 5:7 exactly; the box must match it.
    expect(read.w / read.h, 'card box must be 5:7 like the art').toBeCloseTo(5 / 7, 3);
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
        expect(
          b[name],
          `${name} must be flattened under prefers-reduced-motion`
        ).toBeLessThanOrEqual(1);
      }
    }
    await ctx.close();
  });
});
