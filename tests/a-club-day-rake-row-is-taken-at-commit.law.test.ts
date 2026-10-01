/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A CLUB'S DAY RAKE ROW IS TAKEN AT COMMIT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ca_club_rake_daily has one row per (club, UTC day), and every raked cash
 * hand upserts it. The upsert used to run from an AFTER INSERT statement
 * trigger on rake_records, i.e. in the middle of atomic_distribute_rake, and
 * the row lock was then held through everything the hand still had to do:
 * the rake attributions (whose profiles foreign key waits behind the horse
 * claims), the wallets, the BBJ pool, the promo and add-on receipts and the
 * PostgREST round trip to COMMIT. Every other hand of the club - and every
 * union hand that attributes rake to it - queued behind the slowest one. In
 * the 24 h to 2026-10-01 00:45 UTC that line was where the post-commit
 * obligations RPC hit its 8 s statement timeout 11,373 times of 17,063 (67%),
 * plus 1,172 cancellations of fn_project_hand_side_effects on the same row.
 *
 * Migration 20261001005431 runs the SAME upsert at COMMIT: a DEFERRABLE
 * INITIALLY DEFERRED constraint trigger, FOR EACH ROW, calling the unchanged
 * fn_ca_club_rake_daily_apply with the row's id. The rollup's values do not
 * change (per-row and per-statement apply add the same exact numeric terms);
 * scripts/qualification/club-rake-daily-at-commit.py proves both the values
 * and the lock on an isolated cluster with production's md5-pinned bodies.
 *
 * What a regression looks like, and what this refuses:
 *   - the rollup moved back inside the hand (a non-deferred trigger);
 *   - a different filter than the old one (cash rows that name a club);
 *   - a rollup failure allowed to fail the hand;
 *   - the money path or the rollup arithmetic edited in the same breath.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_club_day_rake_row_is_taken_at_commit.sql'))
  .at(-1);
if (!NAME) throw new Error('the club day rake at-commit migration is missing');
const MIG = migrationText(NAME);
const ORIGIN = migrationText(
  migrationNames().find((n) => n.endsWith('_the_money_is_read_from_the_ledger.sql')) ?? ''
);
const HARNESS = readFileSync(
  resolve(__dirname, '..', 'scripts', 'qualification', 'club-rake-daily-at-commit.py'),
  'utf8'
);
const BODY = sliceBetween(MIG, 'AS $fn$', '$fn$;');
const TRIGGER = sliceBetween(MIG, 'CREATE CONSTRAINT TRIGGER trg_ca_club_rake_daily_ins', ';');

describe('LAW: a club day rake row is taken at commit', () => {
  it('is one transaction with a lock timeout, outside nothing', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '2s';");
  });

  it('pins the rollup functions and the statement trigger it replaces, before and after', () => {
    const pins = sliceBetween(MIG, 'DO $pins$', '$pins$;');
    for (const md5 of [
      '9b47ac0cf0ab468e28cfef01548f25e8', // fn_ca_club_rake_daily_apply
      '8c184988b1c7b14f27d4305eb9b99456', // fn_ca_club_rake_daily_compute
      '4bb7c4d64021796803829faacbcddbb0', // trg_ca_club_rake_daily_insert (left in place)
    ]) {
      expect(pins).toContain(md5);
    }
    expect(pins).toContain(
      'CREATE TRIGGER trg_ca_club_rake_daily_ins AFTER INSERT ON public.rake_records REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_insert()'
    );
    const after = sliceBetween(MIG, 'DO $after$', '$after$;');
    expect(after).toContain('9b47ac0cf0ab468e28cfef01548f25e8');
    expect(after).toContain('8c184988b1c7b14f27d4305eb9b99456');
  });

  it('runs at COMMIT, once per row, with the old filter', () => {
    expect(TRIGGER).toContain('AFTER INSERT ON public.rake_records');
    expect(TRIGGER).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(TRIGGER).toContain('FOR EACH ROW');
    expect(TRIGGER).toContain('WHEN (NOT COALESCE(NEW.is_tournament, false) AND NEW.club_id IS NOT NULL)');
    expect(TRIGGER).toContain('EXECUTE FUNCTION public.trg_ca_club_rake_daily_insert_at_commit()');
    // The filter is the one the statement trigger applied to its rows.
    expect(ORIGIN).toContain('WHERE NOT coalesce(n.is_tournament, false) AND n.club_id IS NOT NULL');
    expect(MIG).toMatch(
      /tgdeferrable AND t\.tginitdeferred[\s\S]*CREATE CONSTRAINT TRIGGER trg_ca_club_rake_daily_ins AFTER INSERT ON public\.rake_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW/
    );
  });

  it('writes the same rollup, through the same function, and never fails the hand for it', () => {
    expect(BODY).toContain('PERFORM public.fn_ca_club_rake_daily_apply(ARRAY[NEW.id]);');
    expect(BODY).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(BODY).toContain("RAISE WARNING 'ca_club_rake_daily insert rollup failed: %', SQLERRM;");
    expect(BODY.match(/RETURN NULL;/g)).toHaveLength(2);
    expect(MIG).toContain('SECURITY DEFINER');
    expect(MIG).toContain('SET search_path = public');
    expect(MIG).toContain(
      'REVOKE ALL ON FUNCTION public.trg_ca_club_rake_daily_insert_at_commit() FROM PUBLIC, anon, authenticated;'
    );
  });

  it('changes only when the rollup runs: no money path and no rollup arithmetic is redefined', () => {
    for (const fn of [
      'atomic_distribute_rake',
      'fn_ca_club_rake_daily_apply',
      'fn_ca_club_rake_daily_compute',
      'fn_ca_process_hand_post_commit_obligations',
      'fn_award_vip_points_from_rake',
      'trg_ca_club_rake_daily_insert()',
    ]) {
      expect(MIG).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn.replace(/[()]/g, '\\$&')}`));
    }
    expect(MIG).not.toMatch(/^\s*(UPDATE|INSERT INTO|DELETE FROM)\s/m);
    expect(MIG.match(/^DROP /gm)).toEqual(['DROP ']);
    expect(MIG).toContain('DROP TRIGGER trg_ca_club_rake_daily_ins ON public.rake_records;');
  });

  it('carries its live proof', () => {
    expect(MIG).toMatch(
      /@live-proof: \(SELECT tgdeferrable AND tginitdeferred .* tgfoid = 'public\.trg_ca_club_rake_daily_insert_at_commit\(\)'::regprocedure\)/
    );
  });

  it('is proved by a harness that executes this migration file, not a copy', () => {
    expect(HARNESS).toContain(
      "MIGRATION = ROOT / 'supabase/migrations/20261001005431_a_club_day_rake_row_is_taken_at_commit.sql'"
    );
    expect(HARNESS).toContain("cl.psql(cd.DB, '-f', str(MIGRATION))");
    expect(HARNESS).toContain('cd.build(cl)'); // production's md5-pinned bodies or it refuses
    expect(NAME).toBe('20261001005431_a_club_day_rake_row_is_taken_at_commit.sql');
  });
});
