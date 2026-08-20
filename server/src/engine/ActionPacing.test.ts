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
    expect(events).toContain('await this.sleep(this.actionSettleMs)');
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

describe('horses act at human speed — never instantly', () => {
  const turns = read('ServerTableEngineTurns.ts');

  it('has a think-time FLOOR, not just a ceiling', () => {
    expect(turns).toContain('HORSE_MIN_THINK_MS');
  });

  it('the floor leaves every action animation time to play', () => {
    const m = turns.match(/HORSE_MIN_THINK_MS\s*=\s*(\d+)/);
    expect(m).toBeTruthy();
    const ms = Number(m![1]);
    // cpSlideIn is 500ms and cardFoldOut is 380ms + 55ms stagger. A floor at
    // or below those clips the animation the action is supposed to show.
    expect(ms).toBeGreaterThan(1000);
  });

  it('the floor is applied as a MAX (a lower decision cannot win)', () => {
    expect(turns).toMatch(/Math\.max\(\s*HORSE_MIN_THINK_MS/);
  });
});

describe('the end of a hand is not rushed either', () => {
  const dealing = read('ServerTableEngineDealing.ts');

  it('an uncontested win still gets time to sweep AND ship the pot', () => {
    const m = dealing.match(/RESULT_DISPLAY_FOLD_MS\s*=\s*(\d+)/);
    expect(m).toBeTruthy();
    // sweep (700) + pot ship (700) + a beat to read the winner.
    expect(Number(m![1])).toBeGreaterThanOrEqual(2000);
  });

  it('an all-in runout is paced street by street, never dealt in one tick', () => {
    const runout = read('ServerTableEngineRunout.ts');
    expect(runout).toContain('allInStreetPauseMs');
    const m = runout.match(/allInStreetPauseMs\s*=\s*(\d+)/);
    expect(Number(m![1])).toBeGreaterThanOrEqual(1000);
  });
});
