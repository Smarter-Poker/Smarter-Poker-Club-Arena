/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ANIMATION LAW — ANIMATIONS ALWAYS PLAY (Dan 2026-08-28, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Verbatim: "HARDEN THE PROCESS AND MAKE SURE THAT ANIMATIONS CAN'T REGRESS,
 * ONLY IMPROVE FROM HERE ON OUT. YOU NEED TO MAKE IT LAW THAT THEY MUST
 * ALWAYS PLAY."
 *
 * Every pin below is a bug that actually shipped and was actually fixed in the
 * 2026-08-27/28 animation audits. Each one silently skipped, truncated,
 * silenced or misplaced an animation the player was owed. This file makes the
 * regression LOUD: if your change turns one of these red, you are re-shipping
 * a bug that already cost the product its polish once. Fix your change — do
 * not weaken the pin. If you are DELIBERATELY replacing a mechanism with a
 * better one, move the pin to the new mechanism in the same commit and say so.
 *
 * These are source-shape pins on purpose: they run in CI's required vitest
 * check on every pull request, so nothing merges past them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod, sliceCssRule, sliceEnclosingBlock } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../', p), 'utf8');

const SOUND = read('src/services/SoundService.ts');
const THROW_SOUND = read('src/services/ThrowableSoundService.ts');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const SEAT_TSX = read('src/components/table/SeatSlot.tsx');
const SEAT_CSS = read('src/components/table/SeatSlot.css');
const DEAL = read('src/components/table/DealAnimation.tsx');
const DEALER_BTN = read('src/components/table/DealerButton.tsx');
const CONFETTI = read('src/components/table/ConfettiCanvas.tsx');
const PARTICLES = read('src/components/table/ParticleSystem.tsx');
const CHEST = read('src/components/tournament/MysteryBountyChest.tsx');
/* The full-screen KnockoutAnimation these pins were written against was
   DELETED on 2026-08-28 and replaced by a seat-anchored layer (Dan, PokerBros
   parity). Per this file's own rule — "if you are DELIBERATELY replacing a
   mechanism with a better one, move the pin to the new mechanism in the same
   commit and say so" — every knockout pin below now reads the new component,
   and the ones the new shape makes possible have been added beside them. */
const KO = read('src/components/table/SeatKnockout.tsx');
const KO_CSS = read('src/components/table/SeatKnockout.css');
const BUS = read('src/core/MasterBus.ts');
const REDUCED = read('src/styles/reducedMotion.css');
const REACTIONS = read('src/components/table/TableReactions.tsx');
const SETTINGS_HOOK = read('src/hooks/useUserTableSettings.ts');

