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
import {
  isPreActionHonorable,
  PRE_ACTION_EXEC_GRACE_MS,
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
