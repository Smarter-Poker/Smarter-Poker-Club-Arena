/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ENTERING A CASH GAME: WAIT FOR THE BIG BLIND OR POST IT
 *  AND A NEW PLAYER NEVER GETS THE BUTTON
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26, binding, correcting his own instruction from the night
 * before, verbatim:
 *
 *   "i also made a mistake the other night, when I said that a player doesn't
 *    have to post when they are new to a cash game table... Every single player
 *    needs to either wait for the BB or post when entering a cash game... no
 *    free hands or coming in behind the blinds."
 *
 * THE RULE THIS REPLACES, and why the file reads like a reversal
 *
 * On 2026-08-25 Dan said the opposite - "you don't have to POST when you first
 * come to a table... coming in behind the button, those hands should be DEALT
 * TO THEM FOR FREE" - and the dealing loop was changed to release every waiter
 * on the next tick at no charge. That lasted a day. The free release is now
 * gone and `waitingForBB` means what its name says again: a player stays in it
 * until the big blind reaches their seat, or until they call POST /post-bb and
 * pay a live big blind to come in immediately.
 *
 * The history is kept in the comments on purpose. A rule that flipped once can
 * flip back by accident, and "no free hands" is worth real money at a raked
 * table.
 *
 * WHAT DID NOT CHANGE
 *
 *   - MISSED BLINDS ARE A DIFFERENT DEBT. A player returning from sit-out goes
 *     through returningFromSitout and owes a dead small blind plus a live big
 *     blind. A new joiner never owed those; they simply have not entered yet.
 *   - "CASH GAME PLAYERS CAN NEVER BE DEALT INTO THE SMALL BLIND" and "NEW
 *     PLAYERS NEVER GET THE BUTTON WHEN SITTING DOWN" both still hold, and
 *     posting cannot buy past either. Posting skips the wait, not a house rule.
 *   - The button is still chosen off players who have actually been dealt in,
 *     so a player's first hand can never be on the button.
 *
 * These are source-text guards in the house style (see afkSitOutGuard.test.ts).
 * They pin the SHAPE of the rules, which is what regressed, rather than
 * re-simulating the dealing loop.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  sliceBlockAfter,
  sliceEnclosingBlock,
  sliceMethod,
  sliceStatement,
} from '../testHelpers/sourceWindow.js';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const DEALING = strip(read('src/engine/ServerTableEngineDealing.ts'));
const BASE = strip(read('src/engine/ServerTableEngineBase.ts'));