describe('LAW: no sound cue may be born silent', () => {
  it('no playTone call passes a literal volume of zero', () => {
    // 2026-08-27: THIRTEEN playTone calls had volume and delay swapped — six
    // celebration cues (spin countdown, chest land, latch pop, coin shower…)
    // were completely silent in production and nothing flagged it, because a
    // zero-volume oscillator throws no error. A zero literal in the volume
    // slot is never intentional; use a small value or restructure.
    expect(SOUND).not.toMatch(/this\.playTone\(\s*[^,]+,\s*[^,]+,\s*0(\.0*)?\s*,/);
  });

  it('playPotCollect bypasses the rank window instead of losing to the win fanfare', () => {
    // The gate is `rank <= currentFramePriority`; playWin/playBigWin always
    // precede the sweep in the same frame, so ANY rank below theirs is
    // rejected 100% of the time. The sweep is a companion, not a competitor.
    expect(SOUND).toContain('lastPotCollectMs');
    expect(SOUND).not.toContain("shouldPlay('pot_collect'");
  });

  it('the deal schedules its card slides on the AudioContext clock, one call for the whole deal', () => {
    // Per-card setTimeout + playDeal bunched under main-thread load and the
    // 50ms priority window silently dropped slides — a busy deal played fewer
    // sounds than cards.
    expect(SOUND).toContain('playDealSequence(delaysMs: number[])');
    expect(DEAL).toContain('soundService.playDealSequence(');
    expect(DEAL).not.toContain('soundService.playDeal()');
  });

  it('ThrowableSoundService installs autoplay-unlock listeners', () => {
    // Its context is created lazily at the first throw — for a spectator that
    // is an INCOMING broadcast, not a gesture, so on mobile the context was
    // born suspended and every throw stayed silent forever.
    expect(THROW_SOUND).toContain('installUnlockListeners');
  });
});

describe('LAW: no animation may be skipped by state plumbing', () => {
  it('MasterBus never dedups gameplay-animation events', () => {
    for (const evt of [
      "'BOMB_POT_TRIGGERED'",
      "'BOMB_POT_COMPLETED'",
      "'SHOWDOWN_CARDS_REVEALED'",
      "'RIT_OFFERED'",
      "'BBJ_HIT'",
      "'POT_DISTRIBUTED'",
    ]) {
      const bypass = BUS.slice(
        BUS.indexOf('DEDUP_BYPASS'),
        BUS.indexOf('];', BUS.indexOf('DEDUP_BYPASS'))
      );
      expect(bypass).toContain(evt);
    }
  });

  it('celebration sequences do not restart on multi-table tab switches', () => {
    // `playSounds` (ambientSoundsAllowed) flips on every tab switch; in the
    // sequence effects' dependency arrays it re-dropped the mystery chest and
    // restarted the 3.6s knockout mid-flight. It gates AUDIO only — via ref.
    expect(CHEST).toContain('playSoundsRef');
    expect(CHEST).not.toMatch(/\}, \[chestKey, playSounds\]/);
    expect(KO).toContain('playSoundsRef');
    expect(KO).not.toMatch(/\}, \[hit\.id, hit\.isHero, placed, playSounds\]/);
  });

  it('simultaneous knockouts are not serialised behind each other', () => {
    // Two heads in one hand. The retired full-screen overlay was fed through
    // useAnimationQueue — correct for one 3.6s centre-stage ceremony, wrong
    // for an effect drawn on a chair, because the second knockout then stamped
    // a seat that had been empty for three seconds. An ARRAY of live hits, one
    // per busted chair, is what the reference does and what this pins.
    expect(TABLE_PAGE).toMatch(/useState<SeatKnockoutHit\[\]>\(\[\]\)/);
    expect(TABLE_PAGE).not.toMatch(/useAnimationQueue<KnockoutData>/);
  });

  it('the KO stamp outlives the seat it was stamped on', () => {
    // player_eliminated nulls that seat within milliseconds — deliberately, the
    // server only stamps left_at at the END of eliminatePlayer. A knockout
    // rendered as a child of SeatSlot would be unmounted mid-punch, so the
    // layer is a SIBLING of the seat ring and positions itself from the same
    // percentages. If this moves inside the seat map, the animation dies.
    expect(TABLE_PAGE).toMatch(/<SeatKnockoutLayer/);
    expect(TABLE_PAGE).toContain('lastSeatOfUserRef');
  });

  it('the busted seat FLINCHES, on this table, on the impact beat', () => {
    // Dan 2026-08-29: the first cut of the seat knockout did nothing at all to
    // the seat, so a punch landed on a photograph. The mechanism is the one
    // ThrowAnimation has used since 2026-08-15 and it carries that component's
    // hard-won lesson: a bare document.querySelector('[data-seat-num="3"]')
    // hits the FIRST seat 3 in DOM order, which in a multi-table view is
    // somebody else's table.
    expect(KO).toContain("rootRef.current?.closest('.table-page')");
    expect(KO, 'data-seat-num is 1-based; hit.seatIndex is 0-based').toContain(
      'data-seat-num="${hit.seatIndex + 1}"'
    );
    expect(KO).toContain("classList.add('seat--ko-flinch')");
    // Its own class and its own keyframe. The throwable flinch is 450ms and is
    // pinned at 600 * getAnimationSpeed() two describes down; neither may
    // retune the other.
    expect(KO_CSS).toContain('skoSeatFlinch calc(0.2s * var(--animation-speed, 1))');
    // INDIVIDUAL `translate` / `rotate`, never `transform`. `.seat` states
    // carry their own `transform: scale(...)` (hero, active, winner) and a
    // transform keyframe stomps that scale for the whole flinch — three times
    // per knockout, on the seat everyone is looking at. throwable-seat-flinch
    // learned this first and says so in ThrowAnimation.css.
    const flinch = KO_CSS.slice(
      KO_CSS.indexOf('@keyframes skoSeatFlinch'),
      KO_CSS.indexOf('}', KO_CSS.indexOf('100% {', KO_CSS.indexOf('@keyframes skoSeatFlinch')))
    );
    expect(flinch).toContain('translate:');
    expect(flinch, 'a transform keyframe would stomp the seat scale').not.toContain('transform:');
    // Once per LANDING, not once per knockout.
    expect(KO).toContain('for (const at of SKO_PUNCH_AT_MS)');
    expect(KO, 'and it must not borrow the throwable one').not.toContain(
      "classList.add('seat--throw-flinch')"
    );
    // A class added by a timer must be removed by one, or it is stranded on a
    // seat that outlives the animation that added it.
    expect(KO).toContain("classList.remove('seat--ko-flinch')");
  });

  it('the KO stamp does not depend on a font the device may not have', () => {
    // 'Arial Black' is not installed on Android. The one element in this
    // animation that carries INFORMATION rather than drama was falling back to
    // something much lighter for a large share of the userbase — a correctness
    // bug wearing a taste bug's clothes. Two hand-authored glyph paths render
    // identically everywhere, need no font load and cannot FOUT.
    expect(KO_CSS, 'the stamp must not name a font').not.toMatch(
      /\.sko__stamp\s*\{[^}]*font-family/
    );
    expect(KO).toContain('function StampArt');
    // #FC0000 is the measured red off the capture; #ff1f1f (the first cut) is
    // visibly pinker.
    expect(KO).toContain('#fc0000');
  });

  it("the gloves are Dan's art, and they are warm in the cache before the first bust", () => {
    // Dan 2026-08-29 supplied two branded renders. The FIRST cut of this
    // component drew the glove as vector precisely because "a lazily-fetched
    // PNG cannot promise the FIRST knockout of a session animates" — a real
    // constraint, and the answer is a preload at module scope rather than
    // hand-drawing a boxing glove. TablePage imports this module, so both
    // decodes start when a table opens.
    expect(KO).toContain("mediaUrl('images/knockout/glove-left.webp')");
    expect(KO).toContain("mediaUrl('images/knockout/glove-right.webp')");
    expect(KO, 'preloaded, or the first knockout of a session pops').toContain('new Image()');
    expect(KO).toContain('img.decoding');
    // The fist, not the image centre, lands on the seat. If these margins ever
    // go symmetric the punches land beside the player.
    expect(KO_CSS).toContain('--sko-fist-x: 29.2%');
    expect(KO_CSS).toContain('--sko-fist-x: 65.8%');
  });

  it('the boxing-glove THROWABLE is the same flurry, minus the knockout', () => {
    // Dan 2026-08-29: "THIS ANIMATION SHOULD ALSO REPLACE THE BOXING GLOVE
    // ANIMATION INSIDE THE CLUB ARENA THROWABLE. SAME ANIMATION, SAME SOUND
    // EFFECTS (MINUS THE K.O. AT THE END)."
    //
    // ONE implementation, two callers. A second copy of the flurry would drift
    // from this one the first time either is tuned, and every fix would have
    // to be made twice.
    const THROW = read('src/components/table/ThrowAnimation.tsx');
    expect(THROW).toContain("import { KnockoutFlurry } from './SeatKnockout'");
    expect(THROW).toContain("event.throwable.id === 'boxing_glove'");
    // MINUS the knockout: no stamp on a seat that is still occupied, no called
    // "K.O." for a player who has not been eliminated, and no caption or
    // spoken line saying one has.
    expect(THROW).toContain('showStamp={false}');
    expect(THROW).toContain('withCall: false');
    expect(THROW, 'the K.O. caption is gone').not.toMatch(/boxing_glove: 'K\.O\.'/);
    expect(read('src/services/ThrowableVoice.ts'), 'and the spoken line').not.toMatch(
      /boxing_glove: \{ text:/
    );
    // It still scales with the player's Animation Speed, like everything else.
    /* MOVED 2026-08-29, same commit as the change: this read
       `speed: getAnimationSpeed()`. The throwable system now hoists ONE
       `const speed = getAnimationSpeed()` per throw — read once so a setting
       changed mid-flight cannot desynchronise a throw already in the air —
       and the cue is handed that. What matters is unchanged and is what is
       asserted: the knockout cue stretches with the player's setting. */
    expect(THROW).toMatch(/playKnockoutFlurry\(\{[\s\S]*?\n\s*speed,/);
    // The flurry sizes off the THROWABLE's own impact size, not the seat token
    // it cannot see from outside the seat ring.
    expect(THROW).toContain("'--sko-unit': `${Math.round(impactSize * 1.15)}px`");
  });

  it('every SVG gradient id is instance-scoped — a multi-table view mounts several', () => {
    // <defs> ids are global to the DOCUMENT. The FIRST cut of this component
    // dodged that by having no gradients at all, which is precisely why Dan
    // called the art what he called it. useId() is what makes gradients safe
    // here, and this stops the next agent "simplifying" it back out.
    expect(KO).toContain('useId');
    expect(KO, 'ids are built from the instance id, never written literally').toMatch(
      /const g = \(n: string\) => `sko-\$\{n\}-\$\{uid\}`/
    );
  });

  it('the bounty ships on the same beat as the stamp, summed once per winner', () => {
    // Busting two players pays two bounties and the reference shows ONE
    // number. Two floats stacked on one seat is the bug this prevents; the
    // coalescing window IS the stamp beat, so the chips leave as KO lands.
    expect(TABLE_PAGE).toContain('SKO_STAMP_AT_MS * getAnimationSpeed()');
    expect(TABLE_PAGE).toContain('bountyAwardAccRef');
  });

  it('the room-message handler reads live refs, not first-commit closures', () => {
    // The pinned parseIncomingMessage held an EMPTY roster — every incoming
    // throw launched from off-screen instead of the thrower's seat.
    expect(TABLE_PAGE).toContain('parseIncomingMessageRef.current(content, senderId)');
    expect(TABLE_PAGE).toContain('ambientSoundsAllowedRef');
  });

  it('confetti and particle canvases complete even in hidden tabs', () => {
    // Hidden tabs get no rAF; without a wall-clock backstop onComplete never
    // fired and the latched parent state swallowed the NEXT win's burst.
    expect(CONFETTI).toContain('setTimeout(finish, duration + 500)');
    expect(PARTICLES).toContain('setTimeout(finish, duration + 500)');
  });

  it('the deal animation waits long enough to win the roster race', () => {
    // At 800ms the give-up window was SHORTER than the race it absorbs — a
    // slow snapshot meant that hand got NO deal animation, silently.
    const m = DEAL.match(/const SEAT_WAIT_MS = (\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1600);
  });

  it('showdown flip timers live in refs that survive dependency changes', () => {
    // The reveal-order reconciliation re-ran the effect mid-hold; cleanup
    // killed the timer and the rising-edge guard refused a retry — cards
    // snapped face-up with no flip.
    expect(SEAT_TSX).toContain('flipPlayedRef');
    expect(SEAT_TSX).toContain('flipHoldTimerRef');
  });
});

describe('LAW: animations land where they aim, at the speed the player chose', () => {
  it('the chip-flight layer mounts OUTSIDE the shaken scaler', () => {
    // A transform on any ancestor re-anchors the fixed-position layer and
    // displaced every chip in flight — exactly while the pot ships.
    expect(TABLE_PAGE).toContain('moved OUT of .table-scaler');
  });

  it('the big-win shake targets this table via the scaler ref, scaled by animation speed', () => {
    // document.querySelector('.table-page') hit the FIRST table in DOM order
    // (wrong table in multi-table), and a hardcoded 600ms stripped the class
    // mid-keyframe at slow speeds.
    expect(TABLE_PAGE).toMatch(/tableEl\.classList\.add\('table-page--shake'\)/);
    expect(TABLE_PAGE).toMatch(/600 \* getAnimationSpeed\(\)/);
  });

  it('the last speed-blind CSS/JS pairs stay scaled together', () => {
    expect(SEAT_CSS).toContain('seatAllinShake calc(0.4s * var(--animation-speed, 1))');
    expect(SEAT_CSS).toContain('seatWinnerPop calc(0.6s * var(--animation-speed, 1))');
    expect(SEAT_CSS).toContain('seatStackGlow calc(0.6s * var(--animation-speed, 1))');
    expect(SEAT_CSS).toContain('stackDeltaFloat calc(2s * var(--animation-speed, 1))');
    expect(DEALER_BTN).toContain('calc(0.6s * var(--animation-speed, 1))');
    // The knockout is the newest pair and the easiest to break: the glove, the
    // star and the stamp are three CSS animations whose delays have to stay in
    // step with SKO_IMPACT_AT_MS / SKO_STAMP_AT_MS on the JS side.
    // Moved 2026-08-29 with the mechanisms, twice and in the same commits as
    // the changes: the burst was twelve `.sko__ray` divs and is now one
    // irregular path, and the single `skoGloveStrike` became a TWO-GLOVE
    // flurry after Dan supplied branded art and a capture of one.
    expect(KO_CSS).toContain('skoPunchRight calc(0.93s * var(--animation-speed, 1))');
    expect(KO_CSS).toContain('skoPunchLeft calc(0.93s * var(--animation-speed, 1))');
    expect(KO_CSS).toContain('skoFlurryHit calc(0.93s * var(--animation-speed, 1))');
    expect(KO_CSS).toContain('skoStarBurst calc(0.24s * var(--animation-speed, 1))');
    expect(KO_CSS, 'the ray divs are retired').not.toContain('skoRay ');
    expect(KO_CSS, 'and the single-glove strike with them').not.toContain('skoGloveStrike');
    expect(KO_CSS).toContain('calc(0.46s * var(--animation-speed, 1))'); // impact delay
    expect(KO_CSS).toContain('calc(0.93s * var(--animation-speed, 1))'); // stamp delay
    // The audio is no longer a setTimeout at the impact beat — it is ONE cue
    // that carries the whole flurry and schedules it on the AudioContext
    // clock. What still has to scale is the beat table it is handed, and the
    // per-landing seat flinch.
    expect(KO).toContain('SKO_PUNCH_AT_MS');
    expect(KO).toContain('at * speed');
    expect(KO).toMatch(/punchesAtMs: reduced \? \[0\] : SKO_PUNCH_AT_MS/);
  });

  it('throw flinch and shake are scoped to their own table', () => {
    expect(read('src/components/table/ThrowAnimation.tsx')).toContain(
      "rootRef.current?.closest('.table-page')"
    );
  });
});

describe('LAW: the end-of-hand cadence plays in order, every hand', () => {
  it('the button beat holds the deal start at HAND_STARTED', () => {
    // "…PAUSE 1 SECOND, MOVE THE BUTTON ANIMATION… START DEALING NEXT HAND."
    // The puck glides alone, lands with its tock, THEN the cards fly.
    expect(TABLE_PAGE).toContain('HAND_COMPLETION.BUTTON_MOVE_MS * getAnimationSpeed()');
  });
  // The 1-second rest itself (POST_PUSH_PAUSE_MS) is pinned arithmetically in
  // tests/unit/handCompletionLaw.test.ts, in every hold formula.
});

describe('LAW: the throwable system obeys the speed the player chose', () => {
  /* Found 2026-08-29 by counting, not by looking: ThrowAnimation.css and
     ThrowableSignatures.css carried 217 hardcoded durations between them and
     NOT ONE of them scaled, while ThrowAnimation.tsx never called
     getAnimationSpeed() at all. So a player on the slow setting watched every
     other animation on the table stretch to 3x while throwables kept snapping
     past at 1x. CLAUDE.md §10.6 names speed scaling as the one sanctioned
     control over animation duration; the throwables had opted out of it
     wholesale, and nothing noticed because no test had ever asked. */
  const THROW_TSX = read('src/components/table/ThrowAnimation.tsx');
  const THROW_CSS = read('src/components/table/ThrowAnimation.css');
  const SIG_CSS = read('src/components/table/ThrowableSignatures.css');

  it('every animation duration in both throwable stylesheets scales', () => {
    for (const [name, css] of [
      ['ThrowAnimation.css', THROW_CSS],
      ['ThrowableSignatures.css', SIG_CSS],
    ] as const) {
      /* Comments out, THEN scan. `.throw-animation:` inside a prose comment
         satisfies /\banimation:/ - the hyphen is a word boundary - so the
         first version of this test reported a phantom unscaled declaration
         sitting in a paragraph of documentation. The property must also not
         be preceded by a hyphen or a word character, or the same string
         matches all over again. */
      const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const decls = [
        ...code.matchAll(/(?<![-\w])animation(?:-duration|-delay)?\s*:([^;{}]*)/g),
      ].map((m) => m[1]);
      expect(decls.length, `${name} should declare animations`).toBeGreaterThan(20);
      for (const d of decls) {
        // Either it scales, or it defers to one of the four timeline variables
        // that ThrowAnimation.tsx has already scaled in JS, or it is a
        // switch-off with no duration to scale.
        const okay =
          /var\(--animation-speed, 1\)/.test(d) ||
          /var\(--(?:flight|impact|life|linger)-dur/.test(d) ||
          /^\s*(?:none|inherit|unset)\b/.test(d);
        expect(okay, `"${d.trim().slice(0, 70)}" in ${name} must scale`).toBe(true);
      }
    }
  });

  it('the impact caption is a struck BADGE, not floating text', () => {
    /* Dan 2026-08-29, on the PokerBros captures: "THE DESIGN GRAPHICS ETC
       NEEDS TO BE REPLICATED INSIDE OF EVERY SINGLE THROWABLE ANIMATION."
       Theirs is a plate with a starburst behind it; ours was 22px of white
       Rajdhani floating in space. It is one element still — the plate is the
       element, the burst is ::before, the shine is ::after — because a table
       can be running four throws at once. */
    const cap = THROW_CSS.slice(THROW_CSS.indexOf('.throw-animation__caption {'));
    expect(cap, 'the plate').toMatch(/background:\s*\n?\s*linear-gradient/);
    expect(THROW_CSS, 'the starburst').toContain('.throw-animation__caption::before');
    expect(THROW_CSS, 'the struck-metal shine').toContain('.throw-animation__caption::after');
    // Irregular by construction. repeating-conic-gradient at even intervals is
    // the cartoon sun the knockout's first star was, and that mistake is
    // documented at length in SeatKnockout.css.
    expect(cap, 'no evenly-spaced spokes').not.toContain('repeating-conic-gradient');
    expect(cap).toContain('conic-gradient');

    /* color-mix() FALLBACKS. A browser that does not understand color-mix
       throws away the WHOLE declaration, so a single shadow list using it
       would take the bevel and the drop shadow down with the glow. Every
       property that uses color-mix must be declared TWICE — a plain-colour
       floor first, the enhanced version second. */
    for (const prop of ['box-shadow', 'text-shadow', 'background']) {
      const uses = [...cap.matchAll(new RegExp(`\\n  ${prop}:`, 'g'))].length;
      const mixed = [...cap.matchAll(new RegExp(`\\n  ${prop}:[^;]*color-mix`, 'g'))].length;
      if (mixed > 0) {
        expect(
          uses,
          `${prop} uses color-mix and therefore needs a plain-colour declaration before it`
        ).toBeGreaterThan(mixed);
      }
    }
  });

  it('the four JS-computed timeline variables are scaled exactly once', () => {
    // Scaled in JS (here) and NOT again in CSS — double-scaling a duration is
    // as broken as not scaling it, and much harder to spot.
    expect(THROW_TSX).toContain('const speed = getAnimationSpeed();');
    expect(THROW_TSX).toContain("'--flight-dur': `${scaled(physics.duration)}ms`");
    expect(THROW_TSX).toContain("'--impact-dur': `${scaled(impactMs)}ms`");
    expect(THROW_TSX).toContain("'--life-dur': `${scaled(lifeMs)}ms`");
    expect(THROW_TSX).toContain("'--linger-dur': `${scaled(lingerMs)}ms`");
    for (const css of [THROW_CSS, SIG_CSS]) {
      expect(
        css,
        'the timeline vars are pre-scaled; multiplying them again doubles the duration'
      ).not.toMatch(
        /var\(--(?:flight|impact|life|linger)-dur[^)]*\)\s*\*\s*var\(--animation-speed/
      );
    }
  });

  it('the phase timers and the decorative class removals scale too', () => {
    // One scaled `at()` covers all four phase transitions. Scaling at the call
    // sites would be four chances to forget one, and a forgotten one fires an
    // impact before its projectile has landed.
    expect(THROW_TSX).toMatch(/const at = \(ms: number, fn: \(\) => void\) =>[\s\S]*?ms \* speed/);
    expect(THROW_TSX).toContain("'seat--throw-flinch'), 500 * speed");
    expect(THROW_TSX).toContain("'throw-animation--shake'), 520 * speed");
    // The whoosh has to last as long as the flight it is announcing.
    expect(THROW_TSX).toContain('playFlight(t.id, scaled(physics.duration), impactPan)');
  });
});

describe('LAW: a thrown item is an object, not a sticker', () => {
  /* Dan on the PokerBros captures: CURRENTLY ANIMATIONS ARE JUST AN FLAT BASIC
     EMOJI THAT FLOATS AND LANDS, NOT DYNAMIC GRAPHIC ANIMATIONS LIKE THIS.
     Four framework pieces answer that for all ~40 items at once, and each one
     shipped because it was MISSING, so each gets a pin. */
  const THROW_TSX2 = read('src/components/table/ThrowAnimation.tsx');
  const THROW_CSS2 = read('src/components/table/ThrowAnimation.css');
  const SIG_CSS2 = read('src/components/table/ThrowableSignatures.css');

  it('every physics profile casts a contact shadow while it flies', () => {
    // The shadow is the only cue for HEIGHT. Without one per profile, the
    // shadow and the item disagree about where the ground is.
    for (const profile of ['arc', 'fastball', 'float', 'drop', 'swoop', 'spiral']) {
      expect(THROW_CSS2).toMatch(new RegExp(`@keyframes throwable-shadow-${profile}\\b`));
    }
    // lob shares arc's curve, so it shares arc's shadow rather than inventing
    // a second one that could drift from it.
    expect(THROW_CSS2).toContain('.throw-animation__projectile--lob .throw-animation__shadow');
    expect(THROW_TSX2).toContain('className="throw-animation__shadow"');
  });

  it('the flight shadow is a sibling of the spinner, never a child', () => {
    /* A shadow inside .throw-animation__spinner would inherit the arc's
       vertical offset and the tumble spin - it would climb with the item and
       rotate, which tells the eye there is no ground at all. Assert the
       shadow appears BEFORE the spinner opens, at projectile level. */
    const proj = THROW_TSX2.slice(THROW_TSX2.indexOf('throw-animation__projectile--$'));
    const iShadow = proj.indexOf('throw-animation__shadow');
    const iSpinner = proj.indexOf('throw-animation__spinner');
    expect(iShadow).toBeGreaterThan(-1);
    expect(iSpinner).toBeGreaterThan(iShadow);
  });

  it('the motion smear is proportional to the real speed of the throw', () => {
    // Pinned at 0.30 / 0.14, a 420ms fastball and an 1100ms float smeared
    // identically - and the smear is the main thing that separates them.
    expect(THROW_TSX2).toMatch(/--trail-strength/);
    expect(THROW_TSX2).toMatch(/Math\.hypot\(toPos\.x - fromPos\.x/);
    expect(THROW_CSS2).toContain('calc(0.3 * var(--trail-strength, 1))');
    expect(THROW_CSS2).toContain('calc(0.14 * var(--trail-strength, 1))');
  });

  it('a landed item has a shadow on the felt and kicks dust along it', () => {
    expect(THROW_TSX2).toContain('className="throw-animation__ground"');
    expect(THROW_TSX2).toContain('className="throw-animation__dust"');
    expect(THROW_CSS2).toMatch(/@keyframes throwable-ground\b/);
    expect(THROW_CSS2).toMatch(/@keyframes throwable-dust\b/);
    // Dust vectors must be SQUASHED vertically, or the puff reads as a flat
    // screen-plane ring - the exact mistake the knockout star made. Every
    // --dy is smaller in magnitude than its --dx.
    const pairs = [...THROW_CSS2.matchAll(/--dx:\s*(-?[\d.]+)px;\s*\n\s*--dy:\s*(-?[\d.]+)px;/g)];
    expect(pairs.length).toBeGreaterThanOrEqual(6);
    for (const [, dx, dy] of pairs) {
      expect(Math.abs(Number(dy))).toBeLessThan(Math.abs(Number(dx)));
    }
  });

  it('the settle rocks about the base, on its own element, via `rotate`', () => {
    /* Three separate bugs avoided, all of which have shipped here before:
       - `transform` on the settle would stomp the four squash keyframe sets
         that already own transform on the icon (see skoSeatFlinch, CLAUDE.md);
       - rotating about the centre makes a landed object spin rather than rock;
       - a thing rocks on the felt it touches, so the pivot is BELOW centre. */
    expect(THROW_TSX2).toContain('className="throw-animation__settle"');
    const block = THROW_CSS2.slice(
      THROW_CSS2.indexOf('.throw-animation__settle {'),
      THROW_CSS2.indexOf('@keyframes throwable-settle')
    );
    expect(block).toMatch(/transform-origin:\s*0\s+calc\(var\(--impact-size/);
    const kf = THROW_CSS2.slice(
      THROW_CSS2.indexOf('@keyframes throwable-settle'),
      THROW_CSS2.indexOf('@keyframes throwable-settle') + 400
    );
    expect(kf).toMatch(/rotate:/);
    expect(kf).not.toMatch(/transform:/);
  });

  it('no item both rocks under the house settle and under its own signature', () => {
    /* THE DOUBLE-SETTLE GUARD. Eleven items already slip, tumble, tip or
       wobble to rest under a bespoke signature; fx-icon-wobble-settle is
       literally this same animation. The opt-out list is re-derived from
       ThrowableSignatures.css here rather than trusted, so an item whose
       signature GAINS a rotation later cannot quietly start double-rocking. */
    const kfBodies = new Map<string, string>();
    for (const m of SIG_CSS2.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
      kfBodies.set(m[1], m[2]);
    }
    const rotating = new Set(
      [...kfBodies].filter(([, body]) => /rotate[:(]/.test(body)).map(([n]) => n)
    );
    const needOptOut = new Set<string>();
    for (const m of SIG_CSS2.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, sel, body] = m;
      if (!sel.includes('impact-icon')) continue;
      const anim = /animation:\s*([\w-]+)/.exec(body);
      if (!anim || !rotating.has(anim[1])) continue;
      for (const id of sel.matchAll(/data-throwable='([\w-]+)'/g)) needOptOut.add(id[1]);
    }
    expect(needOptOut.size).toBeGreaterThanOrEqual(11);

    const optedOut = new Set(
      [...THROW_CSS2.matchAll(/\.throw-animation\[data-throwable='([\w-]+)'\](?=,|\s*\{)/g)].map(
        (m) => m[1]
      )
    );
    const missing = [...needOptOut].filter((id) => !optedOut.has(id));
    expect(missing).toEqual([]);
    expect(THROW_CSS2).toContain('--settle: 0;');
  });

  it('reduced motion drops the theatrics but keeps the ground shadow', () => {
    /* CLAUDE.md 10.6: reduced motion collapses motion, never meaning. The
       flight shadow and the dust are drama and go; the ground shadow is the
       cue that says the item is ON the felt, so it stops moving and stays. */
    const rm = THROW_CSS2.slice(THROW_CSS2.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rm).toContain('.throw-animation__shadow');
    expect(rm).toContain('.throw-animation__dust');
    expect(rm).toMatch(/\.throw-animation__ground \{\s*\n?\s*animation: none/);
    expect(rm).not.toMatch(/\.throw-animation__ground[^{]*\{[^}]*display: none/);
  });
});

describe('LAW: no throwable ships as a stub', () => {
  /* Measured 2026-08-29 rather than eyeballed: every one of the 48 throwables
     had a signature BLOCK, so "does it have a signature" was useless as a
     question. Counting declarations instead found five that were signatures in
     name only against a median of 23 - robot had ONE declaration, and
     tennis_ball had two and NOT ONE animation, the only item in the set with
     no motion of its own at all. */
  const SIG3 = read('src/components/table/ThrowableSignatures.css');
  const TA3 = read('src/components/table/ThrowAnimation.css');
  const CODE = SIG3.replace(/\/\*[\s\S]*?\*\//g, '');

  /** Declarations + animations actually attached to one item's selectors. */
  function depth(id: string) {
    let decls = 0;
    const anims = new Set<string>();
    for (const m of CODE.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!new RegExp(`data-throwable='${id}'`).test(m[1])) continue;
      decls += (m[2].match(/[a-z-]+\s*:/g) || []).length;
      for (const a2 of m[2].matchAll(/animation:\s*([\w-]+)/g)) anims.add(a2[1]);
    }
    return { decls, anims: anims.size };
  }

  it('the five stub signatures are real animations now', () => {
    // The floor is deliberately well under the median: this pins them as
    // FINISHED, it does not freeze the tuning.
    for (const id of ['robot', 'ghost', 'tennis_ball', 'angry_emoji', 'ufo']) {
      const d = depth(id);
      expect(`${id}:${d.decls >= 18}`).toBe(`${id}:true`);
      expect(`${id}:${d.anims >= 2}`).toBe(`${id}:true`);
    }
  });

  it('tennis_ball has motion at all — it had none', () => {
    expect(depth('tennis_ball').anims).toBeGreaterThanOrEqual(2);
    expect(SIG3).toContain('fx-ball-lines');
    expect(SIG3).toContain('fx-ball-scuff');
  });

  it('no throwable is left with a signature that does nothing', () => {
    const ids = [...new Set([...CODE.matchAll(/data-throwable='([a-z0-9_]+)'/g)].map((m) => m[1]))];
    expect(ids.length).toBeGreaterThanOrEqual(48);
    // boxing_glove is the sanctioned exception: it delegates its whole landing
    // to KnockoutFlurry, so its own block is deliberately thin.
    const stubs = ids
      .filter((id) => id !== 'boxing_glove')
      .filter((id) => depth(id).decls < 8 || depth(id).anims < 1);
    expect(stubs).toEqual([]);
  });

  it('every new signature keyframe is uniquely named', () => {
    /* @keyframes is a GLOBAL namespace shared with ~880 others in this app, so
       a generic name silently overrides someone else's animation. */
    const names = [...SIG3.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.startsWith('fx-')).toBe(true);
  });

  it('a color-mix value always has a plain colour declared before it', () => {
    /* An engine that cannot parse color-mix() discards the WHOLE declaration,
       not just the unknown colour - so the floor has to be a separate earlier
       declaration of the same property, in the same block. */
    for (const [name, css] of [
      ['ThrowableSignatures.css', SIG3],
      ['ThrowAnimation.css', TA3],
    ] as const) {
      const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const missing: string[] = [];
      for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = m[2];
        if (!/color-mix\(/.test(body)) continue;
        const decls = [...body.matchAll(/([a-z-]+)\s*:\s*([^;]*);/g)].map((d) => ({
          p: d[1],
          v: d[2],
        }));
        for (const prop of new Set(decls.filter((d) => /color-mix\(/.test(d.v)).map((d) => d.p))) {
          const all = decls.filter((d) => d.p === prop);
          const at = all.findIndex((d) => /color-mix\(/.test(d.v));
          if (!all.slice(0, at).some((d) => !/color-mix\(/.test(d.v))) {
            missing.push(`${name}: ${m[1].trim().slice(0, 50)} -> ${prop}`);
          }
        }
      }
      expect(missing).toEqual([]);
    }
  });
});

describe('LAW: reduced motion removes motion, never meaning', () => {
  it('the global collapse keeps its escape hatch, and the turn clock uses it', () => {
    // The countdown ring is duration-carrying animation — its length IS the
    // information. Collapsing it finished every countdown instantly.
    expect(REDUCED).toContain("data-motion='keep'");
    expect(SEAT_TSX).toContain('data-motion="keep"');
  });

  it('the KO stamp keeps a readable hold when everything else collapses', () => {
    // The glove and the star are drama and may go. The stamp is the ANSWER to
    // "why did that chair just empty" — under the global 1ms collapse it
    // flashes for a single frame, which is the same as deleting it.
    expect(KO).toContain('data-motion="keep"');
    const reduced = KO_CSS.slice(KO_CSS.indexOf('prefers-reduced-motion'));
    expect(reduced).toMatch(/\.sko__glove[\s\S]*animation:\s*none/);
    expect(reduced).toContain('skoStampReduced');
    // The seat jolt is motion with no information in it, so it is DROPPED
    // rather than collapsed: a 1ms shake is one displaced frame, which is
    // worse than none at all.
    expect(reduced).toContain('.seat--ko-flinch');
    expect(reduced, 'the gloves go too').toContain('.sko__glove');
    expect(reduced, 'and the flurry bursts with them').toContain('.sko__hit');
  });
});

describe('LAW: no toggle may quietly turn the product animation-free or mute', () => {
  it('skip_animations has no consumer', () => {
    // The toggle was retired by Dan's directive; a revived consumer would
    // let a cached true leave a table permanently un-animated.
    for (const p of [
      'src/components/table/SeatSlot.tsx',
      'src/components/table/CommunityCards.tsx',
      'src/components/table/DealAnimation.tsx',
    ]) {
      expect(read(p)).not.toContain('skip_animations');
    }
    // TablePage may MENTION it only in the comment documenting its removal.
    const mentions = TABLE_PAGE.split('skip_animations').length - 1;
    const active = TABLE_PAGE.match(/userSettings(Ref\.current)?\.skip_animations/g) || [];
    expect(active.length).toBe(0);
    expect(mentions).toBeGreaterThanOrEqual(0);
  });

  it('every reaction has a unique glyph so every reaction can render', () => {
    // Laugh, Shock and Dead all shared '◆' — duplicate React keys and an
    // ambiguous wire format meant two of the three could never display.
    const m = REACTIONS.match(/emoji: '([^']+)'/g) || [];
    expect(m.length).toBeGreaterThanOrEqual(6);
    expect(new Set(m).size).toBe(m.length);
  });

  it('the shared sound gate stays the single mute authority', () => {
    // Opening a settings surface must never un-mute the player: every mute
    // writer goes through soundGate's paired keys, and the table's mount sync
    // seeds from the gate (not one key) inside an effect (not the render body).
    const hook = read('src/hooks/useTableSound.ts');
    expect(hook).toContain('soundService.setEnabled(isSoundAllowed())');
    const menu = read('src/components/navigation/HamburgerMenu.tsx');
    expect(menu).toContain('soundService.setEnabled(newValue)');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CRAZY PINEAPPLE - THE DISCARD YOU CAN SEE AND HEAR (Phase 3, 2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, from a live seat: "IT DOESN'T REMOVE THE CARD FROM YOU HAND AFTER YOU
 * DISCARD IT" and "AUTO FOLDED MY HAND, EVEN THOUGH IT DIDN'T."
 *
 * The first was fixed in #2033 and the clock in #2074. What was left is the
 * subject of these pins: a discard rendered NOTHING. The engine has emitted
 * PLAYER_ACTION action:'discard' since the variant shipped, and the client's
 * handler had no arm for it - no animation, no cue, and no change to a
 * villain's card count. Horses discard on a deliberate 1.2s-5.2s humanlike
 * delay, so the felt paused and then jumped: the pause was there and the thing
 * it was hiding was not. The one cue that did fire was `playFold()` - the
 * WRONG action's sound, in the one variant where throwing a card is how you
 * stay in, which is very likely part of what "auto folded my hand, even though
 * it didn't" actually looked like.
 */
describe('LAW: a Crazy Pineapple discard is seen and heard', () => {
  it('the discard has its own cue, and that cue is not born silent', () => {
    // §10.6: every animation is owed its own sound. Before this the discard
    // played playFold() - a two-card brush for a one-card decision, and the
    // sound the table makes when a hand DIES.
    expect(SOUND).toContain('playDiscard()');
    const cue = sliceMethod(SOUND, 'playDiscard() {');
    expect(cue).toContain("this.shouldPlay('discard', 'action')");
    // A cue that schedules nothing audible is a cue that does not exist. This
    // is the same class of bug as the thirteen zero-volume playTone calls at
    // the top of this file: no error, no sound, nobody notices for weeks.
    expect(cue).toMatch(/createSweptNoiseBurst\(|createNoiseBurst\(/);
    expect(cue).not.toMatch(/createSweptNoiseBurst\([^)]*,\s*0(\.0*)?\s*,/);
    expect(cue).not.toMatch(/createNoiseBurst\([^)]*,\s*0(\.0*)?\s*,/);
    expect(cue).toContain('haptic.');
  });

  it('the discard cue outranks the fold it replaced, so it cannot be eaten in its own round', () => {
    // Several seats discard inside one 50ms priority window, and `shouldPlay`
    // rejects `rank <= currentFramePriority`. playPotCollect is the cautionary
    // tale directly above: wired, called, and permanently inaudible.
    const ranks = sliceEnclosingBlock(SOUND, 'pot_collect: 88', 0, 1);
    const rank = (name: string) => Number(new RegExp(`\\b${name}: (\\d+)`).exec(ranks)?.[1]);
    expect(rank('discard')).toBeGreaterThan(rank('fold'));
    expect(rank('discard')).toBeGreaterThan(rank('deal'));
  });

  it('hero fires locally and villains fire from the echo - exactly once each', () => {
    // AUDIT-2 2026-08-20: the echo handler fires for EVERY seat, so a cue
    // played both locally and on the echo is heard twice by the player who
    // acted. `isHeroEcho` is the split, and the discard arm has to live on
    // the same side of it as every other opponent cue.
    expect(TABLE_PAGE).toContain('soundService.playDiscard()');
    const echo = sliceEnclosingBlock(TABLE_PAGE, 'const isHeroEcho =', 0, 1);
    expect(echo).toContain('!isHeroEcho');
    expect(echo).toContain("action === 'discard'");
    // And the hero's own half, at the click.
    const local = sliceMethod(TABLE_PAGE, 'const handlePineappleDiscard = useCallback(');
    expect(local).toContain('soundService.playDiscard()');
    expect(local).not.toContain('soundService.playFold()');
  });

  it('one card leaves the hand, and it is speed-scaled like every other animation', () => {
    // §10.6: --animation-speed is the ONLY sanctioned control. A hard-coded
    // duration ignores the player's setting; a new toggle would be illegal.
    const rule = sliceCssRule(SEAT_CSS, '.seat__card--discarding {');
    expect(rule).toContain('cardDiscardOut');
    expect(rule).toContain('var(--animation-speed, 1)');
    expect(SEAT_CSS).toContain('@keyframes cardDiscardOut');
    // ONE card, not the hand. cardFoldOut is applied to `.seat__card` - every
    // card in the row - and reusing it would have mucked the whole holding.
    expect(SEAT_CSS).not.toContain('.seat__cards--discarding .seat__card');
  });

  it('the seat animates a discard for EVERY seat, off lastAction alone', () => {
    // §10.5 HORSES ARE PLAYERS: a horse's discard arrives as the same
    // PLAYER_ACTION event on the same path. Nothing here may branch on who is
    // sitting in the seat, so there is nothing for `is_horse` to reach.
    expect(SEAT_TSX).toContain("| 'discard'");
    const effect = sliceEnclosingBlock(SEAT_TSX, 'const rising = lastAction === ', 0, 1);
    expect(effect).toContain('setDiscardFlight(true)');
    expect(effect).toContain('getAnimationSpeed()');
    expect(effect).not.toMatch(/is_horse|isHorse/);
    // The JS removal window must outlast the CSS, or the ghost is unmounted
    // mid-flight - the exact bug ANIMATION AUDIT 2026-08-19 found on the fold.
    const windowMs = Number(/\}, (\d+) \* getAnimationSpeed\(\)\);/.exec(effect)?.[1]);
    const cssMs = Number(/cardDiscardOut calc\(([\d.]+)s/.exec(SEAT_CSS)?.[1]) * 1000;
    expect(windowMs).toBeGreaterThan(cssMs);
  });

  it("a villain's discarded card is never revealed, and never rides the public event", () => {
    // In Crazy Pineapple the discard is private - not on the discard, not at
    // showdown. Hole cards do not travel on the public broadcast at all; they
    // go through RLS-protected table_hole_cards, which exists because of a
    // god-mode vulnerability. Putting a rank or suit on `player_action` would
    // re-open it. The villain ghost is therefore hidden, always.
    const villainGhost = sliceEnclosingBlock(SEAT_TSX, 'key="discard-flight"', 0, 1);
    expect(villainGhost).toContain('hidden={true}');
    const engineEmit = sliceEnclosingBlock(
      read('server/src/engine/HandController.ts'),
      "action: 'discard'",
      0,
      1
    );
    expect(engineEmit).not.toMatch(/\bcards?\b|rank|suit/);
  });

  it('the street waits for the toss instead of opening over it', () => {
    // Every other cadence on this platform is a named beat; this one was a
    // synchronous advanceStage() on the same tick as the last discard.
    const spec = read('server/src/config/handCompletionSpec.ts');
    expect(spec).toContain('DISCARD_SETTLE_MS');
    const settle = Number(/DISCARD_SETTLE_MS: (\d+)/.exec(spec)?.[1]);
    const cssMs = Number(/cardDiscardOut calc\(([\d.]+)s/.exec(SEAT_CSS)?.[1]) * 1000;
    expect(settle).toBeGreaterThanOrEqual(cssMs);
    const hc = read('server/src/engine/HandController.ts');
    const check = sliceMethod(hc, 'private checkPineappleDiscardsComplete(): void {');
    expect(check).toContain('HAND_COMPLETION.DISCARD_SETTLE_MS');
    // ...and it can never park a hand: a zero/absent timer advances at once,
    // and the beat is cancellable by the engine that owns the hand.
    expect(check).toContain('this.advanceStage()');
    expect(hc).toContain('public cancelPineappleSettle()');
  });

  it('the discard is recorded on the hand, not only shouted on the wire', () => {
    // AUDIT 2026-08-31. `state.actionHistory` is what getTableState() publishes
    // as action_history, and it is where the client derives every seat's on-felt
    // action label from. performDiscard never wrote to it (only processAction
    // does), so the next snapshot of the discard round said nobody had acted:
    // the "Discard" label was wiped a moment after it appeared, and lastAction
    // fell and rose again - which re-triggers the toss, throwing one card twice.
    const hc = read('server/src/engine/HandController.ts');
    const perform = sliceMethod(hc, 'performDiscard(seat: number, cardIndex: number): boolean {');
    expect(perform).toContain('this.state.actionHistory.push(');
    expect(perform).toContain("action: 'discard'");
    // And the seat may only fly one card per hand however lastAction gets there.
    expect(SEAT_TSX).toContain('inFlightRef');
  });

  it('an all-in seat whose discard the engine makes for it is announced too', () => {
    // AUDIT 2026-08-31: resolvePendingPineappleDiscards spliced the card and
    // emitted CARDS_DEALT only. No PLAYER_ACTION meant no toss, no cue, three
    // backs left on the felt, and the discard missing from hand_history - the
    // Phase 3 bug still alive on the one path a player cannot see coming.
    // CLAUDE.md 10.6: owed every time it is owed, not on the convenient paths.
    const resolve = sliceMethod(
      read('server/src/engine/HandController.ts'),
      'private resolvePendingPineappleDiscards(): void {'
    );
    expect(resolve).toContain("action: 'discard'");
    expect(resolve).toContain("type: 'PLAYER_ACTION'");
  });

  it('every surface that names an action can name a discard', () => {
    // AUDIT 2026-08-31: TableTabBar renders `ACTION_LABEL[flash] ?? flash`, so a
    // missing entry ships the RAW engine token to the multi-table tab strip.
    // 'discard' was unreachable there until the engine started recording it;
    // the moment it became reachable the tab would have flashed a lowercase
    // "discard", against CLAUDE.md 5.7 (Title Case Every Word).
    const tabs = read('src/components/table/TableTabBar.tsx');
    expect(tabs).toMatch(/discard: 'Discard'/);
    expect(SEAT_TSX).toMatch(/case 'discard':\s*\n[^\n]*\n\s*return 'Discard';/);
  });

  it('a discard never borrows the fold treatment', () => {
    // A discard is not a dead hand. Every fold-shaped surface - the greyed
    // seat, the avatar slump, the dimmed card row - is keyed on an exact
    // 'fold', and the avatar gesture map has no discard entry ON PURPOSE:
    // there is no rigged gesture that means "throws one card and plays on",
    // and `fold` would tell the table a live hand had died. That is the exact
    // confusion Dan reported.
    const gestures = sliceEnclosingBlock(SEAT_TSX, "fold: { gesture: 'fold'", 0, 1);
    expect(gestures).not.toMatch(/discard:/);
    expect(SEAT_TSX).not.toMatch(/lastAction === 'fold' \|\| lastAction === 'discard'/);
  });

  it('the discarded card never travels on anything a table can hear', () => {
    // PHASE 4 2026-09-01. The replay can now show you the card you threw, and
    // this is the pin that keeps it YOURS. The handoff for this phase said to
    // persist it in hand_history; hand_history_authenticated_select lets any
    // player who was in a hand read the WHOLE row, so that would have
    // published every player's discard to every opponent, permanently.
    //
    // It goes to hand_discards instead, behind auth.uid() = user_id, carried
    // there by an event the hub never sees - the same split CARDS_DEALT uses.
    const hc = read('server/src/engine/HandController.ts');
    expect(hc).toContain("type: 'PINEAPPLE_DISCARDED'");
    const events = read('server/src/engine/ServerTableEngineHandEvents.ts');
    // Anchored INSIDE the arm, not on the `case` label: the label sits before
    // the arm's own brace, so walking up from it lands on the whole switch.
    const arm = sliceEnclosingBlock(events, 'await this.persistDiscardedCard(', 0, 1);
    // The whole point: this arm persists, and it does NOT broadcast.
    expect(arm).toContain('persistDiscardedCard');
    expect(arm).not.toContain('emitEvent');
    // And the public action event still carries nothing card-shaped.
    const dealing = read('server/src/engine/ServerTableEngineDealing.ts');
    expect(dealing).toContain("from('hand_discards')");
    // The client asks Postgres for the discard without naming a user, because
    // the policy is what filters. A viewer id here would be a filter that can
    // be got wrong; there is none, and there must not be one.
    const svc = read('src/services/HandHistoryService.ts');
    const fetcher = sliceMethod(svc, 'private async fetchOwnDiscards(');
    expect(fetcher).toContain("from('hand_discards')");
    expect(fetcher).not.toMatch(/auth\.getUser|requestingUserId|currentUserId/);
  });

  it('the felt names the game the engine actually deals', () => {
    // The `pineapple` variant has always run CRAZY Pineapple - the discard
    // comes after the flop. Plain Pineapple discards before it, which is a
    // different game. Every surface a player READS says so now; the variant
    // KEY stays `pineapple`, because it is in millions of hand_history rows
    // and ~120 live table rows and renaming a key to fix a label is an outage.
    expect(read('src/utils/handFormat.ts')).toContain("return 'Crazy Pineapple'");
    expect(read('src/components/lobby/lobbyEntries.ts')).toContain("long: 'Crazy Pineapple'");
    expect(read('src/lib/constants.ts')).toContain("PINEAPPLE: 'Crazy Pineapple'");
    // The key is untouched wherever it is a key.
    expect(read('src/lib/holeCardCount.ts')).toMatch(/\bpineapple: 3\b/);
  });

  it('the card you threw reaches the panel at the table, not only the replay', () => {
    /* PHASE 4 COMPLETION 2026-09-01. Phase 4 taught the STANDALONE replay
       which card you threw and stopped there. The hand-history panel that
       slides out at the table - the surface a player reviews the last hand on
       mid-session, without leaving the felt - still printed the word
       "discard" and nothing else, and so did the Hand Detail modal it opens.
       Same fetch, same policy, same map; it simply never reached that list.

       The pin is on the SHAPE of the gate, because that is the part that can
       be got wrong later: the service attaches the card by looking the
       ACTION'S OWN user id up in a map that only ever holds the viewer's rows
       (RLS: hand_discards_read_own). Any other key - a hero id, a seat, a
       "current user" - would be a filter that can drift, which is exactly what
       fetchOwnDiscards was written to avoid. */
    const svc = read('src/services/HandHistoryService.ts');
    expect(svc).toMatch(/discarded_card:\s*\n?\s*a\?\.action === 'discard'/);
    expect(svc).toContain("discardedCards[String(a?.userId || '')]");

    // The adapter carries it across to the panel's own view model, as a
    // canonical code - the suit is stored as a WORD, and slicing the last
    // character of "hearts" prints a spade (see utils/cardCode.ts).
    const adapter = read('src/lib/handHistoryAdapter.ts');
    expect(adapter).toContain('discardedCard: a.discarded_card ? toCardCode(a.discarded_card)');

    // Both in-table surfaces draw it.
    expect(read('src/components/table/HandHistoryPanel.tsx')).toContain(
      '<CardChip code={a.discardedCard} />'
    );
    expect(read('src/components/table/HandDetailModal.tsx')).toContain('a.discardedCard');
  });

  it('nothing about the discard can be switched off', () => {
    // §10.6: no new toggle may disable an animation or its cue. The only
    // control is --animation-speed, asserted above.
    expect(SEAT_CSS).not.toMatch(/discard[A-Za-z]*\s*:\s*(none|hidden)/i);
    expect(SETTINGS_HOOK).not.toMatch(/discard_animation|show_discard|skip_discard/);
  });
});

describe('LAW: dead settings stay dead', () => {
  it('the retired auto-switch keys are tombstoned, not re-offered', () => {
    expect(SETTINGS_HOOK).toContain('NO AUTO TABLE SWITCHING');
    expect(SETTINGS_HOOK).not.toMatch(/key: 'multi_auto_switch'/);
    expect(SETTINGS_HOOK).not.toMatch(/key: 'multi_action_queue'/);
  });
});
