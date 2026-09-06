/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A HAND IS OVER WHEN THE BEATS HAVE PLAYED, NOT WHEN A TIMER SAYS SO
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-21: "A HAND IS NOT COMPLETED, UNTIL THE WINNING HAND IS SHOWN AT
 * SHOW DOWN AND IDENTIFIED, THE PUSH POT ANIMATION, WITH THE POT TOTAL HAS RAN.
 * AND ACTUALLY PUSHED THE POT TO THE WINNER, THAT THE CARDS ARE MUCKED... THE
 * NEXT HAND STARTS WITH THE DEALING CARDS ANIMATION."
 *
 * The engine's hold is DERIVED from the animation spec, so an animation change
 * can never silently truncate the sequence again. The bug that motivated it:
 * the pot-win float runs 2200ms and only starts after the 700ms bets sweep —
 * 2900ms of animation inside a hand-written 2600ms hold, so the next hand was
 * dealt on top of the number telling the player what they had won.
 */
import { describe, it, expect } from 'vitest';
import { HEADS_UP_SEATS } from '../../src/config/headsUpSpec';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  HAND_COMPLETION,
  handCompletionHoldMs,
  boardClearMs,
} from '../../src/config/handCompletionSpec';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('the spec is mirrored byte-for-byte into the engine', () => {
  it('client and server copies are identical', () => {
    // server/tsconfig sets rootDir ./src, so the engine cannot import the
    // app's copy. Change one, change both — this is what enforces it.
    expect(read('server/src/config/handCompletionSpec.ts')).toBe(
      read('src/config/handCompletionSpec.ts')
    );
  });
});

