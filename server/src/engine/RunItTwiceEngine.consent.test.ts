/**
 * RUN IT TWICE — unanimous consent (FIX-A8, 2026-07-19).
 *
 * Bible V8 §4.20: running the board twice requires the agreement of EVERY
 * all-in player, not just the chooser plus one opponent. These assert that a
 * 3-way all-in does not proceed until all three consent, that non-participants
 * cannot consent, and that the heads-up (2-player) path is unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import type { DeadlineScheduler } from './DeadlineScheduler.js';

// Inert scheduler so tests don't arm real timers / leave open handles.
const stubScheduler = {
  start() {},
  schedule() {},
  cancel() {},
} as unknown as DeadlineScheduler;

function mkEngine() {
  const engine = new RunItTwiceEngine(undefined, stubScheduler);
  engine.configure('t1', { enabled: true, autoDeclineTimeout: 10, maxRuns: 2 });
  return engine;
}

describe('RIT unanimous consent', () => {
  let engine: RunItTwiceEngine;
  beforeEach(() => {
    engine = mkEngine();
  });

  it('3-way all-in: does NOT proceed until every all-in player accepts', () => {
    engine.offer('t1', 't1:1', 'A', ['A', 'B', 'C'], 300); // A = chooser (pre-accepted)
    engine.chooserDecides('t1', 'A', 2);
    expect(engine.isActive('t1')).toBe(false); // status 'offered', not yet accepted

    expect(engine.accept('t1', 'B')).toBe(false); // one opponent only — not enough
    expect(engine.isActive('t1')).toBe(false);
    expect(engine.getState('t1')?.status).toBe('offered');

    expect(engine.accept('t1', 'C')).toBe(true); // now unanimous
    expect(engine.isActive('t1')).toBe(true);
    expect(engine.getState('t1')?.status).toBe('accepted');
  });

  it('a non-participant cannot consent', () => {
    engine.offer('t1', 't1:1', 'A', ['A', 'B', 'C'], 300);
    engine.chooserDecides('t1', 'A', 2);
    expect(engine.accept('t1', 'Z')).toBe(false);
    expect(engine.accept('t1', 'B')).toBe(false);
    expect(engine.accept('t1', 'C')).toBe(true);
  });

  it('any all-in player declining kills RIT for everyone', () => {
    engine.offer('t1', 't1:1', 'A', ['A', 'B', 'C'], 300);
    expect(engine.accept('t1', 'B')).toBe(false);
    engine.decline('t1', 'C');
    expect(engine.getState('t1')?.status).toBe('declined');
    expect(engine.isActive('t1')).toBe(false);
  });

  it('heads-up (2-player) path is unchanged: the single opponent accepting is enough', () => {
    engine.offer('t1', 't1:1', 'A', ['A', 'B'], 200);
    engine.chooserDecides('t1', 'A', 2);
    expect(engine.accept('t1', 'B')).toBe(true);
    expect(engine.isActive('t1')).toBe(true);
    expect(engine.getState('t1')?.status).toBe('accepted');
  });

  // ── CONSENT-RACE FIX 2026-08-18 ──────────────────────────────────────────
  it('early accepts cannot complete the offer before the chooser picks the run count', () => {
    const eng = mkEngine3(); // maxRuns 3 (production config)
    eng.offer('t1', 't1:1', 'A', ['A', 'B', 'C'], 300);
    expect(eng.accept('t1', 'B')).toBe(false);
    expect(eng.accept('t1', 'C')).toBe(false); // all responders in, chooser silent
    expect(eng.getState('t1')?.status).toBe('offered'); // NOT accepted at default runs
    eng.chooserDecides('t1', 'A', 2); // chooser's pick is the completing action
    expect(eng.getState('t1')?.status).toBe('accepted');
    expect(eng.getChosenRuns('t1')).toBe(2); // the PICKED count, not the default (3)
  });

  it('a chooser pick above the table max is clamped, not honored', () => {
    engine.offer('t1', 't1:1', 'A', ['A', 'B'], 200); // maxRuns 2
    engine.chooserDecides('t1', 'A', 3);
    // The clamp itself, read off the offer. This assertion used to go through
    // getChosenRuns(), which answered a different question as of 2026-08-27:
    // it is now "how many boards do we have CONSENT to run", and B has not
    // accepted yet, so it is 1 here by design (see the next assertion). The
    // clamp is a property of the chooser's pick and is asserted where the pick
    // lives.
    expect(engine.getState('t1')?.chosenRuns).toBe(2);
    // And the consent gate: a live, unaccepted offer runs ONE board.
    expect(engine.getChosenRuns('t1')).toBe(1);
    // Once the last player consents, the clamped pick is what runs.
    expect(engine.accept('t1', 'B')).toBe(true);
    expect(engine.getChosenRuns('t1')).toBe(2);
  });

  it('a late chooser pick cannot mutate a settled (declined) offer', () => {
    const eng = mkEngine3();
    eng.offer('t1', 't1:1', 'A', ['A', 'B'], 200);
    eng.decline('t1', 'B');
    eng.chooserDecides('t1', 'A', 3);
    expect(eng.getState('t1')?.status).toBe('declined');
  });

  it('chooser picking 1 run declines for everyone regardless of accepts', () => {
    engine.offer('t1', 't1:1', 'A', ['A', 'B'], 200);
    expect(engine.accept('t1', 'B')).toBe(false);
    engine.chooserDecides('t1', 'A', 1);
    expect(engine.getState('t1')?.status).toBe('declined');
    expect(engine.isActive('t1')).toBe(false);
  });
});

function mkEngine3() {
  const engine = new RunItTwiceEngine(undefined, stubScheduler);
  engine.configure('t1', { enabled: true, autoDeclineTimeout: 10, maxRuns: 3 });
  return engine;
}

/**
 * THE WINDOW CLOSES, AND THE RECORD SAYS WHO WAS STILL SILENT (2026-09-13).
 *
 * The expiry used to call decline(tableId, primaryOfferedTo, 'timeout'), which
 * stamped the FIRST responder in the offer list as `declinedBy` on every
 * timeout - whoever had actually answered. These drive the DeadlineScheduler
 * callback the offer arms and read the event it emits.
 */
