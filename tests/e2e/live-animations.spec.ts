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

    // ── BEAT 8 — THE RIVER SQUEEZE ─────────────────────────────────────────
    // RIVER SQUEEZE 2026-09-04: the river materialises FACE DOWN in its slot
    // (ccRiverMaterialize, the prepare beat) and then snaps over through its
    // edge on the two-surface flip (ccRiverSqueeze = squeeze + reveal +
    // settle). Built exactly as CommunityCards renders it: the --squeeze
    // card carries the desktop-cash defaults from :root, and the inner
    // .community-cards__flip is what turns. 80 + 480 = the 560ms cash profile.
    const b8 = await beat(
      page,
      `const d=document.createElement('div');d.className='community-cards__card community-cards__card--river community-cards__card--squeeze';
       d.style.setProperty('--card-index','4');
       const f=document.createElement('div');f.className='community-cards__flip';d.appendChild(f);
       $('bc').appendChild(d);`
    );
    expect(b8.ccRiverMaterialize, 'the river must materialise face down in its slot').toBe(80);
    expect(b8.ccRiverSqueeze, 'the river must squeeze over through its edge').toBe(480);
    // The JS mount window is the profile total + 100ms margin, and the board
    // holds its newly-dealt window for at least 1400ms — both outlive 560ms.
    expect(80 + 480).toBeLessThan(1400);

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
         '<div class="sw__seg sw__seg--c1 sw__seg--locked"><span class="sw__seg-label">100</span></div>'+
         '<div class="sw__hub"><span class="sw__hub-brand">SPIN-IT</span></div></div>';
       st.appendChild(w);
       const s=document.createElement('div');s.className='sw__status';
       /* 100x, not 500x (2026-08-31 audit): the 500x tier was RETIRED on
          2026-08-21 (migration 20260821g_retire_500x_spin_tier) and 100x
          absorbed its frequency. A fixture that renders a tier the product
          no longer has is a fixture drifting away from the thing it guards. */
       s.innerHTML='<span class="sw__status-locked">100× unlocks at 5,000</span>';st.appendChild(s);`
    );
    expect(chase.swDiscIn, 'the disc must land on the felt').toBe(500);

    const result = await beat(
      page,
      `const w=document.querySelector('.sw__disc');
       w.querySelector('.sw__seg--lit').className='sw__seg sw__seg--c0 sw__seg--winner';
       w.querySelector('.sw__seg--winner').innerHTML += '<svg><path class="sw__edge sw__edge--halo"></path></svg>';
       w.querySelector('.sw__hub').innerHTML='<span class="sw__hub-mult">25×</span>';
       const st=document.querySelector('.sw__stage');
       const r=document.createElement('div');r.className='sw__result';
       r.innerHTML='<div class="sw__prize">25</div>';st.appendChild(r);
       const cf=document.createElement('div');cf.className='sw__confetti';
       cf.innerHTML='<span class="sw__conf" style="--sw-c:0"></span>';st.appendChild(cf);`
    );
    expect(result.swNeonHalo, 'the winning segment must pulse a halo').toBe(600);
    expect(result.swHubPop, 'the hub must pop to the multiplier').toBe(450);
    expect(result.swResultIn, 'the prize must land, not appear').toBe(550);
    expect(result.swConfFall, 'a big multiplier must rain confetti').toBe(1800);
  });

  test('the KNOCKOUT: two gloves flurry, the star breaks, KO stamps the seat', async ({ page }) => {
    // Replaced 2026-08-28 (the full-screen knockout this used to measure was
    // deleted for a seat-anchored one) and again 2026-08-29, twice: once when
    // the twelve `.sko__ray` divs became one irregular SVG path, and once when
    // Dan supplied branded glove art and a capture of a TWO-GLOVE FLURRY. Same
    // rule each time, stated in the animation law: if you deliberately replace
    // a mechanism, the pin moves to the new one in the same commit.
    //
    // `skoGloveStrike` (one glove, one strike) is gone. `skoPunchRight` and
    // `skoPunchLeft` are the flurry, and `skoFlurryHit` is the single element
    // that flashes a warm burst at each of the two jab landings.
    const b = await beat(
      page,
      `const l=document.createElement('div');l.className='sko-layer';
       const k=document.createElement('div');k.className='sko';
       k.style.setProperty('--sko-x','30%');k.style.setProperty('--sko-y','40%');
       k.innerHTML='<div class="sko__light"></div><div class="sko__ring"></div>'+
         '<img class="sko__glove sko__glove--r" alt="">'+
         '<img class="sko__glove sko__glove--l" alt="">'+
         '<svg class="sko__star" viewBox="-30 -30 260 260">'+
           '<g class="sko__star-alt"><path d="M60 60L140 140Z"></path></g>'+
           '<g class="sko__star-main"><path d="M60 60L140 140Z"></path></g>'+
           '<g class="sko__shards"><path d="M60 60L140 140Z"></path></g>'+
         '</svg>'+
         '<div class="sko__core"></div>'+
         '<svg class="sko__hit" viewBox="-30 -30 260 260"><path d="M60 60L140 140Z"></path></svg>'+
         '<span class="sko__ember" style="--sko-ember-x:0.2;--sko-ember-y:0.3"></span>'+
         '<div class="sko__flash"></div><div class="sko__stampring"></div>'+
         '<div class="sko__stamp" data-motion="keep"><svg viewBox="0 0 138 78"></svg></div>';
       l.appendChild(k);document.querySelector('.table-page').appendChild(l);
       const s=document.createElement('div');s.className='seat seat--ko-flinch';
       document.querySelector('.table-page').appendChild(s);`
    );
    // Both gloves run the SAME 930ms pass. They have to: they land the finish
    // together, and two passes of different lengths cannot agree on when that
    // is at any animation speed other than 1.
    expect(b.skoPunchRight, 'the right glove jabs and then finishes').toBe(930);
    expect(b.skoPunchLeft, 'the left glove jabs and then finishes').toBe(930);
    expect(b.skoFlurryHit, 'each jab throws its own warm burst').toBe(930);
    expect(b.skoCoreFlash, 'the finish must flash white-hot').toBe(340);
    expect(b.skoStarBurst, 'the flash must be a spiked STAR, not a ring').toBe(240);
    expect(b.skoRingCrack, 'the impact must crack, not just glow').toBe(300);
    expect(b.skoEmber, 'the star must come apart, not switch off').toBe(440);
    // The seat REACTS. A punch that lands on a photograph is not a punch, and
    // three of these land inside 280ms, so it has to be short.
    expect(b.skoSeatFlinch, 'the busted seat snaps on every landing').toBe(200);
    // The centrepiece: KO lands 930ms after the first glove appears, and then
    // HOLDS. Both the delay and the length are the drama — a stamp that
    // arrives with the punch reads as a label, and one that leaves with it is
    // unreadable.
    expect(b.skoStampLife, 'KO must slam on and BURN').toBe(1470);
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
      /* FLAKE FIX (2026-08-29): two rAFs was a guess at when the browser
         lists the CSSTransition, and on a loaded CI runner it guessed wrong
         once - getAnimations() came back empty, ms read -1, and a correct
         lid failed the pin (blocking a publish for code that never touched
         CSS). Poll for the live transition across up to 20 frames instead;
         if it was genuinely missed (already finished on a fast machine),
         fall back to the computed transition-duration, which carries the
         SAME 900ms the pin is about. The transform assertion below still
         proves the lid actually swings. */
      let d: number | string | CSSNumericValue | undefined;
      for (let frame = 0; frame < 20 && d === undefined; frame++) {
        const t = el
          .getAnimations()
          .find(
            (a) =>
              (a as unknown as { transitionProperty?: string }).transitionProperty === 'transform'
          );
        d = t?.effect?.getTiming().duration as number | undefined;
        if (d === undefined) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
      }
      if (typeof d !== 'number') {
        const style = getComputedStyle(el);
        const props = style.transitionProperty.split(',').map((s) => s.trim());
        const durs = style.transitionDuration.split(',').map((s) => s.trim());
        const at = props.findIndex((p) => p === 'transform' || p === 'all');
        if (at >= 0) {
          const raw = durs[at] ?? durs[0];
          d = Math.round(parseFloat(raw) * (raw.endsWith('ms') ? 1 : 1000));
        }
      }
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
    /* "placed inside the lobby and your tournament result card shown" — the
       card must ARRIVE (backdrop fade + card rise), not blink into place.

       AUDIT 2026-08-22: this beat used to mount `.trc` / `.trc__backdrop` /
       `.trc__card`, which is TournamentResultCard — a component that could
       never render. Its result travelled as router state addressed to
       `/clubs/:clubId` while the only reader lived at `/clubs/:clubId/lobby`,
       so the card was dropped on arrival every single time. This spec was
       therefore proving that a dead card had a beautiful entrance, and it was
       the only thing in CI still holding that CSS alive.

       Repointed at `.trc2` — TournamentRankingCard, rendered by
       TournamentRankingHost at the app root, which is what a finisher
       actually lands on. Same question, asked of the card that exists. */
    const b = await beat(
      page,
      `const r=document.createElement('div');r.className='trc2';
       r.innerHTML='<div class="trc2__backdrop"></div>'+
         '<div class="trc2__card"><div class="trc2__placeband trc2-medal--gold">1st</div></div>';
       document.querySelector('.table-page').appendChild(r);`
    );
    expect(b.trc2Fade, 'the backdrop must fade in').toBe(200);
    expect(b.trc2Rise, 'the result card must rise in').toBe(400);
  });

  /**
   * THE TWO BEATS AFTER THE WHEEL.
   *
   * The SPIN-IT test above covers the wheel itself. These are what Dan named
   * next: "AFTER THE SPIN COMPLETES, CHIP STACKS GET ADDED, BUTTON RANDOMLY
   * ASSIGNED AND THE SPIN STARTS!" The engine broadcasts spin_chips and
   * spin_button and holds the deal 1.8s to make room for them; TablePage now
   * handles both and writes the values straight into table state.
   *
   * Neither handler owns an animation of its own - each drives one that already
   * exists on the seat. This spec is what stops those from being deleted or
   * retimed underneath the handlers, which would leave the beats silently dead
   * again with every unit test still green.
   */
  test('the SPIN post-reveal beats: chips land, then the button is drawn', async ({ page }) => {
    // Beat 1 — the chips arrive at a seat that had none.
    const chips = await beat(
      page,
      `$('info').innerHTML =
         '<span class="seat__stack seat__stack--up">500</span>' +
         '<span class="seat__stack-delta seat__stack-delta--win">+500</span>';
       $('seat').classList.add('seat--stack-glow');`
    );
    expect(chips.stackBounceUp, 'the stack must bounce as the chips land').toBe(400);
    expect(chips.stackDeltaFloat, 'the +N must float off the seat').toBe(2000);
    expect(chips.seatStackGlow, 'the seat must glow as it is credited').toBe(600);

    // Beat 2 — the button is drawn. dealerButtonAppear is a MOUNT animation on
    // .seat__position-chip, so writing the chip in is exactly what the real
    // render does when dealerSeat first names this seat.
    const button = await beat(
      page,
      `const c = document.createElement('div');
       c.className = 'seat__position-chip';
       c.textContent = 'D';
       $('seat').appendChild(c);`
    );
    expect(button.dealerButtonAppear, 'the dealer button must be dealt in, not appear').toBe(400);
  });

  /**
   * PARITY: the two seat states a Spin used to render differently from cash.
   *
   * Both are CSS that the TSX fixes now reach. If either keyframe is removed or
   * retimed the fix becomes a no-op with nothing else failing, which is exactly
   * how the original divergence survived: nothing anywhere rendered a table in
   * tournament mode and compared it to one in cash mode.
   */
  test('a short stack warns, and an open seat renders with the coin button', async ({ page }) => {
    const short = await beat(
      page,
      `$('info').innerHTML = '<span class="seat__stack seat__stack--critical">8</span>';`
    );
    expect(short.stackCriticalPulse, 'a sub-10bb stack must pulse, in every format').toBe(1500);

    // 2026-08-26: empty seat now renders a coin <img> — no emptyPulse animation.
    // The visual affordance is the image itself; pulse is removed intentionally.
    // Verify the container exists and the image loads without JS errors.
    const open = await beat(
      page,
      `const s = document.createElement('div');
       s.className = 'seat seat--empty';
       s.innerHTML = '<img class="seat__empty-img seat__empty-img--sit" ' +
                     'src="/images/icons/sit-button.png" alt="Sit down" draggable="false">';
       $('sw').appendChild(s);`
    );
    // No emptyPulse animation to assert — the coin image IS the affordance.
    // The beat helper returns an empty object if no animations are running,
    // which is the correct new state for an open seat container.
    expect(
      open.emptyPulse,
      'open seat no longer uses emptyPulse — coin image replaces it'
    ).toBeUndefined();
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

// ═══════════════════════════════════════════════════════════════════════════
// THE INSURANCE DIALOG — layout contract at the PIXEL level (2026-08-28).
//
// Dan's recording (hand #3158299): on a phone the modal's content overflowed
// `max-height: 90vh; overflow: hidden` and the Insure/No buttons rendered
// below the clip line — a timed FINANCIAL decision with no visible controls,
// expiring into a final auto-decline. The jsdom suite pins the DOM structure;
// this beat pins what a real browser actually PAINTS: on a short viewport the
// body scrolls, and the decision buttons are on screen and hittable.
// ═══════════════════════════════════════════════════════════════════════════
test.describe('LIVE E2E — the insurance dialog, on a short phone viewport', () => {
  test('the decision buttons are painted on screen and hittable; the body scrolls', async ({
    browser,
  }) => {
    // 375x480 — shorter than any phone this app supports, so the body is
    // GUARANTEED to overflow and the scroll contract is genuinely exercised.
    const ctx = await browser.newContext({ viewport: { width: 375, height: 480 } });
    const page = await ctx.newPage();
    await loadLiveCss(page);

    await page.evaluate(() => {
      const row = (label: string) =>
        `<div class="insurance-modal__player-row"><span class="insurance-modal__player-name">${label}</span>` +
        `<span class="insurance-modal__player-equity">50.00%</span>` +
        `<span class="insurance-modal__player-cards"><span class="insurance-modal__card">A</span>` +
        `<span class="insurance-modal__card">K</span></span></div>`;
      const outs = Array.from(
        { length: 8 },
        () =>
          `<span class="insurance-modal__outs-card"><span class="insurance-modal__card">A</span></span>`
      ).join('');
      const overlay = document.createElement('div');
      overlay.className = 'insurance-overlay';
      overlay.innerHTML = `<div class="insurance-modal" id="insModal">
        <div class="insurance-modal__header"><div class="insurance-modal__title-row">
          <span class="insurance-modal__icon">S</span>
          <h2 class="insurance-modal__title">All-In Insurance</h2></div>
          <span class="insurance-modal__timer">23s</span></div>
        <div class="insurance-modal__body" id="insBody">
          <div class="insurance-modal__info-strip"><span class="insurance-modal__info-item">Outs: 6</span>
            <span class="insurance-modal__info-item">Pot: 62</span></div>
          <div class="insurance-modal__board"><span class="insurance-modal__board-label">Board:</span>
            <span class="insurance-modal__board-card">9</span><span class="insurance-modal__board-card">Q</span>
            <span class="insurance-modal__board-card">2</span></div>
          <div class="insurance-modal__players">${row('kingfish')}${row('Ryan Thomas')}${row('Third Player')}</div>
          <div class="insurance-modal__outs"><span class="insurance-modal__outs-label">Outs Against You (6)</span>
            <div class="insurance-modal__outs-cards">${outs}</div></div>
          <div class="insurance-modal__readouts">
            <div class="insurance-modal__readout"><span class="insurance-modal__readout-label">Insurance Fee</span>
              <span class="insurance-modal__readout-value insurance-modal__readout-value--fee">14.92</span></div>
            <div class="insurance-modal__readout"><span class="insurance-modal__readout-label">Rate</span>
              <span class="insurance-modal__readout-value">3.16</span></div>
            <div class="insurance-modal__readout"><span class="insurance-modal__readout-label">Insured Pot</span>
              <span class="insurance-modal__readout-value insurance-modal__readout-value--insured">47.10</span></div></div>
          <div class="insurance-modal__coverage"><input type="range" class="insurance-modal__slider">
            <div class="insurance-modal__slider-range"><span>0.15</span><span>19.64</span></div>
            <div class="insurance-modal__presets">
              <button class="insurance-modal__preset">Break Even</button>
              <button class="insurance-modal__preset">Constant Profit</button></div></div>
          <div class="insurance-modal__outcomes"><span class="insurance-modal__outcomes-label">With Insurance You Will Get:</span>
            <div class="insurance-modal__outcomes-row"><span class="insurance-modal__outcome">For Winning: <strong>47.08</strong></span>
              <span class="insurance-modal__outcome">For Losing: <strong>47.10</strong></span></div></div>
        </div>
        <div class="insurance-modal__actions">
          <button class="insurance-modal__btn insurance-modal__btn--decline" id="insNo">No</button>
          <button class="insurance-modal__btn insurance-modal__btn--accept" id="insYes">Insure</button>
        </div>
      </div>`;
      document.body.appendChild(overlay);
    });

    const verdict = await page.evaluate(() => {
      const modal = document.getElementById('insModal')!;
      const body = document.getElementById('insBody')!;
      const yes = document.getElementById('insYes')!;
      const no = document.getElementById('insNo')!;
      const yesBox = yes.getBoundingClientRect();
      const noBox = no.getBoundingClientRect();
      const hit = document.elementFromPoint(
        yesBox.left + yesBox.width / 2,
        yesBox.top + yesBox.height / 2
      );
      const fade = getComputedStyle(body, '::after');
      return {
        modalMaxH: getComputedStyle(modal).maxHeight,
        bodyOverflowY: getComputedStyle(body).overflowY,
        bodyScrolls: body.scrollHeight > body.clientHeight,
        yesOnScreen: yesBox.top >= 0 && yesBox.bottom <= window.innerHeight && yesBox.height > 0,
        noOnScreen: noBox.top >= 0 && noBox.bottom <= window.innerHeight && noBox.height > 0,
        yesHittable: hit === yes || yes.contains(hit),
        fadePosition: fade.position,
      };
    });

    // The exact defect from the recording, in reverse:
    expect(verdict.bodyOverflowY, 'the body must scroll, not clip').toBe('auto');
    expect(verdict.bodyScrolls, 'this viewport must actually overflow the body').toBe(true);
    expect(verdict.yesOnScreen, 'INSURE must be painted inside the viewport').toBe(true);
    expect(verdict.noOnScreen, 'NO must be painted inside the viewport').toBe(true);
    expect(verdict.yesHittable, 'nothing may cover the INSURE button').toBe(true);
    expect(verdict.fadePosition, 'the scroll-affordance fade must ride the body').toBe('sticky');
    await ctx.close();
  });
});
