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

describe('LAW: dead settings stay dead', () => {
  it('the retired auto-switch keys are tombstoned, not re-offered', () => {
    expect(SETTINGS_HOOK).toContain('NO AUTO TABLE SWITCHING');
    expect(SETTINGS_HOOK).not.toMatch(/key: 'multi_auto_switch'/);
    expect(SETTINGS_HOOK).not.toMatch(/key: 'multi_action_queue'/);
  });
});
