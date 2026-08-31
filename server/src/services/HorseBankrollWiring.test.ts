/**
 * THE BANKROLL LAYER IS WIRED INTO SEATING (Dan 2026-08-31).
 *
 * A correct module nobody calls is the failure mode this repo has already
 * shipped once (Phase 2's first wiring test passed while the consult was
 * unwired, because the heuristics happened to agree). So this asserts the
 * SEATING PATH itself contains the gate and the cap, and that both read the
 * per-club bankroll rather than a global number.
 *
 * It is a source contract rather than a live seeding run because seatHorse
 * ends in `atomic_table_buyin` against production; the arithmetic those calls
 * carry is proven exhaustively in HorseBankroll.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');

describe('the seeding cycle knows every horse bankroll', () => {
  it('loads club_members.chip_balance, keyed per (club, user)', () => {
    expect(SRC).toContain("from('club_members')");
    expect(SRC).toContain('chip_balance');
    expect(SRC).toMatch(/bankrolls\.set\(`\$\{r\.club_id\}:\$\{r\.user_id\}`/);
  });

  it('loads it ONCE per cycle, not per seat', () => {
    // one paged read, outside the table loop
    expect((SRC.match(/HorseFleet\.bankrolls/g) || []).length).toBe(1);
  });

  /**
   * FAILING OPEN IS DELIBERATE. If the bankroll page comes back short, the
   * alternative — treating every horse as broke — empties the entire floor
   * on one bad read. `atomic_table_buyin` still refuses a seat the balance
   * cannot cover, so the worst case is the pre-bankroll behaviour.
   */
  it('an incomplete read disables the gate rather than emptying the floor', () => {
    expect(SRC).toContain('bankrollsLoaded');
    expect(SRC).toMatch(/if \(bankrollsLoaded\)/);
    expect(SRC).toContain('seating this cycle without the bankroll gate');
  });
});

describe('both decision points consult it', () => {
  it('the CANDIDATE filter refuses a horse that cannot cover the stake', () => {
    const filter = SRC.slice(
      SRC.indexOf('const candidateHorses'),
      SRC.indexOf('const tablesForHorse')
    );
    expect(filter).toContain('canSit(');
    expect(filter).toContain('referenceBuyIn(');
    expect(filter).toContain('bankrollPolicyFor(');
  });

  it('the BUY-IN is capped to a share of the roll, and a zero cap skips the seat', () => {
    const sizing = SRC.slice(
      SRC.indexOf('const raw = table.big_blind * buyInBBFor'),
      SRC.indexOf('const success = await this.seatHorse')
    );
    expect(sizing).toContain('bankrollBuyIn(');
    expect(sizing).toMatch(/if \(capped <= 0\) continue;/);
  });

  it('the bankroll gate sits alongside the stake band, not instead of it', () => {
    // A band says what a horse has EARNED; the bankroll says what it AFFORDS.
    expect(SRC).toContain('stakeBandAllows(h.id, table.big_blind)');
    expect(SRC).toContain('canSit(roll, ref, bankrollPolicyFor(h.id))');
  });
});