describe('a cash entrant either waits for the big blind or posts it', () => {
  /**
   * Dan 2026-08-26, binding, correcting his own instruction of the night
   * before:
   *
   *   "i also made a mistake the other night, when I said that a player
   *    doesn't have to post when they are new to a cash game table... Every
   *    single player needs to either wait for the BB or post when entering a
   *    cash game... no free hands or coming in behind the blinds."
   *
   * This block used to be called "coming in behind the button costs nothing"
   * and pinned the opposite rule. It is rewritten rather than deleted so the
   * reversal is legible: the free-entry release existed for one day, and these
   * assertions are what stop it coming back by accident.
   */

  it('the dealing loop no longer releases a waiter for free', () => {
    // This is the whole reversal. The loop used to walk waitingForBB and
    // delete every entry on the tick, logging "free entry for". A waiter is
    // now released in exactly two places, neither of them here.
    expect(DEALING).not.toMatch(/free entry for/);
    expect(DEALING).not.toMatch(/no post owed/);
  });

  it('the natural big blind is still what releases a waiter on the wait path', () => {
    // The "wait" half. When the BB reaches their seat they come out of the set
    // and post it because it is genuinely their blind.
    expect(DEALING).toMatch(/bbSeatIndex\s*=\s*this\.getBBSeatIndex\(\)/);
    expect(DEALING).toMatch(/p\.seat_number === bbSeatIndex/);
  });

  it('the only other way out of the set is posting, and it bills a live BB', () => {
    const seating = strip(read('src/engine/ServerTableEngineSeating.ts'));
    expect(seating).toMatch(/postingBBToEnter\.add/);
    // The dealing loop must never write to the billing set itself.
    expect((DEALING.match(/postingBBToEnter\.add/g) || []).length).toBe(0);
  });

  it('posting is offered in the product, not just on the server', () => {
    // A rule that says "wait or post" with no way to post is a rule that says
    // "wait". The overlay calls it.
    const tablePage = strip(read('../src/pages/TablePage.tsx'));
    expect(tablePage).toMatch(/serverPostBBToEnter\(/);
  });

  it('missed blinds are a different debt and still owe the dead small blind', () => {
    // A player returning from sit-out MISSED blinds; a new joiner never owed
    // them. returningFromSitout keeps billing dead SB + live BB.
    expect(DEALING).toMatch(/deadBlinds:/);
    expect(DEALING).toMatch(/returningFromSitout\.has\(p\.user_id\)/);
  });

  it('a table setting cannot switch off the wait, or the small-blind rule', () => {
    // registerWaitForBB used to be gated on tableInfo.wait_for_big_blind, so a
    // host who turned it off skipped registration entirely - which skipped the
    // wait AND the hold-out enforcing "CASH GAME PLAYERS CAN NEVER BE DEALT
    // INTO THE SMALL BLIND".
    const seating = strip(read('src/engine/ServerTableEngineSeating.ts'));
    const at = seating.indexOf('public registerWaitForBB');
    expect(at).toBeGreaterThan(-1);
    const body = sliceMethod(seating, 'public registerWaitForBB');
    expect(body).not.toMatch(/wait_for_big_blind/);
    expect(body).toMatch(/if \(!this\.isTournamentTable\(\)\)/);
  });

  it('posting cannot buy its way into the small blind or the button', () => {
    // Posting skips the WAIT. It does not skip a house rule.
    const seating = strip(read('src/engine/ServerTableEngineSeating.ts'));
    const at = seating.indexOf('public postBBToEnter');
    expect(at).toBeGreaterThan(-1);
    const body = sliceMethod(seating, 'public postBBToEnter');
    const guard = body.indexOf('getSBSeatIndex');
    const release = body.indexOf('this.waitingForBB.delete(userId)');
    expect(guard, 'no small-blind guard on postBBToEnter').toBeGreaterThan(-1);
    // The refusal must come BEFORE the player is released and billed.
    expect(guard).toBeLessThan(release);
    expect(body).toMatch(/getButtonSeatIndex/);
    expect(body).toMatch(/seat\.seat_number === buttonSeatIndex/);
  });

  it('none of this touches tournaments', () => {
    const seating = strip(read('src/engine/ServerTableEngineSeating.ts'));
    const at = seating.indexOf('public registerWaitForBB');
    expect(sliceMethod(seating, 'public registerWaitForBB')).toMatch(/isTournamentTable\(\)/);
  });

  it('a post tapped before registration is QUEUED, not refused (race fix 2026-08-27)', () => {
    // Dan: "the post to get dealt in feature in cash games isn't working."
    // A mid-hand joiner is not registered until the dealing loop's next pass,
    // so their tap used to die on "Player is not waiting for BB". The intent
    // is queued (cash-only, unknown joiners only) and the loop replays it
    // through postBBToEnter AFTER the natural-BB release, so a waiter whose
    // seat just became the big blind can never be billed twice.
    const seating = strip(read('src/engine/ServerTableEngineSeating.ts'));
    const at = seating.indexOf('public postBBToEnter');
    expect(sliceMethod(seating, 'public postBBToEnter')).toMatch(/queuePostToEnter/);
    const helper = seating.indexOf('protected queuePostToEnter');
    expect(helper).toBeGreaterThan(-1);
    const helperBody = sliceMethod(seating, 'protected queuePostToEnter');
    expect(helperBody).toMatch(/isTournamentTable\(\)/);
    expect(helperBody).toMatch(/knownPlayerIds/);
    expect(helperBody).toMatch(/pendingPostToEnter\.add/);

    const dealing = strip(read('src/engine/ServerTableEngineDealing.ts'));
    const release = dealing.indexOf('p.seat_number === bbSeatIndex');
    const replay = dealing.indexOf('pendingPostToEnter.size > 0');
    expect(release).toBeGreaterThan(-1);
    expect(replay, 'the loop must replay queued posts').toBeGreaterThan(-1);
    // Replay comes AFTER the natural-BB release (double-charge guard).
    expect(replay).toBeGreaterThan(release);
    // And it goes through the guarded public method, never the sets directly.
    const replayBody = sliceEnclosingBlock(dealing, 'pendingPostToEnter.size > 0');
    expect(replayBody).toMatch(/waitingForBB\.has/);
    expect(replayBody).toMatch(/this\.postBBToEnter\(/);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * AGREEING TO POST IS ANSWERED ONCE (Dan 2026-08-29, binding)
   *
   *   "in cash games when you click POST BB but you are IN BETWEEN THE
   *    BLINDS you get this pop up... that shouldn't happen because you
   *    already agreed to post bb, it should be a pop up that says, 'You Are
   *    In Between The Blinds, And Will Be Dealt In When The Button Passes.'
   *    and auto post the blind then. it currently makes you hit the button
   *    again, or it simply won't deal you in at all."
   *
   * The positional refusal was correct and stays. What it did to the PLAYER
   * was the bug: the answer was thrown away, TablePage re-rendered the same
   * prompt off `waitingForBBUserIds`, and tapping again from the same seat
   * was refused again — so the only route through was to keep tapping until
   * the button happened to move.
   *
   * These pin the repair without weakening either house rule. The seat check
   * still runs on every replay, so nothing here posts from the small blind or
   * the button; the agreement only stops the WAIT from costing the answer.
   * ═══════════════════════════════════════════════════════════════════════
   */
  it('a positional hold-out KEEPS the answer instead of discarding it', () => {
    const seating = strip(read('src/engine/ServerTableEngineSeating.ts'));
    const body = sliceMethod(seating, 'public postBBToEnter');
    // The refusal branch banks the agreement...
    const guard = body.indexOf('seat.seat_number === buttonSeatIndex');
    const held = body.indexOf('this.postBBWhenClear.add(userId)');
    expect(guard, 'the positional guard is gone').toBeGreaterThan(-1);
    expect(held, 'a positional hold-out no longer records the agreement').toBeGreaterThan(-1);
    expect(held).toBeGreaterThan(guard);
    // ...and reports it as HELD, not as a failure, so the client can tell the
    // two apart and stop asking.
    expect(body).toMatch(/deferred: true/);
    expect(body).toMatch(/You Are In Between The Blinds/);
  });

  it('the held agreement never buys past the small blind or the button', () => {
    // The whole point: this is a way past the WAIT only. The replay re-enters
    // the same guarded method, so the seat is re-checked on every single pass
    // rather than being decided once at the moment of the tap.
    const seating = strip(read('src/engine/ServerTableEngineSeating.ts'));
    const body = sliceMethod(seating, 'public postBBToEnter');
    const guard = body.indexOf('getSBSeatIndex');
    const release = body.indexOf('this.waitingForBB.delete(userId)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(release);

    const dealing = strip(read('src/engine/ServerTableEngineDealing.ts'));
    const replay = sliceBlockAfter(dealing, 'if (this.postBBWhenClear.size > 0) {');
    expect(replay).toMatch(/this\.postBBToEnter\(/);
    expect(replay).not.toMatch(/waitingForBB\.delete/);
    expect(replay).not.toMatch(/postingBBToEnter\.add/);
  });

  it('the loop replays the agreement AFTER the natural-BB release', () => {
    // Same double-charge guard as the queued-post replay above: a waiter whose
    // seat has just become the big blind is released first and posts it as
    // their own blind, so the agreement must be dropped rather than billed.
    const dealing = strip(read('src/engine/ServerTableEngineDealing.ts'));
    const release = dealing.indexOf('p.seat_number === bbSeatIndex');
    const replay = dealing.indexOf('postBBWhenClear.size > 0');
    expect(release).toBeGreaterThan(-1);
    expect(replay, 'the loop must replay held agreements').toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(release);
  });

  it('membership is not consumed on the attempt, and cannot outlive the seat', () => {
    // Consuming it on the first pass would throw the answer away exactly as
    // the old refusal did. It is retried instead, and ended on precisely
    // three outcomes: posted, released, or gone from the table.
    const dealing = strip(read('src/engine/ServerTableEngineDealing.ts'));
    const replay = sliceBlockAfter(dealing, 'if (this.postBBWhenClear.size > 0) {');
    expect(replay).toMatch(/seatedPlayers\.some/);
    expect(replay).toMatch(/!this\.waitingForBB\.has\(userId\)/);
    expect(replay).toMatch(/postBBWhenClear\.delete/);
    // And the leaver sweep prunes it beside the other per-table sets.
    expect(dealing).toMatch(/for \(const id of this\.postBBWhenClear\)/);
  });

  it('the engine publishes the agreement so the client stops asking', () => {
    // Without this the overlay returns on the very next snapshot and after
    // every reload, which IS the reported bug. The optimistic client flag only
    // covers the poll in between; this is the durable answer.
    const engine = strip(read('src/engine/ServerTableEngine.ts'));
    expect(engine).toMatch(/post_bb_deferred_user_ids: Array\.from\(this\.postBBWhenClear\)/);
  });
});

describe('a new player never receives the button', () => {
  it('button eligibility is tracked, and only earned by being dealt a hand', () => {
    expect(BASE).toMatch(/dealtInUserIds/);
    expect(DEALING).toMatch(/this\.dealtInUserIds\.add\(p\.user_id\)/);
  });

  it('eligibility is recorded AFTER the button is chosen, not before', () => {
    // Recording first would let a first-time player qualify for the very
    // button this rule exists to keep away from them.
    //
    // Scoped to the ROTATION deliberately. There is a second, legitimate write
    // to dealtInUserIds in the dealing loop's first-iteration block, which
    // seeds everyone already seated when the engine booted as a veteran (they
    // were playing before the restart). That one is earlier in the file, so an
    // unscoped indexOf finds it and reads the order backwards.
    const chosen = DEALING.indexOf('this.lastButtonSeat = dealerSeat');
    expect(chosen, 'button assignment not found').toBeGreaterThan(-1);
    const recorded = DEALING.indexOf('this.dealtInUserIds.add(p.user_id)', chosen);
    expect(recorded, 'eligibility is not recorded after the rotation').toBeGreaterThan(-1);
    expect(recorded).toBeGreaterThan(chosen);
  });

  it('the boot seeding is a SEPARATE site and only runs on the first iteration', () => {
    // Restart fidelity: without it, buttonEligible() falls back to the whole
    // roster after every deploy and the rule is unenforceable for an orbit.
    const at = DEALING.indexOf('if (this.dealingLoopFirstIteration)');
    expect(at).toBeGreaterThan(-1);
    expect(sliceBlockAfter(DEALING, 'if (this.dealingLoopFirstIteration)')).toMatch(
      /this\.dealtInUserIds\.add\(p\.user_id\)/
    );
  });

  it('the rotation itself walks the eligible roster, not the raw deal roster', () => {
    const at = DEALING.indexOf('const buttonRoster');
    expect(at, 'buttonRoster not found').toBeGreaterThan(-1);
    const block = sliceEnclosingBlock(DEALING, 'const buttonRoster');
    expect(block).toMatch(/this\.buttonEligible\(players\)/);
    expect(block).toMatch(/getNextSeat\(prevButtonSeat,\s*buttonRoster\)/);
  });

  it('a table whose players have ALL never played still gets a button', () => {
    // The fallback that makes this safe on a table's first ever hand. Without
    // it buttonEligible returns [] and the rotation has nothing to choose.
    const at = BASE.indexOf('protected buttonEligible');
    expect(at, 'buttonEligible not found').toBeGreaterThan(-1);
    expect(sliceMethod(BASE, 'protected buttonEligible')).toMatch(
      /veterans\.length > 0 \? veterans : roster/
    );
  });

  it('taking the seat the button is about to reach cannot hand it to a new player', () => {
    // This used to be a positional hold-out inside the dealing loop's release
    // block, and that block is gone: since 2026-08-26 a cash entrant waits for
    // the big blind or posts, so a new joiner is held out by DEFAULT and never
    // reaches a deal to be given the button in the first place.
    //
    // The rule is now enforced by eligibility rather than by seat number, which
    // is strictly stronger - a waiter is not in activePlayers, so is never
    // dealt, so never enters dealtInUserIds, so buttonEligible() can never
    // return them however they got there.
    expect(BASE).toMatch(/dealtInUserIds/);
    expect(DEALING).toMatch(/buttonEligible/);

    // And on the one path that DOES skip the wait - posting - the seat check
    // survives, because posting must not buy past the rule either.
    const seating = strip(read('src/engine/ServerTableEngineSeating.ts'));
    const at = seating.indexOf('public postBBToEnter');
    const body = sliceMethod(seating, 'public postBBToEnter');
    expect(body).toMatch(/getButtonSeatIndex/);
    expect(body).toMatch(/seat\.seat_number === buttonSeatIndex/);
  });

  it('every predictor of the next button shares one definition', () => {
    // Separate walks could disagree about the button, which would bill the wrong
    // seat — the same class of bug the shared sbSeat/bbSeat computation was
    // introduced to kill. Counted as "at least", not exactly: a future caller
    // that correctly adopts the shared helper must not fail this test.
    expect((BASE.match(/this\.predictButtonSeat\(/g) || []).length).toBeGreaterThanOrEqual(3);
    // The horse auto-cashout predicts the next big blind to decide when a horse
    // stands up. It was a FOURTH independent getNextSeat walk over the raw
    // roster, so once new players stopped being button-eligible it could name a
    // different button than the deal used, and horses left on the wrong hand.
    const settlement = strip(read('src/engine/ServerTableEngineSettlement.ts'));
    expect(settlement).toMatch(/nextButtonSeat = this\.predictButtonSeat\(players\)/);
  });

  it('button eligibility is a CASH rule and never touches tournaments', () => {
    // In a tournament nobody sits down: the seating sweep places late
    // registrants and TableBalancer moves players between tables deliberately,
    // positioning them relative to the big blind. Filtering those players out of
    // the rotation would silently override that placement, and a freshly
    // balanced table is mostly players this set has never seen.
    const at = BASE.indexOf('protected buttonEligible');
    expect(at).toBeGreaterThan(-1);
    expect(sliceMethod(BASE, 'protected buttonEligible')).toMatch(
      /if \(this\.isTournamentTable\(\)\) return roster;/
    );
  });

  it('the button always moves, so nobody posts the same blind twice', () => {
    // getNextSeat over a ONE-seat roster returns that seat from both branches,
    // so a single eligible player already on the button kept it, and the same
    // two players posted the small and big blind two hands running.
    const at = DEALING.indexOf('dealerSeat === prevButtonSeat');
    expect(at, 'no guard against a stationary button').toBeGreaterThan(-1);
    const block = DEALING.slice(at - 200, at + 300);
    // Heads-up is deliberately exempt: with two players the button IS the small
    // blind, so forcing it across would put the newcomer in the small blind, the
    // hold-out would refuse them, and the table would never deal again.
    expect(block).toMatch(/players\.length > 2/);
    expect(block).toMatch(/getNextSeat\(prevButtonSeat, players\)/);
  });

  it('leaving the table forfeits button eligibility', () => {
    // Keeps the set bounded by the table rather than by process lifetime, and
    // makes a returning player a new joiner again, consistent with knownPlayerIds.
    const at = DEALING.indexOf('for (const id of this.dealtInUserIds)');
    expect(at, 'dealtInUserIds pruning not found').toBeGreaterThan(-1);
    expect(sliceBlockAfter(DEALING, 'for (const id of this.dealtInUserIds)')).toMatch(
      /currentIds\.has\(id\)/
    );
  });
});
