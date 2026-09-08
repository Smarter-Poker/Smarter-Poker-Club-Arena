/**
 * THE PRE-ACTION PANEL GATE (Dan 2026-08-29).
 *
 * Dan, verbatim: "WHEN YOU ARE PLAYING IN THE LIVE PAGES, AND YOU CLICK A
 * 'PRE SELECT OPTION' IT SHOULD JUST EXECUTE THAT OPTION ... IT CURRENTLY
 * 'EXECUTES THE CHOICE' BUT THEN IT 'FLASHES THE ACTION TAB BACK UP' BEFORE
 * IT CLOSES IT AGAIN. THAT SHOULDN'T HAPPEN."
 *
 * The engine executes armed pre-actions (Bible V8 §4.15); the client's job
 * is only to NOT flash the ActionPanel during the round-trip gap — and to
 * flash it anyway, on purpose, when the engine cannot honor what is armed,
 * because then the player must act by hand. These beats pin that rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  isPreActionHonorable,
  PRE_ACTION_EXEC_GRACE_MS,
  PRE_ACTION_GAP_BRIDGE_MS,
  PRE_ACTION_GRACE_RTT_MARGIN_MS,
} from '../../src/lib/preActionPanelGate';

describe('isPreActionHonorable — when the panel may stay down', () => {
  it('fold / check-fold is always honorable — the engine can always fold', () => {
    expect(isPreActionHonorable('fold', 0, 0)).toBe(true);
    expect(isPreActionHonorable('fold', 5000, 0)).toBe(true);
  });

  it('Call Any is always honorable, whatever the price became', () => {
    expect(isPreActionHonorable('callAny', 0, 0)).toBe(true);
    expect(isPreActionHonorable('callAny', 99999, 0)).toBe(true);
  });

  it('Check is honorable only while there is nothing to call', () => {
    expect(isPreActionHonorable('check', 0, 0)).toBe(true);
    // A bet arrived: the engine cannot check for the player. The panel MUST
    // come up — suppressing it here would strand the hero on the clock.
    expect(isPreActionHonorable('check', 100, 0)).toBe(false);
  });

  it('Call <N> is honorable only while the price fits the armed cap', () => {
    expect(isPreActionHonorable('call', 300, 300)).toBe(true);
    expect(isPreActionHonorable('call', 200, 300)).toBe(true);
    // Raised past the cap: the engine refuses the auto_call (Dan 2026-08-28),
    // so the player must see the panel and decide.
    expect(isPreActionHonorable('call', 301, 300)).toBe(false);
  });

  it('nothing armed means nothing to suppress', () => {
    expect(isPreActionHonorable(null, 0, 0)).toBe(false);
  });
});

describe('the grace window — suppression may never cost the player their turn', () => {
  it('is long enough to cover an engine round trip, short enough to leave the clock', () => {
    expect(PRE_ACTION_EXEC_GRACE_MS).toBeGreaterThanOrEqual(1000);
    // Turn timers run ~10-20s; the failsafe must return the panel with most
    // of the clock left. Raise this bound only with a reason written here.
    expect(PRE_ACTION_EXEC_GRACE_MS).toBeLessThanOrEqual(4000);
  });
});

describe('THE TIMING CONTRACT with the engine (2026-08-29 hardening)', () => {
  /* The engine holds a pre-action for a visible beat before landing it
     (preActionVisibleMs — Dan 2026-08-20: "a pre-action is still an ACTION
     and must be seen"). The client suppresses the ActionPanel for
     PRE_ACTION_EXEC_GRACE_MS while waiting. These two constants live in two
     different runtimes; NOTHING at runtime checks them against each other.
     This test reads both files, so raising the engine's beat without raising
     the client's grace — which would put the flash back on every single
     pre-action — cannot land. */
  it('the client grace covers the engine beat plus a slow round trip', () => {
    const turns = readFileSync(
      path.resolve(__dirname, '../../server/src/engine/ServerTableEngineTurns.ts'),
      'utf8'
    );
    const m = turns.match(/preActionVisibleMs\s*=\s*(\d+)/);
    expect(
      m,
      'preActionVisibleMs is gone from ServerTableEngineTurns — find its successor'
    ).toBeTruthy();
    const beatMs = Number(m![1]);
    expect(beatMs).toBeGreaterThan(0);
    expect(
      PRE_ACTION_EXEC_GRACE_MS,
      `grace (${PRE_ACTION_EXEC_GRACE_MS}ms) must exceed the engine beat (${beatMs}ms) ` +
        `by at least ${PRE_ACTION_GRACE_RTT_MARGIN_MS}ms of round-trip margin`
    ).toBeGreaterThanOrEqual(beatMs + PRE_ACTION_GRACE_RTT_MARGIN_MS);
  });
});

