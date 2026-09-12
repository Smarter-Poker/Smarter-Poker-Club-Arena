/**
 * LAW: nothing holds an engine lease row in a mode that stops the heartbeat
 * renewing it.
 *
 * `heartbeat_table_leases_v4` renews with `FOR NO KEY UPDATE ... SKIP LOCKED`,
 * deliberately, so that it never queues behind a settlement. The price of that
 * choice is that a row it cannot lock comes back `busy` and is extended by
 * nothing.
 *
 * `fn_ca_commit_hand_settlement_exact_before_obligations` locked the cash lease
 * row with `FOR SHARE` before committing a hand. `FOR SHARE` conflicts with
 * `FOR NO KEY UPDATE`, so for the length of a settlement that table's heartbeat
 * could not renew that table's lease. Measured against production, on an inert
 * row, twice each, rolled back:
 *
 *   holder takes FOR SHARE      -> heartbeat saw 0 rows   (skipped -> busy)
 *   holder takes FOR KEY SHARE  -> heartbeat saw 1 row    (renews normally)
 *
 * THIS IS LATENT. It was found while chasing a restart loop in which every cash
 * table re-claimed about every twenty seconds, and the first version of this
 * law claimed to be the cure for it. It is not. Contention measured across the
 * 78 cash lease rows was a mean of 0.63 rows skipped, 0.8%, and an expiry needs
 * FOUR consecutive misses - about one chance in two billion. On every row
 * `heartbeat_at` equalled `acquired_at`, so no renewal had ever succeeded at
 * all, which is not the shape of intermittent contention. That loop is
 * engine-side and still open.
 *
 * The conflict is still worth refusing: it costs real renewals under load, it
 * grows with settlement volume, and it is one keyword to remove.
 *
 * THE HOLDER CANNOT WIN THIS BY LOCKING HARDER. The primary key of
 * `engine_table_leases` is `table_id` alone, so a takeover - an upsert of
 * `instance_id`/`lease_generation` - is a NON-KEY update and takes exactly the
 * same lock strength as the heartbeat. No lock a holder can take blocks a
 * takeover and admits a heartbeat. Exclusion has to be asserted by the
 * takeover, which is why `claim_tournament_lease_v2` (2026-09-10) and
 * `claim_table_lease_v2` (2026-09-12) each take an explicit `FOR UPDATE`
 * before their upsert.
 *
 * This law pins the guard rather than the symptom: that the check exists, that
 * CI runs it, and that it still bites. A guard nobody can prove still bites is
 * the same shape of problem as the bug it guards.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { offenders, declaredExceptions } from '../scripts/ci/check-lease-lock-strength.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const CHECKER = 'scripts/ci/check-lease-lock-strength.mjs';

/** Collapse whitespace: a law a `prettier` run can break is not a law. */
const flat = (s: string): string => s.replace(/\s+/g, ' ');

const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

describe('a lease holder does not starve its own heartbeat', () => {
  it('the guard exists', () => {
    expect(existsSync(resolve(ROOT, CHECKER)), `${CHECKER} is missing`).toBe(true);
  });

  it('CI runs it, so it is a gate and not a script somebody could run', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(flat(ci)).toContain(`node ${CHECKER}`);
  });

  it('it bites: FOR SHARE on either lease relation is refused', () => {
    for (const rel of ['engine_table_leases', 'engine_tournament_leases']) {
      const sql = `SELECT 1 FROM public.${rel} l WHERE l.id = x FOR SHARE;`;
      expect(
        offenders(sql).map((o) => o.relation),
        rel
      ).toContain(rel);
    }
  });

  it('it sees inside a function body, which is where the lock actually lives', () => {
    const sql =
      'CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN ' +
      'PERFORM 1 FROM public.engine_table_leases l WHERE l.table_id = x FOR SHARE; ' +
      'END $fn$ LANGUAGE plpgsql;';
    expect(offenders(sql)).toHaveLength(1);
  });

  it('it does not fire on any of the three locks that are correct', () => {
    const fine = [
      'SELECT 1 FROM public.engine_table_leases l WHERE l.table_id = x FOR KEY SHARE;',
      'SELECT 1 FROM public.engine_table_leases l WHERE l.table_id = ANY(x) FOR NO KEY UPDATE OF l SKIP LOCKED;',
      'PERFORM 1 FROM public.engine_table_leases l WHERE l.table_id = x FOR UPDATE;',
    ];
    for (const sql of fine) expect(offenders(sql), sql).toHaveLength(0);
  });

  it('it does not fire on a FOR SHARE aimed at some other table in the same statement', () => {
    const sql =
      'SELECT 1 FROM public.tournaments t JOIN public.engine_table_leases l ON true FOR SHARE OF t;';
    expect(offenders(sql)).toHaveLength(0);
    const aimed =
      'SELECT 1 FROM public.tournaments t JOIN public.engine_table_leases l ON true FOR SHARE OF l;';
    expect(offenders(aimed)).toHaveLength(1);
  });

  it('a migration that only QUOTES the bug in a comment is not the bug', () => {
    const sql =
      '-- it took FOR SHARE on public.engine_table_leases and that was the defect\nSELECT 1;';
    expect(offenders(sql)).toHaveLength(0);
  });

  it('an exemption needs a real reason, not a magic word', () => {
    const tooShort =
      '-- lease-lock-ok: engine_table_leases because reasons\n' +
      'SELECT 1 FROM public.engine_table_leases l WHERE l.table_id = x FOR SHARE;';
    expect(declaredExceptions(tooShort).size).toBe(0);
    expect(offenders(tooShort)).toHaveLength(1);

    const real =
      '-- lease-lock-ok: engine_table_leases because this runs only during the stage\n' +
      '--   cutover, when no engine instance is heartbeating anything at all\n' +
      'SELECT 1 FROM public.engine_table_leases l WHERE l.table_id = x FOR SHARE;';
    expect(declaredExceptions(real).size).toBe(1);
    expect(offenders(real)).toHaveLength(0);
  });

  it('the migration that closed it is still in the tree and still says FOR KEY SHARE', () => {
    const m = read(
      'supabase/migrations/20260912012000_a_hand_commit_held_the_cash_lease_against_its_own_heartbeat.sql'
    );
    // The rewrite is a substitution against the live catalogue, so what the
    // migration must contain is the REPLACEMENT and both assertions that make
    // it safe, not a retyped function body.
    expect(flat(m)).toContain(String.raw`'\1FOR KEY SHARE;'`);
    expect(flat(m)).toContain('v_generation IS DISTINCT FROM p_lease_generation');
    expect(flat(m)).toContain('claim_table_lease_v2');
    expect(flat(m)).toContain('FOR UPDATE');
  });
});
