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
 * Migration 20261001005431 runs the SAME upsert at COMMIT. The statement
 * trigger on rake_records is untouched; its function hands the same ids to an
 * unlogged scratch table whose DEFERRABLE INITIALLY DEFERRED row trigger calls
 * the unchanged fn_ca_club_rake_daily_apply with each id. The rollup's values
 * do not change (per-row and per-statement apply add the same exact numeric
 * terms; proved on 4,003 production rows in a rolled-back probe), and
 * scripts/qualification/club-rake-daily-at-commit.py proves both the values
 * and the lock on an isolated cluster with production's md5-pinned bodies.
 *
 * What a regression looks like, and what this refuses:
 *   - the rollup moved back inside the hand (a non-deferred trigger);
 *   - trigger DDL on rake_records, which no hand-busy minute can grant;
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
const SCRATCH_FN = sliceBetween(MIG, 'AS $fn$', '$fn$;');
const SCRATCH_TRIGGER = sliceBetween(
  MIG,
  'CREATE CONSTRAINT TRIGGER ca_club_rake_daily_at_commit',
  ';'
);
const SUBS = sliceBetween(MIG, 'DO $subs$', '$subs$;');
const OLD_STATEMENT_TRIGGER =
  'CREATE TRIGGER trg_ca_club_rake_daily_ins AFTER INSERT ON public.rake_records REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION trg_ca_club_rake_daily_insert()';