describe('RIT offer expiry names the players who had not answered', () => {
  function armed() {
    let fire: (() => void) | null = null;
    const scheduler = {
      start() {},
      schedule(entry: { callback: () => void }) {
        fire = entry.callback;
      },
      cancel() {},
    } as unknown as DeadlineScheduler;
    const events: Array<Record<string, unknown>> = [];
    const engine = new RunItTwiceEngine(
      (e) => events.push(e as unknown as Record<string, unknown>),
      scheduler
    );
    engine.configure('t1', { enabled: true, autoDeclineTimeout: 25, maxRuns: 3 });
    return { engine, events, fire: () => fire!() };
  }

  it('B accepted, C never answered: the expiry blames C, not B', () => {
    const { engine, events, fire } = armed();
    engine.offer('t1', 't1:1', 'A', ['A', 'B', 'C'], 300);
    engine.chooserDecides('t1', 'A', 2);
    engine.accept('t1', 'B');
    fire();
    const declined = events.find((e) => e.type === 'RIT_DECLINED')!;
    expect(declined).toBeTruthy();
    expect(declined.reason).toBe('timeout');
    expect(declined.declinedBy).toBeNull();
    expect(declined.unanswered).toEqual(['C']);
    expect(engine.getState('t1')?.status).toBe('declined');
    expect(engine.getChosenRuns('t1')).toBe(1);
  });

  it('a chooser who never picked a count is one of the silent', () => {
    const { engine, events, fire } = armed();
    engine.offer('t1', 't1:1', 'A', ['A', 'B'], 300);
    engine.accept('t1', 'B');
    fire();
    const declined = events.find((e) => e.type === 'RIT_DECLINED')!;
    expect(declined.unanswered).toEqual(['A']);
  });

  it('nobody answered: every seat is listed', () => {
    const { engine, events, fire } = armed();
    engine.offer('t1', 't1:1', 'A', ['A', 'B', 'C'], 300);
    fire();
    const declined = events.find((e) => e.type === 'RIT_DECLINED')!;
    expect(declined.unanswered).toEqual(['A', 'B', 'C']);
  });

  it('a late tick after consent completed does nothing', () => {
    const { engine, events, fire } = armed();
    engine.offer('t1', 't1:1', 'A', ['A', 'B'], 300);
    engine.chooserDecides('t1', 'A', 2);
    engine.accept('t1', 'B');
    expect(engine.getState('t1')?.status).toBe('accepted');
    fire();
    expect(events.some((e) => e.type === 'RIT_DECLINED')).toBe(false);
    expect(engine.getState('t1')?.status).toBe('accepted');
  });
});
