/**
 * A PERMIT THAT NEVER REACHED THE DATABASE DOES NOT HOLD THE BANK (2026-09-27)
 *
 * Tournament 72e595f4 ("$100 Freeroll - 6:00 PM"), engine cfe8a739: four
 * tables (7e681bb6, a7f144bb, a4583f4a, df913df7) lost the reply to their
 * fn_f06_begin_hand call during the add-on window at 23:19Z. Each engine's
 * permit went to phase 'unknown' (f06_permit_unproven, then
 * f06_prior_hand_unresolved on every attempt), the zombie reaper stopped the
 * engines, and the replacement was refused because the original's F06
 * preparation was unresolved. The only door that resolves it is the
 * stopped-custody park with the engine's attestation (20260927153827) - and
 * the park looked the permit up by id, found no row (the begin never
 * committed), and refused `unstarted_permit_not_this_engines`. The tables
 * could neither deal nor be replaced, their banks were never written, and
 * they held the restart certificate shut: the 23:55Z break did not cut over.
 *
 * The law, pinned on the LATEST definition of each function in the tree:
 *   - an attested permit with no row is looked for again only after the
 *     tournament lane fn_f06_begin_hand commits under has been taken, and
 *     that lane is taken before the retired-origin try-lock;
 *   - it is released only with the caller's generation, only when no durable
 *     witness of a hand exists at the attested number, and the release is
 *     recorded once (a replay of the same shape answers the same release,
 *     any other shape is refused);
 *   - fn_f06_begin_hand refuses a recorded permit id after f06_prefix, so a
 *     begin that arrives late can never start the hand;
 *   - the migration's pre-image is the previous reviewed body of each
 *     function and its post-image is exactly the body it installs.
 *
 * docs/changelog/a-permit-that-never-reached-the-database-does-not-hold-the-bank-2026-09-27.md
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string, fn: string): string {
  const start = sql.indexOf(`FUNCTION public.${fn}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const tag = sql.slice(sql.indexOf('AS $', start) + 3).match(/^\$[a-z_]*\$/)?.[0] ?? '$$';
  const open = sql.indexOf(tag, start) + tag.length;
  return sql.slice(open, sql.indexOf(tag, open));
}

/** Every migration that (re)defines the function, oldest first. */
function definitions(fn: string): { file: string; sql: string }[] {
  const re = new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`);
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(DIR, file), 'utf8') }))
    .filter(({ sql }) => re.test(sql));
}

const PARKS = definitions('fn_park_stopped_time_bank_custody');
const BEGINS = definitions('fn_f06_begin_hand');
const PARK = body(PARKS[PARKS.length - 1].sql, 'fn_park_stopped_time_bank_custody');
const BEGIN = body(BEGINS[BEGINS.length - 1].sql, 'fn_f06_begin_hand');
const OWN_FILE = '20260928001128_a_permit_that_never_reached_the_database_does_not_hold_the_b.sql';
const BEGIN_PRIOR = body(BEGINS[BEGINS.length - 2].sql, 'fn_f06_begin_hand');

/** The branch the park takes when no permit row carries the attested id. */
function absentBranch(): string {
  const open = PARK.indexOf('    IF NOT FOUND THEN\n');
  expect(open).toBeGreaterThan(0);
  const close = PARK.indexOf('    ELSIF v_permit.table_id IS DISTINCT FROM p_table_id', open);
  expect(close).toBeGreaterThan(open);
  return PARK.slice(open, close);
}

describe('a permit that never reached the database does not hold the bank', () => {
  it('takes the lane fn_f06_begin_hand commits under, before the retired-origin try-lock, only for an absent permit', () => {
    const lane = PARK.indexOf(
      'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);'
    );
    const retired = PARK.indexOf(
      'PERFORM smarter_private.f06_retired_origin_lock(p_tournament_id);'
    );
    const lookup = PARK.indexOf('WHERE h.permit_id = p_unstarted_permit_id\n       FOR UPDATE;');
    expect(lane).toBeGreaterThan(0);
    expect(retired).toBeGreaterThan(lane);
    expect(lookup).toBeGreaterThan(retired);
    const guard = PARK.slice(PARK.lastIndexOf('IF p_unstarted_permit_id IS NOT NULL', lane), lane);
    expect(guard).toContain('NOT EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits h');
    expect(guard).toContain('WHERE h.permit_id = p_unstarted_permit_id)');
    expect(PARK.slice(lane, retired)).toContain('v_absent_lane := true;');
    expect(PARK.match(/fn_ca_lock_settlement_lane_for_tournament/g)).toHaveLength(1);
  });

  it('releases an absent permit only under that lane and with the caller generation', () => {
    const branch = absentBranch();
    const refuse = branch.indexOf('IF NOT v_absent_lane OR p_generation IS NULL THEN');
    expect(refuse).toBeGreaterThanOrEqual(0);
    expect(branch.slice(refuse, branch.indexOf('END IF;', refuse))).toContain(
      "'refused', 'unstarted_permit_not_this_engines'"
    );
    expect(branch).toContain('v_released := p_unstarted_permit_id;');
    expect(branch.indexOf('v_released := p_unstarted_permit_id;')).toBeGreaterThan(refuse);
  });

  it('refuses over every durable witness of a hand at the attested number, and records nothing', () => {
    const branch = absentBranch();
    const insert = branch.indexOf('INSERT INTO smarter_private.f06_absent_permit_releases');
    expect(insert).toBeGreaterThan(0);
    const witness = branch.slice(0, insert);
    expect(witness).toContain(
      'FROM smarter_private.f06_hand_permits h\n                    WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number'
    );
    expect(witness).toContain(
      'FROM smarter_private.f06_hand_dispatch d WHERE d.permit_id = p_unstarted_permit_id'
    );
    for (const t of [
      'hand_atomic_commits',
      'hand_history',
      'hand_state_snapshots',
      'hand_private_state',
      'table_hole_cards',
    ])
      expect(witness).toContain(
        `FROM public.${t} h\n                       WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number`
      );
    expect(witness).toContain("'evidence', 'absent_permit_start_witness'");
    expect(witness.slice(witness.lastIndexOf('RETURN'))).toContain(
      "'refused', 'hand_after_custody'"
    );
  });

  it('a replay of the recorded release answers the same release; any other shape is refused', () => {
    const branch = absentBranch();
    expect(branch).toContain(
      '(v_absent.table_id, v_absent.tournament_id, v_absent.generation, v_absent.hand_number)\n' +
        '           IS DISTINCT FROM (p_table_id, p_tournament_id, p_generation, p_unstarted_hand_number)'
    );
    expect(branch.match(/'unstarted_permit_not_this_engines'/g)).toHaveLength(2);
    expect(PARK).toContain(
      "    IF v_released IS NOT NULL THEN\n      NULL; -- released above: the attested permit never reached the database\n    ELSIF v_permit.state = 'never_started' THEN"
    );
  });

  it('every check after the attestation still runs before the bank is written', () => {
    const released = PARK.indexOf('NULL; -- released above');
    const write = PARK.indexOf('UPDATE public.engine_presence_parked');
    for (const evidence of [
      "'evidence', 'hand_history'",
      "'evidence', 'hand_atomic_commits'",
      "'evidence', 'hand_state_snapshots'",
      "'evidence', 'f06_hand_permits'",
    ]) {
      const at = PARK.indexOf(evidence, released);
      expect(at).toBeGreaterThan(released);
      expect(at).toBeLessThan(write);
    }
    // The reserved-row path of 20260927153827 is unchanged.
    for (const kept of [
      "'unstarted_permit_generation_live'",
      "'unstarted_permit_start_witness'",
      'f06_prepared_hand_cancellations',
      'v_attempt >= 40',
      "'newer_park'",
      "'mixed_transfer_recorded'",
    ])
      expect(PARK).toContain(kept);
  });

  it('fn_f06_begin_hand refuses a released permit, after f06_prefix and before it can insert one', () => {
    const prefix = BEGIN.indexOf(
      "PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);"
    );
    const refuse = BEGIN.indexOf(
      "IF EXISTS(SELECT 1 FROM smarter_private.f06_absent_permit_releases WHERE permit_id=p_permit_id) THEN\n RETURN jsonb_build_object('ok',false,'reason','permit_released_absent'); END IF;"
    );
    const insert = BEGIN.indexOf('INSERT INTO smarter_private.f06_hand_permits');
    expect(prefix).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(prefix);
    expect(insert).toBeGreaterThan(refuse);
    // The only change to the begin is that refusal.
    const without = BEGIN.replace(
      " -- A permit its engine attested absent (fn_park_stopped_time_bank_custody, 2026-09-27)\n -- can never be begun afterwards: the absence was recorded under this same lane.\n IF EXISTS(SELECT 1 FROM smarter_private.f06_absent_permit_releases WHERE permit_id=p_permit_id) THEN\n RETURN jsonb_build_object('ok',false,'reason','permit_released_absent'); END IF;\n",
      ''
    );
    expect(without).toBe(BEGIN_PRIOR);
  });

  it('the migration guards its pre-image and post-image by the bodies it replaces and installs, in one transaction', () => {
    // Pinned on this change's OWN migration: a later one (20260928154327, a
    // superseded mixed custody row) redefines the park and guards its own
    // pre-image, which is this file's post-image.
    const at = PARKS.findIndex((d) => d.file === OWN_FILE);
    expect(at).toBeGreaterThan(0);
    const file = PARKS[at];
    const ownPark = body(file.sql, 'fn_park_stopped_time_bank_custody');
    const ownPrior = body(PARKS[at - 1].sql, 'fn_park_stopped_time_bank_custody');
    expect(BEGINS[BEGINS.length - 1].file).toBe(file.file);
    const sql = file.sql;
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    const pre = sql.slice(sql.indexOf('DO $pre$'), sql.indexOf('$pre$;'));
    const post = sql.slice(sql.indexOf('DO $post$'), sql.indexOf('$post$;'));
    expect(pre).toContain(`'${md5(ownPrior)}'`);
    expect(pre).toContain(`'${md5(BEGIN_PRIOR)}'`);
    expect(post).toContain(`'${md5(ownPark)}'`);
    expect(post).toContain(`'${md5(BEGIN)}'`);
    for (const g of [pre, post]) {
      expect(g).toContain("ARRAY['postgres=X/postgres', 'service_role=X/postgres']");
      expect(g).toContain("ARRAY['search_path=pg_catalog, pg_temp']");
      expect(g).toContain("ARRAY['search_path=pg_catalog, public, smarter_private']");
    }
    expect(sql).toContain(
      'ALTER TABLE smarter_private.f06_absent_permit_releases ENABLE ROW LEVEL SECURITY;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON smarter_private.f06_absent_permit_releases FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(sql).toContain(
      'BEFORE UPDATE OR DELETE\n  ON smarter_private.f06_absent_permit_releases FOR EACH ROW'
    );
    expect(sql).toMatch(/^-- @live-proof: /m);
  });

  it('the engine already attests a permit whose begin reply was lost, and resolves only on the named release', () => {
    const engine = readFileSync(
      join(__dirname, '..', 'server', 'src', 'engine', 'ServerTableEngineBase.ts'),
      'utf8'
    );
    expect(engine).toContain(
      "if (phase !== 'reserved' && phase !== 'unknown' && phase !== 'terminated') return null;"
    );
    expect(engine).toContain('outcome.unstartedPermitReleased === unstartedPermit.permitId &&');
  });
});
