/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SITTING DOWN IS FREE, AND A NEW PLAYER NEVER GETS THE BUTTON
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, from live play, verbatim:
 *
 *   "In cash games you don't have to POST when you first come to a table, you
 *    only have to post if you are in the BB. If a player is coming in behind
 *    the button, those hands should be DEALT TO THEM FOR FREE without posting.
 *    They only need to post if they were sitting out and missed blinds."
 *
 *   "New players never get the button when sitting down — it skips over them
 *    and moves to the correct person. Even if they take the seat of a person
 *    who would have been the button, they must wait one hand before being
 *    dealt in."
 *
 * WHAT WAS ACTUALLY HAPPENING
 *
 * Every new joiner was force-converted into `postingBBToEnter` on the next
 * dealing-loop tick, which bills a live big blind through the bbOnlyPosts path.
 * The only positional exemption was the small blind. So a player who sat down
 * in the cutoff — behind the button, owing nothing, with their blinds still
 * ahead of them — paid a full big blind for the privilege.
 *
 * And the button was chosen off the raw deal roster with no notion of who had
 * played before, so a player's very first hand at a table could be on the
 * button: they would post nothing, act last, and then be gone before the
 * blinds ever reached them.
 *
 * These are source-text guards in the house style (see afkSitOutGuard.test.ts).
 * They pin the SHAPE of the rules, which is what regressed, rather than
 * re-simulating the dealing loop.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const DEALING = strip(read('src/engine/ServerTableEngineDealing.ts'));
const BASE = strip(read('src/engine/ServerTableEngineBase.ts'));