describe('every beat is inside the hold', () => {
  it('a fold win still waits for sweep + pot push + muck + the one-second rest', () => {
    const hold = handCompletionHoldMs({ wentToShowdown: false });
    expect(hold).toBe(
      HAND_COMPLETION.BETS_SWEEP_MS +
        HAND_COMPLETION.POT_PUSH_MS +
        HAND_COMPLETION.MUCK_MS +
        HAND_COMPLETION.POST_PUSH_PAUSE_MS
    );
  });

  it("Dan 2026-08-27: the pause is a FULL second, and the button glide is the client's own beat", () => {
    // "...PUSH POT ANIMATION PLUS THE +XXX TOTAL ANIMATION, PAUSE 1 SECOND,
    // MOVE THE BUTTON ANIMATION... START DEALING NEXT HAND."
    expect(HAND_COMPLETION.POST_PUSH_PAUSE_MS).toBe(1000);
    // The button beat exists and covers the 600ms CSS glide with settle. It
    // is NOT in the engine hold (the client cannot know the new button seat
    // until HAND_STARTED arrives) — TablePage delays the deal start by it.
    expect(HAND_COMPLETION.BUTTON_MOVE_MS).toBeGreaterThanOrEqual(600);
    const fold = handCompletionHoldMs({ wentToShowdown: false });
    expect(fold - HAND_COMPLETION.POST_PUSH_PAUSE_MS).toBe(
      HAND_COMPLETION.BETS_SWEEP_MS + HAND_COMPLETION.POT_PUSH_MS + HAND_COMPLETION.MUCK_MS
    );
  });

  it('THE REGRESSION: the hold outlasts the pot-win float, which starts after the sweep', () => {
    // 700 + 2200 = 2900. The old hand-written hold was 2600 and cut it off.
    const floatEndsAt = HAND_COMPLETION.BETS_SWEEP_MS + HAND_COMPLETION.POT_PUSH_MS;
    expect(handCompletionHoldMs({ wentToShowdown: false })).toBeGreaterThanOrEqual(floatEndsAt);
    expect(handCompletionHoldMs({ wentToShowdown: true })).toBeGreaterThanOrEqual(floatEndsAt);
    expect(floatEndsAt).toBeGreaterThan(2600);
  });

  it('a showdown adds time to read the winning hand, and more hands need more', () => {
    const hu = handCompletionHoldMs({ wentToShowdown: true, showdownHands: 2 });
    const three = handCompletionHoldMs({ wentToShowdown: true, showdownHands: 3 });
    const fold = handCompletionHoldMs({ wentToShowdown: false });
    expect(hu).toBeGreaterThan(fold);
    expect(three).toBeGreaterThan(hu);
  });

  it('a huge multiway showdown is capped so the table cannot stall', () => {
    const massive = handCompletionHoldMs({ wentToShowdown: true, showdownHands: 9 });
    const capped =
      HAND_COMPLETION.SHOWDOWN_READ_MAX_MS +
      HAND_COMPLETION.BETS_SWEEP_MS +
      HAND_COMPLETION.POT_PUSH_MS +
      HAND_COMPLETION.MUCK_MS +
      HAND_COMPLETION.POST_PUSH_PAUSE_MS;
    expect(massive).toBe(capped);
  });

  it('a Bad Beat Jackpot holds for the whole celebration', () => {
    expect(handCompletionHoldMs({ wentToShowdown: true, bbjHit: true })).toBe(
      HAND_COMPLETION.BBJ_CELEBRATION_MS
    );
    expect(HAND_COMPLETION.BBJ_CELEBRATION_MS).toBeGreaterThan(
      handCompletionHoldMs({ wentToShowdown: true, showdownHands: 9 })
    );
  });

  it('the board clear is its own beat, longer after a showdown', () => {
    expect(boardClearMs(true)).toBeGreaterThan(boardClearMs(false));
  });

  it('a run-it-twice hand holds for the whole client reveal timeline (2026-08-26)', () => {
    // The engine settles RIT synchronously; the CLIENT deals the boards
    // street by street afterwards. The hold must cover that timeline or the
    // next hand deals over a board still turning its river.
    const single = handCompletionHoldMs({ wentToShowdown: true, showdownHands: 2 });
    const rit2 = handCompletionHoldMs({
      wentToShowdown: true,
      showdownHands: 2,
      ritRuns: 2,
      ritStreetsPerRun: 3,
    });
    const rit3 = handCompletionHoldMs({
      wentToShowdown: true,
      showdownHands: 2,
      ritRuns: 3,
      ritStreetsPerRun: 3,
    });
    // Exactly the client timeline in TablePage's rit_result handler: the
    // street-by-street reveal, then one RESULT window per run (ribbon →
    // ship → settle — the 3X recording shows the winner phase replays run
    // by run), then the pot-push/muck beats every hand carries.
    const H = HAND_COMPLETION;
    const push = H.BETS_SWEEP_MS + H.POT_PUSH_MS + H.MUCK_MS + H.POST_PUSH_PAUSE_MS;
    /* 2026-09-04 second sweep: the last ribbon lands RIT_RIBBON_MS after the
       last river, and the hold covers it. This pin used to omit the ribbon -
       the server was 900ms short of the client's last ribbon, against a
       comment claiming "same arithmetic". */
    const reveal2 = H.RIT_REVEAL_LEAD_MS + 2 * 3 * H.RIT_STREET_MS + 1 * H.RIT_RUN_GAP_MS;
    expect(rit2).toBe(reveal2 + H.RIT_RIBBON_MS + 2 * H.RIT_RESULT_RUN_MS + push);
    expect(rit3).toBeGreaterThan(rit2);
    // A river-only re-deal (turn all-in) holds far less than a full re-deal.
    const rit2river = handCompletionHoldMs({
      wentToShowdown: true,
      showdownHands: 2,
      ritRuns: 2,
      ritStreetsPerRun: 1,
    });
    expect(rit2river).toBeLessThan(rit2);
    expect(rit2river).toBeGreaterThan(single);
    // ritRuns 0/undefined leaves the single-run hold untouched.
    expect(handCompletionHoldMs({ wentToShowdown: true, showdownHands: 2, ritRuns: 0 })).toBe(
      single
    );
  });
});

