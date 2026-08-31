/**
 * THE GATE MUST READ THE CLUBS THAT OWN THE TABLES, AND AN UNKNOWN ROLL MUST
 * NOT REFUSE A SEAT.
 *
 * 2026-08-31 incident. The cash floor went from 129 horse seats to ZERO in one
 * minute and stayed empty for forty, while tournaments ran untouched.
 *
 * Two faults, and it took both:
 *
 *  1. the bankroll map was loaded for `this.clubIds` — the round-robin used
 *     when CREATING tables — which shared not one entry with the clubs that
 *     actually own the open tables. All 26 cash tables belonged to
 *     `fade0000-…-0001`; the loader read two clubs owning zero cash tables.
 *     Every lookup missed.
 *  2. a miss was written as `return false`. So every horse was refused at
 *     every table, every cycle.
 *
 * Fault 2 alone is survivable; fault 1 alone is survivable. Together they are
 * a dead floor — and they were invisible for weeks because a THIRD bug (the
 * `club_members` keyset paging fixed in #2101) kept `bankrollsLoaded` false,
 * so the gate never ran at all. The moment that was fixed, this fired.
 *
 * A source contract, because the failure was in which rows got loaded and how
 * a miss was interpreted — neither of which a unit test of the arithmetic can
 * see, and both of which are one careless edit away from returning.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');

describe('the bankroll gate reads the clubs whose seats it is deciding', () => {
  it('derives the club set from the TABLES, not from the creation round-robin', () => {
    expect(SRC).toContain('const clubIdsToLoad = new Set<string>(this.clubIds);');
    expect(SRC).toMatch(/for \(const t of tables\)[\s\S]{0,200}clubIdsToLoad\.add\(cid\)/);
    expect(SRC).toContain('for (const clubId of clubIdsToLoad) {');
  });

  it('does NOT page the hard-coded pair alone', () => {
    // The exact line that emptied the floor.
    expect(SRC).not.toContain('for (const clubId of this.clubIds) {');
  });
});

describe('an unknown roll is unknown, not zero', () => {
  it('fails OPEN - a missing membership row never refuses a seat', () => {
    const gate = SRC.slice(
      SRC.indexOf('const roll = bankrolls.get(`${table.club_id}:${h.id}`);'),
      SRC.indexOf('const ref = referenceBuyIn(')
    );
    expect(gate).toContain('roll === undefined');
    expect(gate).toContain('return true;');
    expect(gate).not.toContain('return false');
  });

  it('says so out loud - the silent version of this number cost 40 minutes', () => {
    expect(SRC).toContain('rollUnknown++');
    expect(SRC).toMatch(/bankroll gate skipped for \$\{rollUnknown\}/);
  });

  /**
   * The gate itself must still bite when the roll IS known. Failing open on a
   * missing row is not a licence to fail open on a poor one.
   */
  it('still refuses a KNOWN roll that cannot cover the stake', () => {
    /* Shape-tolerant, intent-strict. The refusal grew a telemetry counter in
       the bankroll-telemetry PR, so the old exact-line assertion broke on a
       change that strengthened the very thing it guards. What must hold is
       that a failed canSit REFUSES: the counter may sit between, a `return
       false` may not go missing. */
    expect(SRC).toMatch(
      /if \(!canSit\(roll, ref, bankrollPolicyFor\(h\.id\)\)\) \{[^{}]*return false;\s*\}/
    );
  });
});
