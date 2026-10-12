/**
 * OWED MONEY IS PAID BY THE EVENT'S OWN RULE, AND AN UNSETTLED EVENT KEEPS ITS EVIDENCE (2026-10-02).
 *
 * Dan, 2026-10-02: "pay it how you feel it's necessary or don't, it doesn't
 * matter as long as the bug or glitch is done." PKO 3f19bd70 owed 1,355.00 at
 * field level with no knockout recorded and its hand history pruned while the
 * 2,310.00 bounty pool was unpaid. These pins keep the two halves:
 *
 *   1. The champion is paid by the event's own rule (fn_finalize_bounty_pool:
 *      an unclaimed bounty goes to the champion), made whole against the
 *      advertised structure from rows only, with no horse condition and no
 *      clawback of the ladder overpay (CLAUDE.md 10.5, 10.9 rule 3).
 *   2. sp_prune_hand_history keeps a tournament hand until its event is
 *      COMPLETED or CANCELLED, its bounty pool is paid and its escrow is
 *      closed, and never deletes a rakeback earning source.
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
const sqlOnly = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

const PAY = migrationNamed('pko_3f19bd70_champion_is_paid_the_unclaimed_bounty');
const PRUNE = migrationNamed('an_unsettled_tournament_keeps_its_hand_history');

describe('PKO 3f19bd70: the champion is paid the unclaimed bounty by the event rule', () => {
  it('computes the amount from rows: ladder share + unclaimed pool - received', () => {
    expect(PAY).toContain(
      'v_ladder_share := round(v_champ_prize * t.guaranteed_prize / v_ladder_paid, 2);'
    );
    expect(PAY).toContain('v_owed := round(v_ladder_share + t.bounty_pool - v_champ_prize, 2);');
    expect(PAY).toContain('IF v_ladder_share <> 1026.55 OR v_owed <> 2029.90 THEN');
  });

  it('pays only the recorded champion, once, and never on is_horse', () => {
    expect(PAY).toContain("c_champion  CONSTANT uuid := '13133bc4-9139-4066-8b55-8edd31ef2318';");
    expect(PAY).toContain('IF v_champ_pos IS DISTINCT FROM 1');
    expect(PAY).toContain('refusing to pay twice');
    expect(PAY).toContain('the champion was already paid for 3f19bd70');
    expect(sqlOnly(PAY)).not.toMatch(/is_horse/);
  });

  it('moves one leg from the hosting club treasury and takes nothing back', () => {
    expect(PAY).toContain(
      "fn_ca_declare_ledger('settlement', 'club_treasury', c_dss, NULL, v_key, ARRAY['clubs'])"
    );
    expect(PAY).toContain('fn_ca_adjustment_under_10_9(c_event, c_champion, v_owed');
    expect(sqlOnly(PAY)).not.toMatch(
      /UPDATE public\.(tournaments|tournament_payouts|tournament_escrow)\b/
    );
    expect(sqlOnly(PAY)).not.toMatch(/fn_debit|chip_balance\s*=\s*chip_balance\s*-/);
  });

  it('closes exactly the three owed alerts with the receipt', () => {
    expect(PAY).toContain("'decision', 'paid_to_champion_by_event_rule'");
    expect(PAY).toContain('IF v_n <> 3 THEN');
  });
});

describe('the pruner keeps a tournament hand until its event is settled', () => {
  it('patches the live body only when it is the one read', () => {
    expect(PRUNE).toContain("'806608447aefdb6ed4e64dbfe9b86d20'");
    expect(PRUNE).toContain('UNSETTLED_TOURNAMENT_RETENTION_ANCHOR_FOUND_%_TIMES');
  });

  it('excludes hands of a running, bounty-unpaid or escrow-open event', () => {
    expect(PRUNE).toContain("NOT IN (''COMPLETED'',''CANCELLED'',''CANCELED'')");
    expect(PRUNE).toContain('COALESCE(ut.bounty_pool,0)>COALESCE(ut.bounty_pool_paid,0)');
    expect(PRUNE).toContain('WHERE ue.tournament_id=ut.id AND ue.closed_at IS NULL');
  });

  it('proves no pruner deletes a rakeback earning source', () => {
    expect(PRUNE).toContain('a function or cron job deletes a rakeback earning source');
    expect(PRUNE).toContain('the pruner deletes rake_attributions again');
  });
});

describe('the week of 2026-09-14 owed alert closes only over a paid week', () => {
  const CLOSE = migrationNamed('the_week_of_2026_09_14_owed_alert_closes_once_it_is_paid');

  it('refuses unless operation 19aa02d6 is paid and both obligations are discharged by it', () => {
    expect(CLOSE).toContain("IF v_state IS DISTINCT FROM 'paid' OR v_paid_at IS NULL THEN");
    expect(CLOSE).toContain('IF v_n <> 2 OR v_sum <> 138301.89 OR v_pending <> 138303.43 THEN');
    expect(CLOSE).toContain('an obligation of the week is still undischarged');
  });

  it('moves no chip and records the rounding residual as unattributable', () => {
    expect(sqlOnly(CLOSE)).not.toMatch(
      /UPDATE public\.(club_members|clubs|union_wallets|accounting_deferred_obligations)\b/
    );
    expect(sqlOnly(CLOSE)).not.toMatch(/fn_credit_and_log/);
    expect(CLOSE).toContain("'house_retained_unattributable', round(v_pending - v_sum, 2)");
  });
});

describe('Deep Stack Society is funded for its share of the week through the sanctioned door', () => {
  const FUND = migrationNamed('deep_stack_society_is_funded_for_its_share_of_the_week_0914');

  it('mints only through fn_ca_fund_club, only what the payment needs plus the float, once', () => {
    expect(FUND).toContain(
      'v_amount := round(greatest(0, c_net + c_float - COALESCE(v_before, 0)), 2);'
    );
    expect(FUND).toContain('public.fn_ca_fund_club(c_dss, v_amount,');
    expect(FUND).toContain('refusing to fund twice');
    expect(sqlOnly(FUND)).not.toMatch(/UPDATE public\.clubs/);
    expect(sqlOnly(FUND)).not.toMatch(/fn_credit_and_log/);
  });
});