describe('the engine uses the spec instead of hand-written numbers', () => {
  const DEALING = strip(read('server/src/engine/ServerTableEngineDealing.ts'));

  it('the hold and the board clear both come from the spec', () => {
    expect(DEALING).toMatch(/handCompletionHoldMs\(\{/);
    expect(DEALING).toMatch(/boardClearMs\(wentToShowdown\)/);
  });

  it('the old magic numbers are gone', () => {
    expect(DEALING).not.toMatch(/RESULT_DISPLAY_FOLD_MS\s*=\s*2600/);
    expect(DEALING).not.toMatch(/SHOWDOWN_BASE_MS\s*=\s*2600/);
    expect(DEALING).not.toMatch(/sleep\(wentToShowdown \? 900 : 500\)/);
  });

  it('showdown state and the BBJ still drive the decision', () => {
    expect(DEALING).toMatch(/wentToShowdown/);
    expect(DEALING).toMatch(/currentHandBBJHit/);
  });
});

describe('the next hand opens with the dealing animation', () => {
  const TABLE_PAGE = strip(read('src/pages/TablePage.tsx'));

  it('a new hand bumps the deal animation and the per-seat card slide', () => {
    expect(TABLE_PAGE).toMatch(/setDealAnimationKey\(\(k\) => k \+ 1\)/);
    expect(TABLE_PAGE).toMatch(/setIsSeatDealing\(true\)/);
  });

  it('cards are never allowed to simply appear: the deal has a sound too', () => {
    expect(TABLE_PAGE).toMatch(/playShuffle\(\)/);
  });
});

describe('the fold sound is a swoosh, not a ding', () => {
  // The file is SoundService.ts. macOS is case-insensitive so this resolved
  // locally and then failed on Linux CI with ENOENT, taking the whole suite
  // down and blocking the World Hub bundle for everyone.
  const SOUND = read('src/services/SoundService.ts');
  // Anchor on the METHOD, not the file's doc header, which also names
  // playFold() and would slice the wrong region.
  const foldAt = SOUND.indexOf('\n  playFold() {');
  // Bound at the method's own closing brace: a fixed-width slice ran into the
  // NEXT sound method and read its oscillator as if it were the fold's.
  const foldEnd = SOUND.indexOf('\n  }', foldAt);
  // Strip comments: the method's own doc explains what the OLD sawtooth
  // version sounded like, and an un-stripped slice matches that prose.
  const fold = strip(SOUND.slice(foldAt, foldEnd));

  it('no pitched oscillator survives in the fold', () => {
    // A sawtooth has a fundamental; a short pitched tone IS the ding.
    expect(fold).not.toMatch(/createOscillator\(\)/);
    expect(fold).not.toMatch(/sawtooth/);
  });

  it('it is broadband air swept downward, like cards sliding away', () => {
    expect(fold).toMatch(/bandpass/);
    expect(fold).toMatch(/frequency\.exponentialRampToValueAtTime\(/);
    expect(fold).toMatch(/createNoiseBurst\(/);
  });

  it('it stays quiet enough not to out-shout the action', () => {
    const peak = fold.match(/linearRampToValueAtTime\(([\d.]+), t \+ 0\.035\)/);
    expect(peak, 'fold peak gain not found').not.toBeNull();
    expect(Number(peak![1])).toBeLessThan(0.18); // the old sawtooth peak
  });
});

describe('heads-up is the only sit-n-go we run', () => {
  const REC = strip(read('server/src/services/TournamentRecurringService.ts'));

  it('6-max and 9-max sit-n-go shapes are gone', () => {
    const shapes = REC.slice(
      REC.indexOf('const SNG_BOARD_SHAPES'),
      REC.indexOf('const SNG_BOARD_VARIANTS')
    );
    /**
     * 2026-08-31 (Phase 3): the seat count moved into
     * src/config/headsUpSpec.ts, so the shapes array names HEADS_UP_SEATS
     * rather than a literal. The guarantee is unchanged -- both bands are
     * two-handed and no 6-max or 9-max shape exists -- and it is now asserted
     * against the spec as well as the source, so neither can move alone.
     */
    expect(HEADS_UP_SEATS).toBe(2);
    expect(shapes).toMatch(/seats: (?:2|HEADS_UP_SEATS)\b/);
    expect(shapes).not.toMatch(/seats: 6/);
    expect(shapes).not.toMatch(/seats: 9/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE STUCK-BANNER BACKSTOP TAKES THE BANNER DOWN, AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Added 2026-09-05 because a late or duplicate `pot_win` leaves the winner
 * label up forever: the extend block is gated on `handCompleteTimerRef`, and
 * the reset NULLS that ref when it runs, so a pot_win landing after it writes a
 * fresh winnerInfo and schedules nothing.
 *
 * CORRECTED 2026-09-06, and this is the part worth pinning. The first version
 * preferred `handCompleteResetFnRef.current` "so the board, pot, mucks and
 * stack hold come down together". Nothing on the normal path ever nulls that
 * ref - the closure only nulls the TIMER - so it almost always holds the
 * PREVIOUS hand's reset, and in the very case the backstop exists for (a late
 * pot_win, after HAND_STARTED for the next hand) running it would blank
 * `communityCards`, force `boardStage` to preflop and zero the POT of a hand
 * being played. A backstop for a stuck LABEL must never be able to erase a live
 * board.
 *
 * And it must never truncate a legitimate hold: it waives itself while ANY of
 * the three in-flight clocks is running, not just the reset timer.
 */
describe('the win-banner backstop is a backstop, not a reset', () => {
  const PAGE = read('src/pages/TablePage.tsx');
  /* From the CODE, not from the docblock above it. Slicing at the heading put
     the start INSIDE an open comment, so `strip` (which needs a matched
     open/close pair) left the whole explanation in - and the explanation names
     every identifier these assertions forbid. */
  const fn = PAGE.slice(
    PAGE.indexOf('const winnerStuckTicksRef'),
    PAGE.indexOf('// Unmount guard for all four CA-19..CA-22 animation timers.')
  );

  it('never runs the stored end-of-hand reset closure', () => {
    expect(fn.length, 'the watchdog block must be findable').toBeGreaterThan(500);
    /* The CODE, with the prose stripped: this block explains at length what the
       corrected version must never do, and those sentences name the very
       identifiers the assertions forbid. */
    const code = strip(fn);
    // The ref may be read nowhere here and must certainly never be CALLED.
    expect(code).not.toMatch(/handCompleteResetFnRef/);
    expect(code).not.toMatch(/\breset\(\)/);
    // Nothing that belongs to the hand itself may be touched from here.
    for (const forbidden of ['setTableState', 'communityCards', 'boardStage', 'setRitResult']) {
      expect(code, `the backstop must not touch ${forbidden}`).not.toContain(forbidden);
    }
    // What it DOES do: clear the winner display.
    expect(code).toMatch(/setWinnerInfo\(\{/);
    expect(code).toMatch(/setWinnerParticle\(/);
  });

  it('waives itself while any of the three in-flight clocks is running', () => {
    expect(fn).toMatch(/handCompleteTimerRef\.current/);
    expect(fn).toMatch(/potAwardAnimEndAtRef\.current > Date\.now\(\)/);
    // The run-it-twice/three reveal is the longest of the three and was the one
    // originally missed - a client that never got HAND_COMPLETE has no timer
    // and no award clock, only this.
    expect(fn).toMatch(/ritRevealEndsAtRef\.current > Date\.now\(\)/);
  });

  it('is a consecutive-idle count, never a ceiling on how long a win may show', () => {
    // ANIMATION LAW: a three-board run-it-twice hold legitimately runs past
    // twenty seconds, so the test must be "is anything scheduled", not elapsed
    // time. A tick count only advances on ticks where nothing is pending.
    expect(fn).toMatch(/winnerStuckTicksRef\.current \+= 1;/);
    expect(fn).toMatch(/winnerStuckTicksRef\.current = 0;/);
    expect(fn).toMatch(/const WINNER_STUCK_TICKS = \d+;/);
  });
});
