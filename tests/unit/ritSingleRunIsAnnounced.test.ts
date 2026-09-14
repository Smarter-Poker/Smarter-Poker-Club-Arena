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
    expect(RUNOUT).toContain("emitRitSingleRun('no_agreement')");
  });

  it('emits at most one notice per hand', () => {
    // A decline followed by the timeout branch must not toast twice.
    expect(RUNOUT).toContain('ritSingleRunNotifiedHand');
    const fn = RUNOUT.slice(
      RUNOUT.indexOf('protected emitRitSingleRun('),
      RUNOUT.indexOf('protected emitRitSingleRun(') + 700
    );
    expect(fn).toMatch(/if \(this\.ritSingleRunNotifiedHand === this\.handCount\) return;/);
  });

  it('the client turns each reason into its own message', () => {
    const block = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf("if (eventType === 'rit_single_run')"),
      TABLE_PAGE.indexOf("if (eventType === 'rit_single_run')") + 1800
    );
    expect(block).toContain('chooser_chose_one');
    expect(block).toContain('player_declined');
    expect(block).toContain('Not Everyone Agreed In Time');
    // 2026-09-13: one silent seat is named, the way a decliner is.
    expect(block).toContain("reason === 'no_answer' && name");
    expect(block).toContain('Did Not Answer In Time');

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

describe('the expiry names the one seat that held things up (2026-09-13)', () => {
  it('the host forwards a single silent player by id, and the collective line otherwise', () => {
    const fn = RUNOUT.slice(
      RUNOUT.indexOf('protected wireRunItTwiceEvents(): void {'),
      RUNOUT.indexOf('protected wireRunItTwiceEvents(): void {') + 1200
    );
    expect(fn).toContain(
      "if (silent.length === 1) this.emitRitSingleRun('no_answer', silent[0] as string);"
    );
    expect(fn).toContain("else this.emitRitSingleRun('no_agreement');");
    expect(RUNOUT).toContain("| 'no_answer'");
  });
});
