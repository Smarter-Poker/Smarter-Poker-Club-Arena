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
    /* 2026-08-31: the sizing moved OUT of the seeding loop into
       `computeHorseBuyIn`, because a horse answering a seat call
       (claimOfferedSeats) must bring the same amount, and two copies of this
       arithmetic is the bug src/lib/cashBuyIn.ts exists to end. The gate is
       pinned where it now lives; the companion test below is STRICTER than the
       old anchor, because it also requires every caller to go through it. */
    const sizing = SRC.slice(
      SRC.indexOf('private computeHorseBuyIn('),
      SRC.indexOf('private async seatHorse(')
    );
    expect(sizing).toContain('bankrollBuyIn(');
    /* Same widening as the gate pin: `capped <= 0` gained a
       `seat_refused_share_below_min` counter, so the refusal is now a block.
       The skip is what matters and is still required. */
    /* A zero cap still skips the seat. Inside the helper that is a `return 0`;
       the callers are required to honour it by the next test. */
    expect(sizing).toMatch(/if \(capped <= 0\) \{[^{}]*return 0;\s*\}/);
  });

  it('every caller sizes through the one helper and honours a zero cap', () => {
    const calls = SRC.match(/this\.computeHorseBuyIn\(/g) ?? [];
    expect(calls.length, 'seeding and the seat-call claim must both use it').toBe(2);
    expect(SRC).toMatch(
      /const buyIn = this\.computeHorseBuyIn\([^;]*\);\s*if \(buyIn <= 0\) continue;/
    );
  });

  it('the bankroll gate sits alongside the stake band, not instead of it', () => {
    // A band says what a horse has EARNED; the bankroll says what it AFFORDS.
    // The band gate also takes the TABLE'S HOST since 2026-09-11, because a
    // band is only meaningful against the ladder that host actually deals.
    expect(SRC).toContain('!stakeBandAllows(');
    expect(SRC).toContain('table.big_blind,');
    expect(SRC).toContain('canSit(roll, ref, bankrollPolicyFor(h.id))');
  });
});

const ROT = readFileSync(join(process.cwd(), 'src/services/HorseSessionRotator.ts'), 'utf8');

describe('the rotator enforces the roll on reloads and on leaving', () => {
  it('the TOP-UP is capped by topUpAllowance, not just by the table max', () => {
    expect(ROT).toContain('topUpAllowance(');
    expect(ROT).toContain('investedThisTable');
  });

  /**
   * THE SILENT-MISS GUARD. The roll is keyed `${club_id}:${user_id}`, so a
   * seat query that does not SELECT club_id would look every horse up under
   * `":<uuid>"`, miss every time, and disable the cap without failing — the
   * exact shape of bug this repo keeps finding. Pin the column.
   */
  it('the seat query selects club_id, so the roll lookup can actually resolve', () => {
    const sel = ROT.slice(ROT.indexOf("from('table_seats')"), ROT.indexOf("is('left_at', null)"));
    expect(sel).toContain('club_id');
  });

  it('session exit reads REAL P&L from the ledger, not an assumed buy-in', () => {
    expect(ROT).toContain('sessionVerdict(');
    expect(ROT).toContain("from('chip_ledger')");
    expect(ROT).toMatch(/stack - invested/);
  });

  it('booking a win is CERTAIN, not a coin flip', () => {
    const block = ROT.slice(
      ROT.indexOf('const verdict = sessionVerdict'),
      ROT.indexOf('const swing = stack / buyIn')
    );
    expect(block).toContain('Number.POSITIVE_INFINITY');
  });

  /**
   * Failing open again: a rotator that mistakes "the ledger did not load"
   * for "this horse is stuck" would empty the floor on one bad read.
   */
  it('no ledger figure means the original heuristic, never a forced exit', () => {
    expect(ROT).toMatch(/if \(invested !== undefined && invested > 0\)/);
    expect(ROT).toContain('const swing = stack / buyIn');
  });
});
