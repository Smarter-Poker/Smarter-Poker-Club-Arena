/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SECOND WIN IS NEVER WORTH ZERO, AND A RE-DRIVE IS NEVER WORTH TWICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_award_satellite_seat` is idempotent: a winner already entered in the
 * target returns `ok:true, awarded:false` and moves no money. That is correct -
 * nobody holds two chairs and the pool must not be credited twice for one.
 *
 * But the branch that handled it used to log "Seat awarded" and pay NOTHING,
 * while the write below still stamped `prize = ticketCost` on the row. Four
 * winners across satellites `1a6f53a4`, `acb14548` and `e3d3bd1e` received
 * neither a seat they did not already have nor its value. They were back-paid
 * by the migration that taught the function to report
 * `held_from_this_satellite`.
 *
 * The fix has THREE parts and every one of them is load-bearing. This file
 * exists because it shipped with no test at all, and because a five-day-old
 * branch (#1971) proposed a simpler version of the same fix that would have
 * REINTRODUCED the double payment - the simpler version is the tempting one.
 *
 *   1. The cash branch fires only when a DIFFERENT satellite seated them.
 *      When THIS satellite did, it is a recovery re-drive and paying again is
 *      a double payment.
 *   2. The test is `=== false`, not `!held_from_this_satellite`. An old
 *      function without the flag returns `undefined`; under `!` that becomes
 *      "a different satellite seated them" and every re-drive pays again -
 *      exactly the bug, reached by a refactor that looks like a tidy-up.
 *      `=== false` sends `undefined` to neither branch, which is the
 *      conservative pre-migration behaviour.
 *   3. The cash payment carries the SAME stable place key as the
 *      registration-failure branch, so a re-drive of THIS pass dedupes to
 *      nothing rather than paying a third time.
 *
 * Source-level on purpose: all three failures are a CONDITION or an ARGUMENT,
 * which renders identically to the correct code until you read it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const SRC = readFileSync(resolve(__dirname, 'TournamentManager.ts'), 'utf8');

/**
 * The satellite award branch, isolated from every other payCash call.
 *
 * Bounded by the block that CONTAINS the award RPC, not by a character count.
 * A fixed window is the failure tests/unit/noFixedSizeSourceWindows.test.ts
 * exists to stop: comments grow, the asserted code slides past the end, and
 * the pin either goes red for no reason or - worse - stays GREEN because the
 * code it watched is no longer inside the window at all.
 */
const AWARD = sliceEnclosingBlock(SRC, "supabase.rpc('fn_award_satellite_seat'");

describe('a satellite winner who already holds a seat', () => {
  it('reads held_from_this_satellite off the RPC result at all', () => {
    // Without this the engine cannot tell a re-drive from a second satellite,
    // and one of the two outcomes is always wrong.
    expect(AWARD).toContain('held_from_this_satellite');
  });

  it('is paid the ticket in cash when a DIFFERENT satellite seated them', () => {
    expect(AWARD).toMatch(/seat\?\.awarded === false/);
    expect(AWARD).toMatch(/payCash\(/);
  });

  it('is paid NOTHING when THIS satellite seated them - that is a re-drive', () => {
    // The guard must be part of the same condition as `awarded === false`.
    expect(AWARD).toMatch(
      /seat\?\.awarded === false[\s\S]{0,120}held_from_this_satellite === false/
    );
  });

  it('tests === false, so an old function returning undefined pays nobody twice', () => {
    // `!seat?.held_from_this_satellite` is the tempting simplification and it
    // is the 2026-08-30 bug: undefined is falsy, so every re-drive pays again.
    expect(AWARD).not.toMatch(/!\s*seat\?\.held_from_this_satellite/);
    expect(AWARD).toContain('held_from_this_satellite === false');
  });

  it('pays on the same stable place obligation, so a re-drive of this pass dedupes', () => {
    // 2026-09-02: the place key became the obligation (tournament, 'place',
    // N), UNIQUE in the database - the same dedupe, now a constraint.
    const keys = AWARD.match(/\{ kind: 'place', place: Number\(w\.position\) \}/g) || [];
    // The registration-failure branch and the already-held branch must share it.
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });

  it('does not log "Seat awarded" on a path that awarded no seat', () => {
    // The original defect was visible only in the log: it claimed an award,
    // which is why nobody noticed the money had not moved.
    const heldBranch = AWARD.slice(AWARD.indexOf('held_from_this_satellite === false'));
    const beforeElse = heldBranch.slice(0, heldBranch.indexOf('} else {'));
    expect(beforeElse).not.toContain('Seat awarded');
  });
});
