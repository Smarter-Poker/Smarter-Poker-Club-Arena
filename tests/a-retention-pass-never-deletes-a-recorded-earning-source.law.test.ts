/**
 * ===========================================================================
 *  LAW: A RETENTION PASS NEVER DELETES A RECORDED EARNING SOURCE
 * ===========================================================================
 *
 * Hand-history retention is a STORAGE decision. Dan set it at seven days on
 * 2026-08-27 and raised it to eight on 2026-09-17, and CLAUDE.md 10.5 names it
 * as the single sanctioned asymmetry in the horses-are-players law precisely
 * because it is about the size of `hand_history`, not about what a player
 * earned. The money ledger is not pruned.
 *
 * `sp_prune_hand_history` used to delete `public.rake_attributions` for every
 * hand it pruned, and from 2026-09-25 09:37 onward EVERY run of
 * `sp_prune_hand_history_10m` failed on it:
 *
 *   ERROR: recorded_cash_earning_source_is_immutable
 *   CONTEXT: fn_accounting_cash_source_immutable() line 16
 *     SQL statement "DELETE FROM public.rake_attributions WHERE hand_id=ANY(v_doomed)"
 *     PL/pgSQL function sp_prune_hand_history(integer) line 109
 *
 * Twelve failures in two hours with zero successes, and retention had stopped.
 * Both sides were behaving correctly:
 *
 *   * `accounting_cash_source_immutable` refuses to move an attribution once
 *     `accounting_cash_accrual_batches` holds a batch for its rake record.
 *     That attribution IS the recorded earning source - the basis under every
 *     rakeback figure and every agent commission.
 *   * the pruner deleted it on its way to deleting the hand.
 *
 * The DELETE was never required. There is no foreign key from
 * `rake_attributions.hand_id` to `hand_history.id`, so nothing referential
 * asked for it - and it also fired `trg_ca_club_rake_daily_user_del`, which
 * would have decremented the per-club per-user daily rake rollup for every
 * HORSE in every pruned hand. Horses are players (10.5) and that is their
 * rakeback basis, so a retention pass that ran to completion would have
 * quietly reduced what they had earned.
 *
 * Removed by migration
 * `20260925143224_four_producers_that_measure_the_wrong_thing`, whose cron
 * succeeded at 14:33 UTC the same day after twelve consecutive failures.
 *
 * WHY A LAW AND NOT JUST A FIX. The DELETE reads as obvious tidying: the hand
 * is going, so its rows should go with it. Nothing in the pruner said why one
 * of those four tables is different, and a reader reconstructing the cleanup
 * from the other three would put it back. This says why, in the place the next
 * agent will look.
 */
import { describe, it, expect } from 'vitest';
import { migrationCorpus, type MigrationFile } from './helpers/migrationCorpus';

/** The migration that removed it. Everything at or after this version binds. */
const BINDS_FROM = '20260925143224';

/** Comments carry the explanation, so they are blanked before reading code. */
const codeOnly = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

const version = (m: MigrationFile): string => m.name.slice(0, m.name.indexOf('_'));

/** Any migration that (re)defines the retention pass. */
const redefinesThePruner = (m: MigrationFile): boolean =>
  /sp_prune_hand_history/.test(codeOnly(m.sql));

const deletesAnAttribution = (sql: string): boolean =>
  /DELETE\s+FROM\s+(?:public\.)?rake_attributions/i.test(sql);

describe('a retention pass never deletes a recorded earning source', () => {
  it('the removing migration is in the repo and explains itself', () => {
    const m = migrationCorpus().find((f) => f.name.startsWith(BINDS_FROM));
    expect(m, `migration ${BINDS_FROM} must be recorded in supabase/migrations`).toBeTruthy();
    const sql = m!.sql;
    // the cause, named: the trigger, the reason it is right, and the absence
    // of any foreign key that would have required the delete.
    expect(sql).toContain('recorded_cash_earning_source_is_immutable');
    expect(sql).toContain('accounting_cash_source_immutable');
    expect(sql).toContain('trg_ca_club_rake_daily_user_del');
    expect(sql).toMatch(/no\s+foreign key/i);
    // and it asserts the substitution rather than retyping the function
    expect(sql).toContain('expected exactly 1 rake_attributions DELETE in sp_prune_hand_history');
    expect(sql).toContain('REFUSED: a rake_attributions DELETE survived the substitution');
  });

  it('no migration from that version onward gives the pruner an attribution DELETE back', () => {
    const offenders = migrationCorpus()
      .filter((m) => version(m) >= BINDS_FROM)
      .filter(redefinesThePruner)
      .filter((m) => {
        // The removing migration names the DELETE three times and executes it
        // none: once as the anchor string it searches the live function for,
        // once in the regex that refuses it if the substitution left one
        // behind, and once in prose. It is exempt here and pinned instead by
        // the first test above, which requires both of those refusals to be
        // present - so the exemption cannot quietly become a licence.
        if (m.name.startsWith(BINDS_FROM)) return false;
        return deletesAnAttribution(codeOnly(m.sql));
      })
      .map((m) => m.name);
    expect(
      offenders,
      'These migrations redefine sp_prune_hand_history and delete rake_attributions. ' +
        'An attribution is a recorded earning source and the rakeback basis of every ' +
        'player in the hand, horses included (CLAUDE.md 10.5); retention is a storage ' +
        'decision about hand_history only. accounting_cash_source_immutable will refuse ' +
        'the delete and the whole retention pass stops, which is what happened on ' +
        '2026-09-25.'
    ).toEqual([]);
  });

  it('the rest of the retention pass is untouched: only the one DELETE went', () => {
    const m = migrationCorpus().find((f) => f.name.startsWith(BINDS_FROM))!;
    // the three deletes it keeps, and the boundary conditions that decide what
    // may be pruned at all, are asserted by the migration itself
    for (const kept of [
      'DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);',
      'DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);',
      'DELETE FROM public.hand_history WHERE id=ANY(v_doomed);',
      'horse_retention_days',
      'f06_hand_cards_unresolved',
      'has_human IS DISTINCT FROM true',
      'FOR UPDATE SKIP LOCKED',
    ])
      expect(m.sql, `the migration must require ${kept} to survive`).toContain(kept);
  });

  it('retention stays a config row, not a hard-coded number', () => {
    // 10.5: the eight days are Dan's and live in
    // hand_history_retention_policy.horse_retention_days. A migration that
    // pins a literal day count into the pruner takes that away from him.
    const offenders = migrationCorpus()
      .filter((m) => version(m) >= BINDS_FROM)
      .filter(redefinesThePruner)
      .filter((m) => !/horse_retention_days/.test(codeOnly(m.sql)))
      .map((m) => m.name);
    expect(
      offenders,
      'These redefine the retention pass without reading ' +
        "hand_history_retention_policy.horse_retention_days. The window is the owner's own " +
        'decision and a config row (CLAUDE.md 10.5), never a literal in code.'
    ).toEqual([]);
  });
});
