/**
 * A PLAYER'S OVERPAY IS THE HOUSE'S, AND A SKIPPED WEEK STAYS OWED (2026-09-26).
 *
 * CLAUDE.md 10.5 (horses are players, never skipped on a repayment) and 10.9
 * rule 3 (nothing is taken back from a player for our mistake) are binding.
 * Two money migrations of 2026-09-26 gave horses a worse deal than a human
 * would have had: one took a double-paid top-up back from 32 horses "because
 * they are horses", the other wrote off the week of 2026-09-14 rakeback
 * "because every recipient is a horse". These pins keep the corrections:
 * the 1,001.00 goes back to the same 32 wallets once, through one journal leg
 * each, with no horse condition anywhere; and the week's rakeback stays owed
 * on the calculator's basis instead of being closed.
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

const RESTORE = migrationNamed('a_horse_keeps_the_duplicate_prize_our_defect_paid_it_and_the');
const BASIS = migrationNamed('the_week_of_2026_09_14_rakeback_stays_owed_on_the_calculator');
const sqlOnly = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

describe('a double-paid prize stays with the player, horse or human', () => {
  it('never decides on is_horse', () => {
    expect(sqlOnly(RESTORE)).not.toMatch(/is_horse/);
  });

  it('returns exactly the 32 recovered amounts, 1,001.00, once each', () => {
    expect(RESTORE).toContain("WHERE a.decision_note = 'migration ' || c_recovery");
    expect(RESTORE).toContain(
      "'double-pay-restore:' || r.tournament_id::text || ':' || r.user_id::text"
    );
    expect(RESTORE).toContain('was already spent - refusing to pay twice');
    expect(RESTORE).toContain('this restoration already ran');
  });

  it('credits the same club wallet the recovery debited, from the union bank, in one leg', () => {
    expect(RESTORE).toContain(
      "fn_ca_declare_ledger('settlement', 'union_bank', c_union, NULL, v_key, ARRAY['union_wallets'])"
    );
    expect(RESTORE).toContain('WHERE user_id = r.user_id AND club_id = r.club_id');
    expect(RESTORE).toContain('v_legs <> 32 OR v_legsum <> 1001.00');
    expect(RESTORE).toContain('a second leg touched the union wallet');
  });

  it('records the house cost on the alerts', () => {
    expect(RESTORE).toContain("'decision', 'house_absorbs_duplicate'");
  });
});

describe('the week of 2026-09-14 rakeback is owed, not written off', () => {
  it('voids the horse-based write-off and keeps pending_amount', () => {
    expect(BASIS).toContain('SUPERSEDED 2026-09-26');
    expect(BASIS).toContain("'status', 'owed_not_written_off'");
    expect(sqlOnly(BASIS)).not.toMatch(/SET\s+pending_amount/);
    expect(sqlOnly(BASIS)).not.toMatch(/is_horse/);
  });

  it('moves no chip', () => {
    expect(sqlOnly(BASIS)).not.toMatch(/UPDATE public\.(club_members|clubs|union_wallets)/);
    expect(sqlOnly(BASIS)).not.toMatch(/fn_credit_and_log/);
  });

  it("closes only the floored week's retries, and only while the floor stands", () => {
    expect(BASIS).toContain('the settlement floor is no longer 2026-09-21');
    expect(BASIS).toContain("AND context->>'period_start' = '2026-09-07T07:00:00+00:00'");
    expect(BASIS).toContain('IF v_n <> 360 THEN');
  });
});