describe('coming in behind the button costs nothing', () => {
  it('a released new joiner is NOT pushed into postingBBToEnter', () => {
    // The whole bug in one line. `postingBBToEnter` is the set that bills a
    // live BB via bbOnlyPosts. The wait-for-BB release block must never add to
    // it — the only remaining writer is the explicit opt-in API below.
    const at = DEALING.indexOf('this.waitingForBB.delete(userId)');
    expect(at, 'wait-for-BB release block not found').toBeGreaterThan(-1);
    const releaseBlock = DEALING.slice(at, at + 400);
    expect(releaseBlock).not.toMatch(/postingBBToEnter\.add/);
  });

  it('the only writer left to postingBBToEnter is the explicit POST /post-bb opt-in', () => {
    const seating = strip(read('src/engine/ServerTableEngineSeating.ts'));
    expect(seating).toMatch(/postingBBToEnter\.add/);
    expect((DEALING.match(/postingBBToEnter\.add/g) || []).length).toBe(0);
  });

  it('missed blinds are still owed — returningFromSitout is untouched', () => {
    // Dan carved this out explicitly: "they only need to post if they were
    // sitting out and missed blinds." That path must keep billing dead SB + BB.
    expect(DEALING).toMatch(/deadBlinds:/);
    expect(DEALING).toMatch(/returningFromSitout\.has\(p\.user_id\)/);
  });

  it('a new joiner is still never dealt into the small blind', () => {
    // Pre-existing binding rule, and the free-entry change must not erase it.
    expect(DEALING).toMatch(
      /sbSeatIndex\s*=\s*this\.isTournamentTable\(\)\s*\?\s*-1\s*:\s*this\.getSBSeatIndex\(\)/
    );
    expect(DEALING).toMatch(/seatedWaiter\.seat_number === sbSeatIndex/);
  });

  it('a table setting cannot switch off the small-blind rule', () => {
    // registerWaitForBB used to be gated on tableInfo.wait_for_big_blind, and
    // that set is what the SB and button hold-outs read. So a host who turned
    // the setting off skipped registration, skipped the hold-out, and had brand
    // new players dealt straight into the small blind on their first hand.
    // The set no longer gates a WAIT — entry is free and released next tick —
    // it only gates the two positional hold-outs, one of which is a house rule.
    const seating = strip(read('src/engine/ServerTableEngineSeating.ts'));
    const at = seating.indexOf('public registerWaitForBB');
    expect(at).toBeGreaterThan(-1);
    const body = seating.slice(at, at + 300);
    expect(body).not.toMatch(/wait_for_big_blind/);
    expect(body).toMatch(/if \(!this\.isTournamentTable\(\)\)/);
  });

  it('POST /post-bb cannot buy its way into the small blind', () => {
    // Once entry became free, the only players still waiting are the two the
    // engine holds out for a hand. So this endpoint stopped being a shortcut
    // past a long wait and became the one way to pay a live big blind for the
    // privilege of being dealt into the small blind.
    const seating = strip(read('src/engine/ServerTableEngineSeating.ts'));
    const at = seating.indexOf('public postBBToEnter');
    expect(at).toBeGreaterThan(-1);
    const body = seating.slice(at, at + 900);
    const guard = body.indexOf('getSBSeatIndex');
    const release = body.indexOf('this.waitingForBB.delete(userId)');
    expect(guard, 'no small-blind guard on postBBToEnter').toBeGreaterThan(-1);
    // The refusal must come BEFORE the player is released and billed.
    expect(guard).toBeLessThan(release);
    // BOTH hold-outs, not just the small blind. A player held out because they
    // took the seat the button is about to reach could still pay a live big
    // blind for a hand they were about to get free — the same asymmetry, left
    // open on the other half of the rule.
    expect(body).toMatch(/getButtonSeatIndex/);
    expect(body).toMatch(/seat\.seat_number === buttonSeatIndex/);
  });

  it('nothing in the product calls POST /post-bb any more', () => {
    // Every remaining path through it is a refusal, so a UI that offers it is
    // offering the player a charge they cannot complete and would not want.
    const tablePage = strip(read('../src/pages/TablePage.tsx'));
    expect(tablePage).not.toMatch(/serverPostBBToEnter\(/);
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
    const chosen = DEALING.indexOf('this.lastButtonSeat = dealerSeat');
    const recorded = DEALING.indexOf('this.dealtInUserIds.add(p.user_id)');
    expect(chosen, 'button assignment not found').toBeGreaterThan(-1);
    expect(recorded, 'eligibility recording not found').toBeGreaterThan(-1);
    expect(recorded).toBeGreaterThan(chosen);
  });

  it('the rotation itself walks the eligible roster, not the raw deal roster', () => {
    const at = DEALING.indexOf('const buttonRoster');
    expect(at, 'buttonRoster not found').toBeGreaterThan(-1);
    const block = DEALING.slice(at, at + 700);
    expect(block).toMatch(/this\.buttonEligible\(players\)/);
    expect(block).toMatch(/getNextSeat\(prevButtonSeat,\s*buttonRoster\)/);
  });

  it('a table whose players have ALL never played still gets a button', () => {
    // The fallback that makes this safe on a table's first ever hand. Without
    // it buttonEligible returns [] and the rotation has nothing to choose.
    const at = BASE.indexOf('protected buttonEligible');
    expect(at, 'buttonEligible not found').toBeGreaterThan(-1);
    expect(BASE.slice(at, at + 400)).toMatch(/veterans\.length > 0 \? veterans : roster/);
  });

  it('taking the seat the button is about to reach holds the joiner out one hand', () => {
    expect(DEALING).toMatch(
      /buttonSeatIndex\s*=\s*this\.isTournamentTable\(\)\s*\?\s*-1\s*:\s*this\.getButtonSeatIndex\(\)/
    );
    expect(DEALING).toMatch(/seatedWaiter\.seat_number === buttonSeatIndex/);
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
    expect(BASE.slice(at, at + 300)).toMatch(/if \(this\.isTournamentTable\(\)\) return roster;/);
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
    expect(DEALING.slice(at, at + 200)).toMatch(/currentIds\.has\(id\)/);
  });
});
