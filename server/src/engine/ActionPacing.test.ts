/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACTION PACING — no action, by anyone, is ever instant
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20: "every player's action MUST GO IN TURN. Every single active
 * player must make a move — check, bet, fold, raise or all in — their action
 * MUST BE DISPLAYED, an animation MUST PLAY after every decision. NO action for
 * any horse or player can EVER be skipped or rushed. THE GAME SPEED NEEDS TO
 * SLOW DOWN TO FEEL MORE REAL."
 *
 * These are the constants that make that true. They are asserted here because
 * they are the kind of number a future "performance" change quietly halves, and
 * the damage (a street resolving in milliseconds) is invisible to every other
 * test in the suite — the chips still end up in the right place.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE = join(__dirname);
const read = (f: string) => readFileSync(join(ENGINE, f), 'utf8');

describe('every action gets a settle beat before the turn moves on', () => {
  const turns = read('ServerTableEngineTurns.ts');
  const runout = read('ServerTableEngineRunout.ts');
  const events = read('ServerTableEngineHandEvents.ts');

  it('TURN_CHANGE settles before putting the next player on the clock', () => {
    // Every action path — human submit, horse think-timer, pre-action, turn
    // timeout, time-bank expiry, disconnect auto-action — funnels through
    // TURN_CHANGE. One settle here paces all of them and cannot be bypassed.
    // The settle is a ternary now (hand-start / street / ordinary action all
    // route through the same await), so assert the await and the fallback.
    expect(events).toMatch(/await this\.sleep\(/);
    expect(events).toContain('this.actionSettleMs');
  });

  it('the settle beat outlives the 500ms chip slide (cpSlideIn)', () => {
    const m = runout.match(/actionSettleMs\s*=\s*(\d+)/);
    expect(m, 'actionSettleMs must be defined').toBeTruthy();
    const ms = Number(m![1]);
    expect(ms).toBeGreaterThan(500);
  });

  it('the settle re-checks the hand after sleeping (no action into a dead hand)', () => {
    expect(events).toContain('this.handController !== controllerAtAction');
    expect(events).toContain('this.handCount !== handAtAction');
  });
});

describe('a queued pre-action is still a visible turn', () => {
  const turns = read('ServerTableEngineTurns.ts');

  it('holds a readable beat instead of firing at 0ms', () => {
    expect(turns).toContain('await this.sleep(this.preActionVisibleMs)');
  });

  it('the beat is never zero', () => {
    const m = turns.match(/preActionVisibleMs\s*=\s*(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(500);
  });

  it('re-validates the seat is still to act after the beat', () => {
    // The hand can be replaced while the beat is held.
    expect(turns).toContain('if (st.currentPlayerSeat !== seat) return;');
  });
});

describe('horse tempo - random, per-horse, from a snap to a time bank', () => {
  const turns = read('ServerTableEngineTurns.ts');
  const logic = read('HorseLogic.ts');

  // ── SUPERSEDED, deliberately ──────────────────────────────────────────
  // This block used to pin HORSE_MIN_THINK_MS, a 2200ms FLOOR, under the
  // heading "never instantly". Dan 2026-08-23 replaced that instruction:
  //   "TIMING ON STREETS MUST BE MORE RANDOM. Most horses are making their
  //    decisions at about the same rate on every street. This must be
  //    completely random, from instant, to full 15 seconds or even using
  //    time banks."
  // The floor was in fact the CAUSE of the complaint: HorseLogic already
  // produced a spread and the floor collapsed its whole fast half onto one
  // number, so seat after seat acted at exactly 2.2 seconds. The animation
  // concern the floor existed for is still met — every action gets the
  // settle beat asserted at the top of this file, which is what actually
  // gives the animation its airtime.

  it('there is NO think-time floor flattening the fast half of the range', () => {
    expect(turns).not.toContain('HORSE_MIN_THINK_MS');
  });

  it('the settle beat - not a think-time floor - is what protects animations', () => {
    const events = read('ServerTableEngineHandEvents.ts');
    expect(events).toContain('this.actionSettleMs');
  });

  it('think time is drawn from a MIXTURE, not one narrow band', () => {
    // A uniform draw over a narrow band is the tell: every gap feels alike.
    // Four modes — snap, a beat, a tank, a time bank — is what a real table
    // looks like.
    expect(logic).toContain('wSnap');
    expect(logic).toContain('wBeat');
    expect(logic).toContain('wTank');
    expect(logic).toContain('wBank');
  });

  it('every horse has its OWN tempo, stable for its lifetime', () => {
    // Derived from the user id, so a quick horse is visibly quick all
    // session and a deliberate one visibly deliberate. Without this the
    // whole fleet shares one rhythm however wide the range is.
    expect(logic).toContain('tempoSeed');
    expect(logic).toMatch(/const tempo = /);
  });

  it('a deliberate time-bank burn is a real bank use, not a timeout', () => {
    // Past the turn clock the engine auto-activates the bank (Bible V8 6.2),
    // and the burn is bounded well inside it so a tank can never auto-fold.
    expect(logic).toContain('THINK_TIMEBANK_SENTINEL');
    expect(turns).toContain('THINK_TIMEBANK_SENTINEL');
    expect(turns).toContain('HORSE_MAX_BANK_BURN_MS');
    const m = turns.match(/HORSE_MAX_BANK_BURN_MS\s*=\s*(\d+)/);
    expect(m, 'the bank burn must be bounded').toBeTruthy();
    // The bank grants ~20s per use; stay well under it.
    expect(Number(m![1])).toBeLessThan(15000);
  });

  it('an ordinary decision still lands inside the turn clock', () => {
    expect(turns).toContain('actionTimeMs - 1200');
  });
});

describe('the SAME bug class, everywhere it occurs - nothing is superseded in its own tick', () => {
  const events = read('ServerTableEngineHandEvents.ts');
  const runout = read('ServerTableEngineRunout.ts');
  const num = (src: string, name: string) => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    expect(m, `${name} must be defined`).toBeTruthy();
    return Number(m![1]);
  };

  it('SHOWDOWN gets airtime before the pot ships', () => {
    // completeHandInner() emits SHOWDOWN and WINNERS in the same synchronous
    // call, so without this the reveal, the winner highlight and the pot ship
    // all landed on one frame.
    expect(events).toContain('await this.sleep(this.showdownSettleMs)');
    // Must cover cardShowdownFlip (350ms) + its 120ms second-card stagger.
    expect(num(runout, 'showdownSettleMs')).toBeGreaterThan(470);
  });

  it('only pauses for a REAL showdown (a fold win keeps its pace)', () => {
    /* 2026-08-26: the payload is CAPTURED before the settle hold (the live
       fields are cleared by HAND_COMPLETE during the sleep), so the gate now
       reads the captured copy. Same rule, race-proof source. */
    expect(events).toContain('capturedShowdownResults.length >= 2');
  });

  it('a freshly dealt BOARD is revealed before the next player is on the clock', () => {
    expect(events).toContain('this.lastStreetDealtAtMs = Date.now()');
    // The flop lands (300ms) then fans open (420ms starting ~520ms in) = ~940ms.
    expect(num(runout, 'streetSettleMs')).toBeGreaterThan(940);
  });

  it('the DEAL finishes before the first action of the hand', () => {
    expect(events).toContain('this.lastHandStartAtMs = Date.now()');
    // 12 cards on an 80ms stagger + a 320ms flight = ~1.2s, plus 400ms blinds.
    expect(num(runout, 'handStartSettleMs')).toBeGreaterThan(1200);
  });

  it('every settle re-checks the hand after sleeping', () => {
    expect(events).toContain('controllerAtShowdown');
    expect(events).toContain('controllerAtAction');
  });
});

describe('celebrations are not superseded by the next hand either', () => {
  const runout = read('ServerTableEngineRunout.ts');
  const dealing = read('ServerTableEngineDealing.ts');

  it('the ALL IN banner finishes before the first runout card lands', () => {
    // The client's allInBannerSlam runs 1800ms and fires on the first
    // all_in_equity broadcast, which goes out with this pause. A shorter pause
    // starts dealing the board while "ALL IN" is still slamming in.
    const m = runout.match(/allInFirstPauseMs\s*=\s*(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1800);
  });

  it('a BAD BEAT JACKPOT pauses the table for its whole celebration', () => {
    // The constant moved into the shared hand-completion spec (2026-08-21),
    // where the client's celebration length and the engine's hold are the
    // same number by construction.
    const spec = readFileSync(join(process.cwd(), 'src/config/handCompletionSpec.ts'), 'utf8');
    expect(spec).toContain('BBJ_CELEBRATION_MS');
    expect(Number(spec.match(/BBJ_CELEBRATION_MS:\s*(\d+)/)![1])).toBeGreaterThanOrEqual(9000);
    expect(dealing).toContain('currentHandBBJHit');
  });
});

describe('REGRESSION: a visual settle must never delay a STATE commit', () => {
  const events = read('ServerTableEngineHandEvents.ts');

  it('winner state is assigned BEFORE the showdown settle, not after', () => {
    // handleHandEvent is dispatched fire-and-forget, and completeHandInner()
    // emits WINNERS and HAND_COMPLETE back to back in one synchronous call. If
    // the settle sits before the winner-state commit, the HAND_COMPLETE
    // handler - which reads currentHandWinnerIds for the payload, the payouts,
    // the BBJ evaluation and the 7-2 bounty - overtakes it and runs against
    // unwritten state. The settle is purely visual and MUST come after.
    const assign = events.indexOf('this.currentHandWinnerIds = ');
    const settle = events.indexOf('await this.sleep(this.showdownSettleMs)');
    const potWin = events.indexOf("type: 'pot_win'");
    expect(assign).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(-1);
    expect(potWin).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(assign);
    expect(potWin).toBeGreaterThan(settle);
  });
});

describe('the end of a hand is not rushed either', () => {
  const dealing = read('ServerTableEngineDealing.ts');

  it('an uncontested win still gets time to sweep AND ship the pot', () => {
    // 2026-08-21: the hold is no longer a hand-written constant here. Dan's
    // hand-completion law made it DERIVED from the animation spec both sides
    // share, so an animation change cannot silently truncate the sequence
    // (the old 2600ms literal was already cutting off the 2900ms pot-win
    // float). The pacing guarantee is unchanged; its source moved.
    expect(dealing).toContain('handCompletionHoldMs(');
    expect(dealing).toContain('boardClearMs(');
    const spec = readFileSync(join(process.cwd(), 'src/config/handCompletionSpec.ts'), 'utf8');
    const sweep = Number(spec.match(/BETS_SWEEP_MS:\s*(\d+)/)![1]);
    const push = Number(spec.match(/POT_PUSH_MS:\s*(\d+)/)![1]);
    const muck = Number(spec.match(/MUCK_MS:\s*(\d+)/)![1]);
    // sweep + the pot travelling with its total + the muck.
    expect(sweep + push + muck).toBeGreaterThanOrEqual(2000);
  });

  it('an all-in runout is paced street by street, never dealt in one tick', () => {
    const runout = read('ServerTableEngineRunout.ts');
    expect(runout).toContain('allInStreetPauseMs');
    const m = runout.match(/allInStreetPauseMs\s*=\s*(\d+)/);
    expect(Number(m![1])).toBeGreaterThanOrEqual(1000);
  });
});