describe('LAW: a club day rake row is taken at commit', () => {
  it('is one transaction with a lock timeout, and takes no lock on rake_records', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '2s';");
    // No trigger DDL on the hot relation: the first version did exactly that and
    // was refused by its own lock_timeout at 01:05 UTC, because some hand always
    // holds rake_records.
    expect(MIG).not.toMatch(
      /^\s*(DROP|CREATE)( CONSTRAINT)? TRIGGER [^\n]* ON public\.rake_records/m
    );
    expect(MIG).not.toMatch(/^\s*ALTER TABLE public\.rake_records/m);
    expect(MIG).not.toMatch(/^\s*(CREATE|DROP)\s+TRIGGER\s+trg_ca_club_rake_daily_ins/m);
  });

  it('pins the rollup functions, the trigger function and the statement trigger, before and after', () => {
    const pins = sliceBetween(MIG, 'DO $pins$', '$pins$;');
    for (const md5 of [
      '9b47ac0cf0ab468e28cfef01548f25e8', // fn_ca_club_rake_daily_apply
      '8c184988b1c7b14f27d4305eb9b99456', // fn_ca_club_rake_daily_compute
      '4bb7c4d64021796803829faacbcddbb0', // trg_ca_club_rake_daily_insert before
    ]) {
      expect(pins).toContain(md5);
    }
    expect(pins).toContain(OLD_STATEMENT_TRIGGER);
    const after = sliceBetween(MIG, 'DO $after$', '$after$;');
    expect(after).toContain(OLD_STATEMENT_TRIGGER); // the rake_records trigger did not move
    expect(after).toContain('9b47ac0cf0ab468e28cfef01548f25e8');
    expect(after).toContain('8c184988b1c7b14f27d4305eb9b99456');
  });

  it('changes the trigger function by one asserted, reversible substitution', () => {
    expect(SUBS).toContain(
      "v_old := E'  IF v_ids IS NOT NULL THEN\\n'\n        || E'    PERFORM public.fn_ca_club_rake_daily_apply(v_ids);\\n'"
    );
    expect(SUBS).toContain(
      "E'    INSERT INTO smarter_private.ca_club_rake_daily_at_commit (rake_record_id)\\n'"
    );
    expect(SUBS).toContain("E'    SELECT unnest(v_ids);\\n'");
    expect(SUBS).toContain('expected exactly 1');
    expect(SUBS).toContain("md5(v_after) <> '7c89337da7ff645a74fd4471be9170a5'");
    expect(SUBS).toContain(
      "md5(replace(v_after, v_new, v_old)) <> '4bb7c4d64021796803829faacbcddbb0'"
    );
    expect(SUBS).toContain('grants moved');
    // The filter stays where it was: the statement trigger still selects the ids.
    expect(ORIGIN).toContain(
      'WHERE NOT coalesce(n.is_tournament, false) AND n.club_id IS NOT NULL;'
    );
  });

  it('applies at COMMIT, once per row, from an unlogged scratch table nobody else can reach', () => {
    expect(MIG).toContain(
      'CREATE UNLOGGED TABLE smarter_private.ca_club_rake_daily_at_commit (\n  rake_record_id uuid PRIMARY KEY\n);'
    );
    expect(MIG).not.toMatch(/ca_club_rake_daily_at_commit[\s\S]{0,200}REFERENCES/); // no FK to a hot relation
    expect(SCRATCH_TRIGGER).toContain(
      'AFTER INSERT ON smarter_private.ca_club_rake_daily_at_commit'
    );
    expect(SCRATCH_TRIGGER).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(SCRATCH_TRIGGER).toContain('FOR EACH ROW');
    expect(SCRATCH_TRIGGER).toContain(
      'EXECUTE FUNCTION smarter_private.fn_ca_club_rake_daily_apply_at_commit()'
    );
    expect(MIG).toContain(
      'REVOKE ALL ON TABLE smarter_private.ca_club_rake_daily_at_commit FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(MIG).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.fn_ca_club_rake_daily_apply_at_commit() FROM PUBLIC, anon, authenticated, service_role;'
    );
  });

  it('writes the same rollup through the same function, and never fails the hand for it', () => {
    expect(SCRATCH_FN).toContain(
      'PERFORM public.fn_ca_club_rake_daily_apply(ARRAY[NEW.rake_record_id]);'
    );
    expect(SCRATCH_FN).toContain(
      'DELETE FROM smarter_private.ca_club_rake_daily_at_commit\n   WHERE rake_record_id = NEW.rake_record_id;'
    );
    expect(SCRATCH_FN).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(SCRATCH_FN).toContain(
      "RAISE WARNING 'ca_club_rake_daily insert rollup failed: %', SQLERRM;"
    );
    expect(SCRATCH_FN.indexOf('DELETE FROM')).toBeLessThan(
      SCRATCH_FN.indexOf('EXCEPTION WHEN OTHERS')
    );
  });

  it('changes only when the rollup runs: no money path and no rollup arithmetic is redefined', () => {
    for (const fn of [
      'atomic_distribute_rake',
      'fn_ca_club_rake_daily_apply',
      'fn_ca_club_rake_daily_compute',
      'fn_ca_process_hand_post_commit_obligations',
      'fn_award_vip_points_from_rake',
    ]) {
      expect(MIG).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\b`));
    }
    expect(MIG).not.toMatch(/^\s*(UPDATE|INSERT INTO|DELETE FROM) public\./m);
  });

  it('carries its live proof', () => {
    expect(MIG).toMatch(
      /@live-proof: \(SELECT t\.tgdeferrable AND t\.tginitdeferred AND \(t\.tgtype & 1\) = 1 AND c\.relpersistence = 'u' AND pg_get_functiondef\('public\.trg_ca_club_rake_daily_insert\(\)'::regprocedure\) LIKE '%INSERT INTO smarter_private\.ca_club_rake_daily_at_commit%'/
    );
  });

  it('is proved by a harness that executes this migration file, not a copy', () => {
    expect(HARNESS).toContain(
      "MIGRATION = ROOT / 'supabase/migrations/20261001005431_a_club_day_rake_row_is_taken_at_commit.sql'"
    );
    expect(HARNESS).toContain("cl.psql(cd.DB, '-f', str(MIGRATION))");
    expect(HARNESS).toContain('cd.build(cl)'); // production's md5-pinned bodies or it refuses
    expect(HARNESS).toContain(
      "'before: hand 2 waits behind the stalled hand on ca_club_rake_daily'"
    );
    expect(HARNESS).toContain("'same-rows: identical day rows'");
    expect(NAME).toBe('20261001005431_a_club_day_rake_row_is_taken_at_commit.sql');
  });
});
