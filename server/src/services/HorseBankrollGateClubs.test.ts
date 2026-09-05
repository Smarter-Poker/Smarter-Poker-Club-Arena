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
    /* 2026-09-02: keyed on the SEAT club (the wallet that pays), no longer
       on table.club_id - see the "a horse plays inside its own club" block
       below for why that key was wrong for every union table. */
    const gate = SRC.slice(
      SRC.indexOf('const roll = seatClub ? bankrolls.get(`${seatClub}:${h.id}`) : undefined;'),
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

/**
 * A HORSE PLAYS INSIDE ITS OWN CLUB (Dan 2026-09-02, verbatim: "FREE THEM TO
 * PLAY OPENLY INSIDE THE DEEP STACK SOCIETY ONLY. THEY HAVE NO AFFILIATION OR
 * ARE A PART OF THE MIDWAY UNION.")
 *
 * Measured on the live engine before this: candidates were drawn from the
 * whole fleet and every roll was keyed on `table.club_id`. For a Midway Union
 * table that is the union's own club row - where no wallet lives - so 261 of
 * 584 Midway horses (and every Deep Stack horse) read a roll of ZERO,
 * computeHorseBuyIn sized a zero buy-in, and the seat was skipped for the
 * cycle. "bankroll gate skipped for 84,954 horse/table pairs"; Midway seated
 * 22 horses an hour against Deep Stack's 198.
 */
describe('a horse plays inside its own club', () => {
  it('reads the union map the database resolves wallets through, and fails CLOSED', () => {
    expect(SRC).toContain("from('union_clubs')");
    const read = SRC.slice(
      SRC.indexOf("from('union_clubs')"),
      SRC.indexOf('const eligibleClubsFor')
    );
    expect(read).toContain('Seeding cycle SKIPPED');
    expect(read).toMatch(/return;/);
  });

  it('a union table is paid from the union MEMBER clubs, a standalone table from itself', () => {
    const fn = SRC.slice(SRC.indexOf('const eligibleClubsFor'), SRC.indexOf('const bankrolls ='));
    expect(fn).toMatch(/if \(t\.union_id\) return unionClubs\.get\(t\.union_id\) \?\? \[\];/);
    expect(fn).toMatch(/return t\.club_id \? \[t\.club_id\] : \[\];/);
  });

  it('loads the wallets of the member clubs, which own no tables of their own', () => {
    expect(SRC).toMatch(/for \(const c of eligibleClubsFor\(t\)\) clubIdsToLoad\.add\(c\);/);
    // Only the statuses fn_seat_club_for_user will pay from.
    expect(SRC).toMatch(/\.in\('status', \['active', 'approved'\]\)/);
  });

  it('a horse with no membership that can pay for the table is NOT a candidate', () => {
    const filter = SRC.slice(
      SRC.indexOf('const passFilter = (relaxPreferences: boolean) =>'),
      SRC.indexOf('const tablesForHorse')
    );
    expect(filter).toMatch(
      /const seatClub = this\.resolveSeatClub\(membership, table, h\.id\);\s*if \(seatClub === null\) \{\s*clubDropped\+\+;\s*return false;\s*\}/
    );
    // ...and an UNKNOWN map still fails open, exactly like the roll.
    const resolver = SRC.slice(
      SRC.indexOf('private resolveSeatClub('),
      SRC.indexOf('private async ensureAllTablesExist')
    );
    expect(resolver).toContain('if (!ctx.known) return undefined;');
    expect(resolver).toContain('if (mine.length === 0) return null;');
  });

  it('a seat already held in the same scope decides the wallet, as the database rules', () => {
    const resolver = SRC.slice(
      SRC.indexOf('private resolveSeatClub('),
      SRC.indexOf('private async ensureAllTablesExist')
    );
    expect(resolver).toMatch(
      /const held = ctx\.seatClubInScope\.get\(horseId\)\?\.get\(ctx\.tableScope\(table\)\);/
    );
    expect(resolver).toMatch(/if \(held && eligible\.includes\(held\)\) return held;/);
  });

  it('the buy-in is sized on the wallet that pays, and that wallet is SENT to the database', () => {
    expect(SRC).not.toContain('bankrolls.get(`${table.club_id}:');
    const sizing = SRC.slice(
      SRC.indexOf('private computeHorseBuyIn('),
      SRC.indexOf('private async seatHorse(')
    );
    expect(sizing).toContain('bankrolls.get(`${seatClub}:${horseId}`)');
    const rpc = SRC.slice(
      SRC.indexOf("supabase.rpc('atomic_table_buyin'"),
      SRC.indexOf('if (rpcErr)')
    );
    expect(rpc).toContain('p_club_id: clubId');
  });
});

/**
 * THE CADENCE IS THE FEATURE. start() promises a cycle every 30 seconds; the
 * engine log on 2026-09-02 showed one beginning 18:08:35 and ending 18:55:53,
 * because the waitlist was pruned once PER TABLE inside the loop - 1,131
 * sequential round trips on a saturated database. Between cycles the floor
 * only drained.
 */
describe('the seeding cycle is one round trip per floor, not per table', () => {
  it('prunes the waitlist ONCE, before the table loop', () => {
    const pruneAt = SRC.indexOf('await this.pruneHorseWaitlist(horseIdSet);');
    // The seeding loop reads the ORDERED tables. Since the fleet policy landed
    // it reads them through `tablesToSeed`, which is `orderedTables` itself
    // unless the whole cycle is withheld, in which case it is empty and the
    // loop does not run at all. Both spellings are the same loop, and this
    // law is about WHERE the prune happens relative to it, not what the list
    // is called, so it accepts either and pins the derivation separately.
    const loopAt = Math.max(
      SRC.indexOf('for (const table of orderedTables) {'),
      SRC.indexOf('for (const table of tablesToSeed) {')
    );
    expect(pruneAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(pruneAt);
    if (SRC.includes('for (const table of tablesToSeed) {')) {
      expect(SRC).toContain('const tablesToSeed = cycleWithheld ? [] : orderedTables;');
    }
    expect(SRC).not.toContain('await this.pruneHorseWaitlist(table.id');
    const pruner = SRC.slice(
      SRC.indexOf('private async pruneHorseWaitlist('),
      SRC.indexOf('private resolveSeatClub(')
    );
    expect(pruner).not.toContain(".eq('table_id'");
  });

  it('says how long the cycle took and how many ticks it cost', () => {
    expect(SRC).toMatch(
      /const cycleSeconds = Math\.round\(\(Date\.now\(\) - cycleStartedAt\) \/ 1000\);/
    );
    expect(SRC).toMatch(/this\.overrunTicks\+\+;/);
    expect(SRC).toMatch(
      /Seeding cycle took \$\{cycleSeconds\}s and \$\{this\.overrunTicks\} 30s tick\(s\)/
    );
  });
});
