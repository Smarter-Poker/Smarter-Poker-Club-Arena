/**
 * A RULING MAKE-GOOD, AND A BOT'S DUPLICATE PRIZE, EACH MOVE THROUGH ONE
 * JOURNAL LEG (2026-09-26).
 *
 * Both events' books are sealed (terminal escrow and terminal wallet evidence
 * are immutable) so neither money movement may name its tournament; both
 * declare the bank that pays or receives, skip that bank's own trigger, and let
 * the wallet trigger write the single leg - the CHIP STANDARD 2.4 shape of
 * fn_club_bank_send. Each leaves an approved-then-settled ca_manual_adjustments
 * receipt and resolves its alert with the receipt ids. The duplicate-prize
 * reversal and the rakeback write-off pinned below are HISTORY: both treated a
 * horse worse than a human (CLAUDE.md 10.5, 10.9 rule 3) and were superseded by
 * 20260926131530 (every chip returned) and 20260926131554 (the week stays
 * owed); see a-players-overpay-is-the-houses-and-a-skipped-week-stays-owed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const migrationNamed = (slug: string): string => {
  const hit = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(`_${slug}.sql`));
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};

const MAKE_GOOD = migrationNamed('the_house_pays_the_mystery_bounty_make_good_the_ruling_owed');
const REVERSAL = migrationNamed('the_bots_paid_twice_on_2026_09_02_return_the_duplicate');
const PKO = migrationNamed('a_bot_only_pko_shortfall_and_confirmed_noise_are_closed_with');
const RAKEBACK = migrationNamed('the_week_of_2026_09_14_horse_rakeback_is_closed_by_dispositi');

describe('the mystery-bounty make-good', () => {
  it('pays the ruling owed_cents basis, 76.90 over seven obligations, and refuses a second payment', () => {
    expect(MAKE_GOOD).toContain('IF (SELECT sum(cents) FROM zz_make_good) <> 7690 THEN');
    expect(MAKE_GOOD).toContain('is already resolved - refusing to pay twice');
    expect(MAKE_GOOD).toContain("'ruling-make-good:' || r.obligation_id::text");
  });

  it('declares the treasury, skips the clubs trigger, and credits through the idempotent wallet door with no tournament', () => {
    expect(MAKE_GOOD).toContain(
      "fn_ca_declare_ledger('settlement', 'club_treasury', c_dss, NULL, v_key, ARRAY['clubs'])"
    );
    expect(MAKE_GOOD).toContain(
      "fn_credit_and_log(r.user_id, round(r.cents / 100.0, 2), v_key, 'settlement', v_desc, NULL)"
    );
    expect(MAKE_GOOD).not.toMatch(/fn_credit_and_log\([^)]*'bounty'/);
  });

  it('proves one leg per obligation and no second leg on the treasury', () => {
    expect(MAKE_GOOD).toContain('the journal does not carry exactly seven legs totalling 76.90');
    expect(MAKE_GOOD).toContain('a second journal leg touched the treasury');
  });

  it('marks each obligation funded on its alert and settles its adjustment', () => {
    expect(MAKE_GOOD).toContain("'funded', true");
    expect(MAKE_GOOD).toContain("SET status = 'settled' WHERE id = v_adj AND status = 'approved'");
  });
});

describe('the duplicate prize reversal (history, superseded by 20260926131530)', () => {
  it('as applied, it recovered only from horses', () => {
    expect(REVERSAL).toContain('a recipient is not a horse; a human is never clawed back');
  });

  it('re-proves the double payment before moving a chip', () => {
    expect(REVERSAL).toContain(
      'a recipient no longer shows exactly two equal top-up credits and no reversal'
    );
    expect(REVERSAL).toContain('an event is no longer overpaid by exactly its duplicate');
  });

  it('returns each duplicate to the union bank in one reversal leg', () => {
    expect(REVERSAL).toContain(
      "fn_ca_declare_ledger('reversal', 'union_bank', c_union, NULL, v_key, ARRAY['union_wallets'])"
    );
    expect(REVERSAL).toContain('v_legs <> 32 OR v_legsum <> 1001.00');
    expect(REVERSAL).toContain('a second leg touched the union wallet');
  });
});

describe('dispositions that paid nothing (history: both reversed by Dan on 2026-09-26)', () => {
  it('the PKO 3f19bd70 closure as applied (history, reopened as owed by 20260926131420)', () => {
    expect(PKO).toContain('the fields are no longer 66 and 155 horses');
    expect(PKO).toContain('knockout evidence exists after all - attribute it instead of closing');
    expect(PKO).toContain('the recurrence guard is not in place');
  });

  it('the rakeback disposition as applied (history, voided by 20260926131554)', () => {
    expect(RAKEBACK).toContain('a human is owed and this disposition does not apply');
    expect(RAKEBACK).not.toMatch(/UPDATE public\.(club_members|clubs|union_wallets)/);
  });
});
