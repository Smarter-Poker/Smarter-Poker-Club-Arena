/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TABLE THAT CANNOT DEAL HOLDS NOBODY FOR A BLIND (binding, 2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Found in the closing sweep of the must-move audit, on the live floor. Seven
 * of the 129 open cluster tables were seated and dealing nothing, and they
 * were exactly the seven carrying a seat held for the big blind - every other
 * seated table was fine, so the correlation was 7 of 7 and 0 of 48.
 *
 *   tbl      | seated | waiting | active | oldest hold | hands in 30m
 *   2755c54c |      6 |       5 |      1 |      94 min |            0
 *   1c45cada |      6 |       5 |      1 |      94 min |            0
 *   9e851fff |      6 |       5 |      1 |      94 min |            0
 *   1dc09e13 |      4 |       3 |      1 |      94 min |            0
 *   e670d636 |      4 |       3 |      1 |      34 min |            0
 *   5fceabfd |      2 |       1 |      1 |       7 min |            0
 *   140532e7 |      2 |       1 |      1 |       6 min |            0
 *
 * The cycle closes on itself: `activePlayers` in the dealing loop excludes a
 * waiter, so the deal gate counts one player and sleeps; sleeping is what
 * stops the big blind moving; the big blind not moving is what stops the
 * natural release at the top of the loop. The only other exit is the player
 * tapping POST /post-bb, and every seat on those tables was a horse. Six
 * funded seats sat at a dead table for an hour and a half.
 *
 * WHAT THIS LAW PINS
 *
 *   1. The idle branch calls the release. If the call is deleted the deadlock
 *      returns, silently, and the only symptom is a table that looks seated.
 *   2. It fires ONLY when the release actually starts the game. A table that
 *      would still be short with everyone let in keeps its holds - they cost
 *      nothing there and they are real holds for when it fills.
 *   3. The release writes the same thing the natural big-blind release writes
 *      (`hold: null, agreed: false`), so a standing post agreement cannot
 *      survive to bill a second blind.
 *   4. It never seeds `dealtInUserIds`. A released seat has not been dealt a
 *      hand here, so "a new player never gets the button" survives.
 *   5. It is cash-only, like every other entry hold.
 *
 * WHAT IT DOES NOT TOUCH. Dan 2026-08-26, binding: "Every single player needs
 * to either wait for the BB or post when entering a cash game... no free
 * hands or coming in behind the blinds." That rule is about a RUNNING table
 * and `EntryPostingAndButton.test.ts` still owns it. This release cannot run
 * at a running table: the gate above it has already decided the table cannot
 * deal, so no blind has been posted for anyone to come in behind, and every
 * released seat enters on the same hand with the blinds posted by position -
 * the same deal six players opening a brand-new table already get.
 *
 * Source-text guards in the house style (see afkSitOutGuard.test.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
const BASE = read('./ServerTableEngineBase.ts');
const DEALING = read('./ServerTableEngineDealing.ts');

/** The method body, sliced from its signature to the next member. */
const RELEASE = (() => {
  const start = BASE.indexOf('protected releaseWaitersNoBlindCanReach(): number {');
  expect(start, 'releaseWaitersNoBlindCanReach is gone from the base engine').toBeGreaterThan(-1);
  const end = BASE.indexOf('protected persistEntryHold(', start);
  expect(end, 'the slice anchor moved; re-anchor this law rather than widening it').toBeGreaterThan(
    start
  );
  return BASE.slice(start, end);
})();

describe('a table that cannot deal holds nobody for a blind', () => {
  it('the idle branch calls the release, and calls it before it settles down to sleep', () => {
    const idle = DEALING.slice(
      DEALING.indexOf("this.setLoopPhase('idle_not_enough_players');"),
      DEALING.indexOf('SPIN REVEAL HOLD')
    );
    expect(idle, 'the idle branch no longer releases a waiter it has just stranded').toContain(
      'this.releaseWaitersNoBlindCanReach();'
    );
    // Before the sleep, or the table naps for another three seconds holding
    // seats it has already decided it cannot deal to.
    expect(idle.indexOf('this.releaseWaitersNoBlindCanReach();')).toBeLessThan(
      idle.indexOf('await this.sleep(')
    );
  });

  it('it fires only when letting everyone in actually starts the game', () => {
    // The threshold is read from minPlayersToDeal - the same figure the deal
    // gate uses - and a table that would still be short returns without
    // touching a single hold.
    expect(RELEASE).toMatch(/dealableIgnoringTheWait\.length < this\.minPlayersToDeal\(\)/);
    expect(RELEASE).toMatch(/return 0;/);
  });

  it('the dealable count is the deal gate predicate minus the one exclusion under test', () => {
    expect(RELEASE).toMatch(/p\.stack > 0/);
    expect(RELEASE).toMatch(/!this\.disconnectEngine\.isSittingOut\(this\.tableId, p\.user_id\)/);
    expect(RELEASE).toMatch(/!this\.isHeldForSwap\(p\.user_id\)/);
    // and it must NOT re-apply the waiting exclusion, which is the whole point
    const predicate = RELEASE.slice(
      RELEASE.indexOf('dealableIgnoringTheWait'),
      RELEASE.indexOf('if (dealableIgnoringTheWait.length')
    );
    expect(predicate, 'the count excludes the very waiters it is deciding about').not.toMatch(
      /waitingForBB\.has/
    );
  });

  it('the release writes exactly what the natural big-blind release writes', () => {
    expect(RELEASE).toMatch(/this\.waitingForBB\.delete\(p\.user_id\)/);
    expect(RELEASE).toMatch(/this\.postBBWhenClear\.delete\(p\.user_id\)/);
    expect(RELEASE).toMatch(
      /this\.persistEntryHold\(p\.user_id, \{ hold: null, agreed: false \}\)/
    );
  });

  it('a released seat is never seeded as a veteran, so it cannot take the button', () => {
    expect(RELEASE, 'the released seat was handed veteran status with its entry').not.toMatch(
      /dealtInUserIds/
    );
  });

  it('it is cash only', () => {
    expect(RELEASE).toMatch(/if \(this\.isTournamentTable\(\)\) return 0;/);
  });

  it('it says so in the log, because a silent release is how this was missed', () => {
    expect(RELEASE).toMatch(/console\.log\(/);
    expect(RELEASE).toMatch(/big blind that could not arrive/);
  });
});
