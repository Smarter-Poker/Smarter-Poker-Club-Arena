/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIVE E2E — every gameplay animation, in a real browser, against PRODUCTION CSS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20: "now do a real live e2e browser test of everything."
 *
 * The jsdom simulation (tests/components/GameplayAnimations.simulation.test.tsx)
 * proves each animation is TRIGGERED and SOUNDED — but jsdom does not run
 * animations at all, so it cannot prove one actually plays, or for how long.
 *
 * This spec does. It loads the REAL stylesheets that production is serving right
 * now, walks a COMPLETE hand beat by beat in real Chrome, and reads
 * document.getAnimations() — the browser's own list of running animations — to
 * assert that each beat actually animates, with the duration it is supposed to.
 *
 * A failure here means a real player would see a dead or wrong-length moment.
 *
 * Run:  npx playwright test tests/e2e/live-animations.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';

/** CI runs these beats against THIS COMMIT's own build served locally
 *  (ARENA_BASE_URL); a bare local run still defaults to production. */
const ARENA = process.env.ARENA_BASE_URL || 'https://smarter.poker/hub/club-arena';

/** Stylesheets that carry the gameplay animations. Resolved from the live index. */
async function loadLiveCss(page: Page) {
  await page.goto(`${ARENA}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (arenaBase: string) => {
    const base = arenaBase;
    // The component stylesheets are lazy chunks, so they are NOT linked from
    // index.html. Discover them from the module graph the entry advertises.
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
    document.documentElement.style.setProperty('--animation-speed', '1');
  }, `${ARENA}/`);
}

/** Build the table DOM exactly as the real components render it. */
async function mountTable(page: Page) {
  await page.evaluate(() => {
    const root = document.createElement('div');
    root.className = 'table-page';
    root.innerHTML = `<div class="table-scaler" style="position:relative;width:300px;height:462px">
      <div class="deal-animation" id="dealLayer" style="--da-flight-duration:320ms"></div>
      <div class="seat-wrapper" id="sw" style="position:absolute;left:50%;top:80%">
        <div class="seat" id="seat">
          <div class="seat__info" id="info"></div>
          <div class="seat__bet-chips"><div class="chip-physics cp--compact cp--none" id="chips"><div class="cp-stacks"><div class="cp-stack"><div class="cp-chip"></div></div></div></div></div>
          <div class="seat__cards seat__cards--hero" id="cards"><div class="seat__card"></div><div class="seat__card"></div></div>
        </div>
      </div>
      <div class="community-area"><div class="community-cards" id="board"><div class="community-cards__container" id="bc"></div></div></div>
      <div class="pot-area"><div class="pot-display" id="pot"></div></div>
    </div>`;
    document.body.appendChild(root);
  });
}

/** Apply a beat, settle two frames, and return the animations Chrome is running. */
async function beat(page: Page, mutate: string): Promise<Record<string, number>> {
  return page.evaluate(async (src) => {
    const $ = (id: string) => document.getElementById(id)!;

    new Function('$', 'document', src)($, document);
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const out: Record<string, number> = {};
    for (const a of document.getAnimations()) {
      const name = (a as any).animationName || (a as any).transitionProperty;
      if (!name) continue;
      const d = a.effect?.getTiming().duration;
      out[name] = typeof d === 'number' ? Math.round(d) : -1;
    }
    return out;
  }, mutate);
}

test.describe('LIVE E2E — a complete hand, animation by animation', () => {
  test.beforeEach(async ({ page }) => {
    await loadLiveCss(page);
    await mountTable(page);
  });

  test('every beat of a hand actually animates, at the right duration', async ({ page }) => {
    // ── BEAT 1 — THE DEAL: cards fly from the dealer to every seat ──────────
    const b1 = await beat(
      page,
      `for(let i=0;i<12;i++){const c=document.createElement('div');c.className='deal-animation__card';
       c.style.cssText='--origin-x:50%;--origin-y:50%;--target-x:50%;--target-y:80%;--delay:'+(i*80)+'ms';
       $('dealLayer').appendChild(c);}`
    );
    expect(b1, 'the deal must fly — "the CARDS MUST BE DEALT"').toHaveProperty('dealFly');
    expect(b1.dealFly).toBe(320);

    // ── BEAT 2 — cards land at the seat ────────────────────────────────────
    const b2 = await beat(page, `$('cards').classList.add('seat__cards--dealing');`);
    expect(b2).toHaveProperty('cardDealIn');
    expect(b2.cardDealIn).toBe(350);
    // The JS class window is 700ms — it MUST outlive the 350ms keyframe.
    expect(b2.cardDealIn).toBeLessThan(700);

    // ── BEAT 3 — the turn clock: a TRUE 15 seconds ─────────────────────────
    const b3 = await beat(
      page,
      `$('cards').classList.remove('seat__cards--dealing');
       $('seat').classList.add('seat--active');
       const i=$('info');
       i.style.setProperty('--sp-timer-duration','15.000s');
       i.style.setProperty('--sp-timer-yellow-duration','15.000s');
       i.style.setProperty('--sp-timer-delay','-0.000s');`
    );
    expect(b3.spTimerRingShrink, 'the ring must take exactly 15s to empty').toBe(15000);
    expect(b3.spTimerColorShift, 'the yellow must last exactly 15s').toBe(15000);

    // ── BEAT 4 — a wager: chips slide onto the felt ────────────────────────
    const b4 = await beat(
      page,
      `$('chips').className='chip-physics cp--compact cp--visible cp--slide-in';`
    );
    expect(b4.cpSlideIn).toBe(500);

    // ── BEAT 5 — THE FLOP: land face down, THEN fan open (two phases) ──────
    const b5 = await beat(
      page,
      `for(let i=0;i<3;i++){const d=document.createElement('div');
       d.className='community-cards__card community-cards__card--flop-deal';
       d.style.setProperty('--card-index',String(i));
       d.innerHTML='<div class="community-cards__flip"><div class="community-cards__flip-face community-cards__flip-face--back"></div><div class="community-cards__flip-face community-cards__flip-face--front"></div></div>';
       $('bc').appendChild(d);}`
    );
    expect(b5.ccFlopLand, 'flop must LAND face down first').toBe(300);
    expect(b5.ccFlopFanOpen, 'flop must then FAN OPEN').toBe(420);

    // ── BEAT 6 — bets sweep into the pot ───────────────────────────────────
    const b6 = await beat(
      page,
      `$('chips').className='chip-physics cp--compact cp--visible cp--collect';`
    );
    expect(b6.cpCollect).toBe(550);
    // The JS collect window is 700ms — it MUST outlive the 550ms keyframe.
    expect(b6.cpCollect).toBeLessThan(700);

    // ── BEAT 7 — THE TURN ──────────────────────────────────────────────────
    const b7 = await beat(
      page,
      `const d=document.createElement('div');d.className='community-cards__card community-cards__card--turn';
       d.style.setProperty('--card-index','3');$('bc').appendChild(d);`
    );
    expect(b7.ccTurnReveal).toBe(550);

    // ── BEAT 8 — THE RIVER ─────────────────────────────────────────────────
    const b8 = await beat(
      page,
      `const d=document.createElement('div');d.className='community-cards__card community-cards__card--river';
       d.style.setProperty('--card-index','4');$('bc').appendChild(d);`
    );
    expect(b8.ccRiverReveal).toBe(700);

    // ── BEAT 9 — SHOWDOWN: hands turn over ─────────────────────────────────
    const b9 = await beat(
      page,
      `$('board').classList.add('community-cards--showdown');
       $('cards').className='seat__cards seat__cards--opponent seat__cards--showdown';`
    );
    expect(b9.cardShowdownFlip).toBe(350);
    // Second card is delayed 120ms; the JS window is 600ms and must cover both.
    expect(b9.cardShowdownFlip + 120).toBeLessThan(600);

    // ── BEAT 10 — the WINNER is celebrated ─────────────────────────────────
    const b10 = await beat(
      page,
      `$('seat').classList.add('seat--winner','seat--winner-glow','seat--winner-pop');`
    );
    expect(b10.seatWinnerPop).toBe(600);

    // ── BEAT 11 — the POT SHIPS to the winner ──────────────────────────────
    const b11 = await beat(
      page,
      `const p=$('pot');p.classList.add('pot-display--collect');
       p.style.setProperty('--collect-dx','120px');p.style.setProperty('--collect-dy','-90px');`
    );
    expect(b11.pdCollect, 'the pot must travel to the winner').toBe(500);
    expect(b11.pdCollect).toBeLessThan(700); // JS window

    // ── BEAT 12 — the loser MUCKS ──────────────────────────────────────────
    const b12 = await beat(
      page,
      `$('cards').className='seat__cards seat__cards--opponent seat__cards--folding';`
    );
    expect(b12.cardFoldOut).toBe(380);
    // Second card is delayed 55ms; the JS window is 500ms and must cover both.
    expect(b12.cardFoldOut + 55).toBeLessThan(500);
  });

  test('the ALL-IN moment: banner slam + shockwave + equity badge', async ({ page }) => {
    const b = await beat(
      page,
      `const x=document.createElement('div');x.className='allin-banner';
       x.innerHTML='<span class="allin-banner__text">ALL IN</span>';
       document.querySelector('.table-page').appendChild(x);
       const e=document.createElement('div');e.className='equity-overlay equity-overlay--ahead';
       e.innerHTML='72%<span class="equity-overlay__track"><span class="equity-overlay__bar" style="width:72%"></span></span>';
       $('sw').appendChild(e);`
    );
    expect(b.allInBannerSlam, 'ALL IN must slam in').toBe(1800);
    expect(b.allInShockwave, 'and throw a shockwave ring').toBe(900);
    expect(b.equityPop, 'the win% must pop on every change').toBe(450);
  });

  test('the SPIN-IT intro: dim + beam, countdown, disc, winner flash, confetti', async ({
    page,
  }) => {
    // v2 (2026-08-20): rebuilt to the PokerBros grammar from Dan's reference
    // capture — vignette + spotlight beam over a visible table, gold 3-2-1
    // countdown, chase-lit disc, winner flash. Production keyframes at their
    // shipped durations.
    const opening = await beat(
      page,
      `const sw=document.createElement('div');sw.className='sw sw--countdown';
       sw.innerHTML='<div class="sw__dim"></div><div class="sw__beam"></div>'+
         '<div class="sw__stage"><div class="sw__count">3</div></div>';
       document.querySelector('.table-page').appendChild(sw);`
    );
    expect(opening.swDimIn, 'the vignette must fade in over the felt').toBe(500);
    expect(opening.swBeamIn, 'the spotlight beam must descend').toBe(700);
    expect(opening.swCountPop, 'the countdown digit must pop').toBe(720);

    const chase = await beat(
      page,
      `const st=document.querySelector('.sw__stage');st.innerHTML='';
       const w=document.createElement('div');w.className='sw__disc-wrap';
       w.innerHTML='<div class="sw__disc">'+
         '<div class="sw__seg sw__seg--c0 sw__seg--lit"><span class="sw__seg-label">2</span></div>'+
         '<div class="sw__seg sw__seg--c1 sw__seg--locked"><span class="sw__seg-label">500</span></div>'+
         '<div class="sw__hub"><span class="sw__hub-brand">SPIN-IT</span></div></div>';
       st.appendChild(w);
       const s=document.createElement('div');s.className='sw__status';
       s.innerHTML='<span class="sw__status-locked">500× unlocks at 5,000</span>';st.appendChild(s);`
    );
    expect(chase.swDiscIn, 'the disc must land on the felt').toBe(500);

    const result = await beat(
      page,
      `const w=document.querySelector('.sw__disc');
       w.querySelector('.sw__seg--lit').className='sw__seg sw__seg--c0 sw__seg--winner';
       w.innerHTML += '<svg><path class="sw__edge sw__edge--halo"></path></svg>';
       w.querySelector('.sw__hub').innerHTML='<span class="sw__hub-mult">25×</span>';
       const st=document.querySelector('.sw__stage');
       const r=document.createElement('div');r.className='sw__result';
       r.innerHTML='<div class="sw__prize">25</div>';st.appendChild(r);
       const cf=document.createElement('div');cf.className='sw__confetti';
       cf.innerHTML='<span class="sw__conf" style="--sw-c:0"></span>';st.appendChild(cf);`
    );
    expect(result.swNeonHalo, 'the winning segment must flash').toBe(600);
    expect(result.swHubPop, 'the hub must pop to the multiplier').toBe(450);
    expect(result.swResultIn, 'the prize must land, not appear').toBe(550);
    expect(result.swConfFall, 'a big multiplier must rain confetti').toBe(1800);
  });

  test('the KNOCKOUT: vignette, shockwave, the head cracks and FALLS', async ({ page }) => {
    const b = await beat(
      page,
      `const ko=document.createElement('div');ko.className='ko ko--impact';
       ko.innerHTML='<div class="ko__vignette"></div>'+
         '<div class="ko__shockwave"></div>'+
         '<div class="ko__stack"><div class="ko__head"><div class="ko__head-disc">'+
         '<img class="ko__head-img" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></div></div></div>';
       document.querySelector('.table-page').appendChild(ko);`
    );
    expect(b.koVignetteIn, 'the table must darken on impact').toBe(340);
    expect(b.koShockwave, 'the hit must throw a shockwave').toBe(620);
    expect(b.koHeadIn, 'the head must slam in').toBe(420);
    // The centrepiece: the head falls 500ms AFTER it lands. Both the duration
    // and the delay are the drama — a fall that starts instantly reads as a
    // glitch, not a knockout.
    expect(b.koHeadFall, 'the head must FALL').toBe(1100);
  });

  test('the MYSTERY CHEST: drop, breathe under tension, lid opens', async ({ page }) => {
    // The chest is a real box: a preserve-3d lid group hinged at its back edge
    // over a base with a cavity. Build it the way the component does, or the
    // rules under test have nothing to match.
    const landing = await beat(
      page,
      `const m=document.createElement('div');m.className='mbc mbc--landing';m.id='mbc';
       m.innerHTML='<div class="mbc__backdrop"></div><div class="mbc__stage">'+
         '<div class="mbc__chest">'+
           '<span class="mbc__lid" data-css-art="true">'+
             '<span class="mbc__lid-top"></span><span class="mbc__lid-front"></span></span>'+
           '<span class="mbc__inner-light"></span>'+
           '<span class="mbc__base" data-css-art="true">'+
             '<span class="mbc__cavity"></span></span>'+
         '</div></div>';
       document.querySelector('.table-page').appendChild(m);`
    );
    expect(landing.mbcBackdropIn).toBe(400);
    expect(landing.mbcChestDrop, 'the chest must DROP, with squash on contact').toBe(700);

    const locked = await beat(page, `document.getElementById('mbc').className='mbc mbc--locked';`);
    expect(locked.mbcChestBreathe, 'a locked chest must breathe').toBeGreaterThan(0);

    const opening = await beat(
      page,
      `document.getElementById('mbc').className='mbc mbc--opening';`
    );
    // The box itself shudders as the latch gives.
    expect(opening.mbcChestShudder, 'the chest must shudder as it gives').toBe(900);
    // The light inside is revealed on the same beat as the swing.
    expect(opening.mbcInnerLight, 'the inside must light up as it opens').toBe(900);

    // The swing itself is a TRANSITION on the 3D lid group, not a keyframe — a
    // keyframed rotation cannot be interrupted mid-swing, and the lid has to be
    // able to settle from wherever it is. getAnimations() lists it as a
    // CSSTransition, which carries no animationName, so read it directly, in the
    // same frame the class lands: a 900ms transition read over two round trips
    // could be finished before it was ever looked at.
    const lid = await page.evaluate(async () => {
      const el = document.querySelector('.mbc__lid');
      if (!el) return { ms: -2, transform: '' };
      document.getElementById('mbc')!.className = 'mbc mbc--locked';
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      document.getElementById('mbc')!.className = 'mbc mbc--opening';
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const t = el
        .getAnimations()
        .find(
          (a) =>
            (a as unknown as { transitionProperty?: string }).transitionProperty === 'transform'
        );
      const d = t?.effect?.getTiming().duration;
      return {
        ms: typeof d === 'number' ? Math.round(d) : -1,
        transform: getComputedStyle(el).transform,
      };
    });
    expect(lid.ms, 'the lid must hinge open').toBe(900);
    // and it must actually be swinging, not merely "transitioning" in place.
    expect(lid.transform, 'the lid must be laid back, not flat').not.toBe('none');
  });

  test('the TOURNAMENT WINNER overlay: entrance, trophy, prize counter', async ({ page }) => {
    // Dan's end-flow: the champion gets their celebration BEFORE being landed
    // in the lobby. These are the beats that celebration is made of.
    const b = await beat(
      page,
      `const w=document.createElement('div');w.className='winnerOverlay visible';
       w.innerHTML='<div class="sparkleContainer"><span class="sparkle"></span></div>'+
         '<div class="winnerContent winner-entrance">'+
         '<div class="winnerTrophy trophy-bounce">WINNER</div>'+
         '<div class="winnerTitle winner-golden">CHAMPION!</div>'+
         '<div class="winnerPrize prize-counter">100</div></div>';
       document.querySelector('.table-page').appendChild(w);`
    );
    expect(b.winnerGrandEntrance, 'the champion card must make an entrance').toBe(900);
    expect(b.trophyBounce, 'the trophy must bounce').toBe(2000);
    expect(b.sparkleFloat, 'the sparkles must float').toBe(4000);
    expect(b.prizeCounterSlideIn, 'the prize must slide in, then count').toBe(800);
  });

  test('the LOBBY RESULT CARD: the landing after a finished tournament', async ({ page }) => {
    // "placed inside the lobby and your tournament result card shown" — the
    // card must ARRIVE (backdrop fade + card pop), not blink into place.
    const b = await beat(
      page,
      `const r=document.createElement('div');r.className='trc';
       r.innerHTML='<div class="trc__backdrop"></div>'+
         '<div class="trc__card trc__card--won"><div class="trc__place trc__place--won">1st Place</div></div>';
       document.querySelector('.table-page').appendChild(r);`
    );
    expect(b.trcFadeIn, 'the backdrop must fade in').toBe(300);
    expect(b.trcCardIn, 'the result card must pop in').toBe(450);
  });

  test('reduced motion is honoured — every animation collapses', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await loadLiveCss(page);
    await mountTable(page);
    const b = await beat(
      page,
      `$('cards').classList.add('seat__cards--dealing');
       $('seat').classList.add('seat--winner','seat--winner-pop');`
    );
    for (const [name, ms] of Object.entries(b)) {
      expect(ms, `${name} must be flattened under prefers-reduced-motion`).toBeLessThanOrEqual(1);
    }
    await ctx.close();
  });
});
