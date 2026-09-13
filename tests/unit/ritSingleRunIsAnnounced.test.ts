import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Dan 2026-08-23: "I just tried to run it twice, and it did not run a second
 * board... only ran it the one time and awarded me the pot."
 *
 * The engine was NOT at fault. Read straight out of production, hand #1729271
 * from that evening carries one `rit_board_2:` row in its action log, which the
 * runout only writes when it has dealt a second board — so that hand really did
 * run twice and split the pot, and 281 hands in the preceding 24 hours had a
 * second board.
 *
 * What was missing is the other outcome. A Run It Twice offer ends in ONE board
 * whenever the chooser picks 1, an all-in opponent declines, or nobody answers
 * inside the window. `rit_result` is emitted only when two or more boards are
 * actually dealt, so all three of those paths were SILENT: the hand ran once,
 * the pot shipped, and the player who had just asked to run it twice had
 * nothing to distinguish "someone declined" from "this feature is broken".
 */
const RUNOUT = readFileSync(
  resolve(__dirname, '../../server/src/engine/ServerTableEngineRunout.ts'),
  'utf8'
);
const TABLE_PAGE = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

describe('a Run It Twice offer that ends in one board says so', () => {
  it('announces the chooser picking a single run', () => {
    const block = RUNOUT.slice(
      RUNOUT.indexOf('if (runs === 1) {'),
      RUNOUT.indexOf('if (runs === 1) {') + 900
    );
    expect(block).toContain("emitRitSingleRun('chooser_chose_one'");
  });

  it('announces another player declining', () => {
    const block = RUNOUT.slice(
      RUNOUT.indexOf("} else if (response === 'decline') {"),
      RUNOUT.indexOf("} else if (response === 'decline') {") + 400
    );
    expect(block).toContain("emitRitSingleRun('player_declined'");
  });

  it('announces the offer lapsing with no agreement', () => {
    // The call carries the hand it is about since 2026-09-09 (see below), so
    // this pins the announcement rather than the exact argument list.
    expect(RUNOUT).toContain("emitRitSingleRun('no_agreement'");
  });

  it('emits at most one notice per hand, and only for the hand it is about', () => {
    // A decline followed by the timeout branch must not toast twice.
    expect(RUNOUT).toContain('ritSingleRunNotifiedHand');
    const fn = RUNOUT.slice(
      RUNOUT.indexOf('protected emitRitSingleRun('),
      RUNOUT.indexOf('protected emitRitSingleRun(') + 1600
    );
    /* MOVED 2026-09-09, and STRENGTHENED. The dedupe used to compare against
       `this.handCount` read at emit time. That is right for every synchronous
       caller and wrong for the RIT auto-decline forwarder, which fires from a
       DeadlineScheduler timer: a timeout surfacing after the hand turned over
       stamped the NEXT hand as already-notified and suppressed its own
       legitimate notice. The method takes the hand it is about (defaulting to
       the live one, so nothing else changes) and dedupes on that - plus it now
       refuses outright to announce a hand that is over. */
    expect(fn).toMatch(/handNumber: number = this\.handCount/);
    expect(fn).toMatch(/if \(handNumber !== this\.handCount\) return;/);
    expect(fn).toMatch(/if \(this\.ritSingleRunNotifiedHand === handNumber\) return;/);
  });

  it('the client turns each reason into its own message', () => {
    const block = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf("if (eventType === 'rit_single_run')"),
      TABLE_PAGE.indexOf("if (eventType === 'rit_single_run')") + 1400
    );
    expect(block).toContain('chooser_chose_one');
    expect(block).toContain('player_declined');
    expect(block).toContain('Not Everyone Agreed In Time');

    // House popup rules: Title Case, no em dashes. Scoped to the MESSAGE
    // strings - a first draft scanned the whole slice and failed on an em dash
    // in the neighbouring comment, which is prose and not popup text.
    const messages = [...block.matchAll(/`Running It Once\.[^`]*`|'Running It Once\.[^']*'/g)].map(
      (m) => m[0]
    );
    expect(messages.length).toBeGreaterThanOrEqual(3);
    for (const m of messages) {
      expect(m, m).not.toMatch(/—/);
      expect(m, m).not.toMatch(/\b(a|an|the|in|on|of|to)\b [a-z]/);
    }
  });
});