describe('THE BAR DOES NOT BLINK BETWEEN ACTORS (Dan 2026-09-07)', () => {
  /* Dan, verbatim: "THE ACTION TAB CONSTANTLY DISAPPEARS AND REAPPEARS ON THE
     BOTTOM, WHEN ACTION MOVES, EVEN IF THE ACTION HAS NOT CHANGED ... PRE
     ACTION SELECTOR SHOULD STAY ON THE BOTTOM."

     The cause was one clause. Every action at the table blanks
     `currentPlayerSeat` to 0 before the next actor is known, so the live value
     is `seat N -> 0 -> seat M` on every action by every player; a
     `currentPlayerSeat > 0` clause in the PreActionBar's gate therefore
     unmounted the bar in that gap and remounted it a moment later, replaying
     its entrance animation for a change that had not happened. */
  const PAGE = readFileSync(path.resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

  it('the PreActionBar gate asks whether a turn is still to COME', () => {
    /* CORRECTED THE SAME DAY, and the correction is the interesting part.
       The first fix simply deleted the `currentPlayerSeat > 0` clause, which
       stopped the blink and started something worse: `0 !== heroSeat` is also
       true after the hand stops taking action, and `isHandInProgress` does not
       separate the two (it is `boardStage !== 'waiting'`, so it stays true
       through showdown and the whole 2.1-3.5s HAND_COMPLETE hold). The bar sat
       over every winner presentation and every all-in runout.

       `handStillTakingAction` is the honest question, and it is answered by an
       EXACT flag off HAND_COMPLETE plus a BOUNDED bridge for the one silence
       that has no event. */
    const at = PAGE.indexOf('<PreActionBar');
    expect(at).toBeGreaterThan(-1);
    const gate = PAGE.slice(PAGE.lastIndexOf('{handStillTakingAction &&', at), at);
    expect(gate).toContain('handStillTakingAction');
    expect(gate).toContain('tableState.currentPlayerSeat !== tableState.heroSeat');
    expect(
      gate,
      'a `currentPlayerSeat > 0` clause here unmounts the bar between every actor'
    ).not.toContain('tableState.currentPlayerSeat > 0');
  });

  it('the settling flag is driven by EVENTS, not by a clock', () => {
    /* The end of a hand and the start of one are both things the engine
       announces. A duration would only be a guess at them, and the guess would
       be wrong on any table whose hold length changed - which it did, twice,
       in this same batch of work. */
    expect(PAGE).toMatch(/setHandSettling\(true\)/);
    expect(PAGE).toMatch(/setHandSettling\(false\)/);
    const settle = PAGE.indexOf('setHandSettling(true)');
    const complete = PAGE.lastIndexOf("case 'HAND_COMPLETE'", settle);
    const started = PAGE.lastIndexOf("case 'HAND_STARTED'", PAGE.indexOf('setHandSettling(false)'));
    expect(complete, 'the true-set belongs to HAND_COMPLETE').toBeGreaterThan(-1);
    expect(started, 'the false-set belongs to HAND_STARTED').toBeGreaterThan(-1);
  });

  it('the bridge is short - it covers a round trip, never a whole hand', () => {
    /* A timer is the fallback for the ONE silence with no event: the gap
       between two actors. It must give up quickly, or an all-in runout or a
       stalled engine keeps claiming a turn is coming. */
    expect(PRE_ACTION_GAP_BRIDGE_MS).toBeGreaterThanOrEqual(600);
    expect(PRE_ACTION_GAP_BRIDGE_MS).toBeLessThanOrEqual(2000);
  });

  it('the ActionPanel KEEPS its > 0 guards - a `===` test can read 0 === 0', () => {
    /* The two gates are not symmetrical and must not be "tidied" into each
       other. `currentPlayerSeat === heroSeat` is true for a microsecond on
       every snapshot churn when both are 0, which is the 2026-04-14 flicker
       burst; `!==` cannot have that failure, because both being 0 requires
       heroSeat 0 and the gate asserts heroSeat > 0. */
    const at = PAGE.indexOf('heroActionRenderedRef.current = true');
    expect(at).toBeGreaterThan(-1);
    const gate = PAGE.slice(PAGE.lastIndexOf('{tableState.heroSeat > 0 &&', at), at);
    expect(gate).toContain('tableState.currentPlayerSeat > 0');
    expect(gate).toContain('tableState.currentPlayerSeat === tableState.heroSeat');
  });

  it('both bars still collapse when the hand is not in progress', () => {
    // The between-hands case the removed clause was credited with covering is
    // covered here, and covered honestly. The bar's gate opens with
    // `handStillTakingAction`, which is itself built on isHandInProgress -
    // read the gate from its own first clause, not from whatever JSX happens
    // to precede it (2026-09-04: the control strip above it stopped reading
    // isHandInProgress directly, and this pin was anchored on that).
    const at = PAGE.indexOf('<PreActionBar');
    const gate = PAGE.slice(PAGE.lastIndexOf('{handStillTakingAction &&', at), at);
    expect(gate).toContain('handStillTakingAction');
    expect(gate).toContain('tableState.heroSeat > 0');
    expect(PAGE).toMatch(/const handStillTakingAction =\s*\n?\s*tableState\.isHandInProgress &&/);
  });

  it('every "your turn" surface reads heroPromptedToAct, not the seat (Dan 2026-09-04)', () => {
    /* "IT STILL 'PROMPTS YOU' AND STARTS THE CLOCK FOR A SPLIT SECOND INSTEAD
       OF JUST EXECUTING THE PRE TURN ACTION YOU'VE SELECTED." The 2026-08-29
       fix gated the ActionPanel alone; six other surfaces kept announcing the
       turn for the engine's 900ms pre-action beat. One boolean now, and each
       surface is pinned to it by name so the next one added cannot drift. */
    expect(PAGE).toMatch(
      /const heroPromptedToAct = isHeroTurnContext && !suppressPanelForPreAction;/
    );
    // the HUD time-bank tile
    expect(PAGE).toMatch(/hudSlotControl: 'timebank' \| 'rabbit' \| null = heroPromptedToAct/);
    // the page pulse
    expect(PAGE).toMatch(/\$\{heroPromptedToAct \? ' table-page--hero-turn' : ''\}/);
    // the control strip (time bank button + ticking numeral)
    expect(PAGE).toMatch(
      /\{heroPromptedToAct && \(\s*\n\s*<div className="control-strip control-strip--transparent">/
    );
    // the clock warning
    expect(PAGE).toMatch(/const isHeroOnTheClock =[\s\S]{0,400}!suppressPanelForPreAction;/);
    // the bottom-bar reserve
    const stateAt = PAGE.indexOf("const heroActionState: 'none' | 'waiting' | 'active'");
    const activeArm = PAGE.slice(stateAt, PAGE.indexOf("return 'active'", stateAt));
    expect(activeArm).toContain('!suppressPanelForPreAction');
    // the hero's own seat ring/highlight
    expect(PAGE).toMatch(
      /isActive=\{\s*\n\s*seatNumber === tableState\.currentPlayerSeat &&[\s\S]{0,700}!\(displayPlayer\?\.isHero && suppressPanelForPreAction\)/
    );
    // the bell and the buzz defer while a pre-action is armed - through STATE,
    // because the snapshot lands before the discrete turn_change and a ref
    // write would not re-run the effect (2026-09-08 sweep)
    expect(PAGE).toMatch(
      /if \(preActionArmedRef\.current !== null\) \{\s*\n\s*setTurnAlertDeferred\(true\);/
    );
    expect(PAGE).toMatch(/if \(heroPromptedToAct && turnAlertDeferred\) \{/);
    expect(PAGE).not.toMatch(/deferredTurnAlertRef/);
    // the multi-table surfaces (tab badge, soft ping, dock countdown) read it too
    const reportAt = PAGE.indexOf('isMyTurn: isHeroTurn,');
    expect(reportAt).toBeGreaterThan(-1);
    const isHeroTurnDecl = PAGE.lastIndexOf('const isHeroTurn =', reportAt);
    expect(PAGE.slice(isHeroTurnDecl, reportAt)).toContain('heroPromptedToAct');
    // and the gate is declared ABOVE that effect, or it would be a TDZ read
    expect(PAGE.indexOf('const heroPromptedToAct =')).toBeLessThan(isHeroTurnDecl);
    // the bottom-bar reserve holds 'waiting' through the beat, never 'none'
    const stateAt2 = PAGE.indexOf("const heroActionState: 'none' | 'waiting' | 'active'");
    const waitingArm = PAGE.slice(
      PAGE.indexOf("return 'active'", stateAt2),
      PAGE.indexOf("return 'waiting'", stateAt2)
    );
    expect(waitingArm).toContain('suppressPanelForPreAction');
  });
});

describe('the disarm lives on the PAGE, not only in the bar (2026-08-29 hardening)', () => {
  /* PreActionBar unmounts the moment the turn arrives — the exact boundary
     where a raise can invalidate an armed Call/Check. TablePage must run the
     same honorability rule itself so the arm clears even with the bar gone.
     Source-level pin: the trigger is a snapshot arriving at a mount boundary,
     which no unit harness can honestly reproduce. */
  it('TablePage clears an unhonorable arm through isPreActionHonorable', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    expect(
      /if \(!isPreActionHonorable\(preAction, preActionCallDue, preActionCallAmountRef\.current\)\) \{\s*\n\s*setPreAction\(null\);/.test(
        src
      ),
      'the page-level disarm is gone — an armed pre-action invalidated at the ' +
        'turn boundary (bar unmounted) would sit stale for the engine to refuse'
    ).toBe(true);
  });
});
