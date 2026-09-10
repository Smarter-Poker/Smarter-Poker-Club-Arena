import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

const cutovers = [
  {
    file: '20260909165629_satellite_settlement_has_one_atomic_authority.sql',
    gate: 'require_live_satellite_cutover_freeze',
  },
  {
    file: '20260909205412_spin_reserve_settlement_commits_its_journal_or_nothing.sql',
    gate: 'require_live_spin_cutover_freeze',
  },
  {
    file: '20260909014444_tournament_cancellation_commits_one_stored_receipt.sql',
    gate: 'require_live_cancellation_cutover_freeze',
  },
  {
    file: '20260909014457_four_full_pool_events_retire_only_their_stale_obligation_meta.sql',
    gate: 'require_live_obligation_retirement_freeze',
  },
  {
    file: '20260909014510_every_tournament_payout_names_its_source.sql',
    gate: 'require_live_payout_source_cutover_freeze',
  },
  {
    file: '20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql',
    gate: 'require_live_terminal_cutover_freeze',
  },
  {
    file: '20260910042020_stage_b_exact_precondition_repairs.sql',
    gate: 'require_live_seat_exit_cutover_freeze',
  },
  {
    file: '20260910042112_stage_b_current_postimage_contraction.sql',
    gate: 'require_live_legacy_hold_retirement_freeze',
  },
  {
    file: '20260910042112_stage_b_current_postimage_contraction.sql',
    gate: 'require_live_terminal_acl_cutover_freeze',
  },
  {
    file: '20260909165602_the_four_table_limit_is_never_satellite_cash.sql',
    gate: 'require_live_cap_correction_freeze',
  },
].map((cutover) => ({
  ...cutover,
  sql: readFileSync(resolve(root, 'supabase/migrations', cutover.file), 'utf8'),
}));

function taggedBody(sql: string, tag: string): string {
  const delimiter = `$${tag}$`;
  const opening = sql.indexOf(delimiter);
  const closing = sql.indexOf(delimiter, opening + delimiter.length);
  expect(opening, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(closing, `closing ${delimiter}`).toBeGreaterThan(opening);
  return sql.slice(opening + delimiter.length, closing);
}

describe('stage-one freeze authority is catalog-authenticated', () => {
  it.each(cutovers)(
    '$file authenticates the authority before trusting its predicate',
    (cutover) => {
      const maintenanceRoot = cutover.sql.indexOf('pg_advisory_xact_lock_shared(530090,1)');
      const authentication = cutover.sql.indexOf('DO $authenticate_entry_freeze_authority$');
      const liveGate = cutover.sql.indexOf(`DO $${cutover.gate}$`);

      expect(maintenanceRoot).toBeGreaterThan(-1);
      expect(authentication).toBeGreaterThan(maintenanceRoot);
      expect(liveGate).toBeGreaterThan(authentication);
    }
  );

  it.each(cutovers)('$file pins both executable bodies and their portable owner', (cutover) => {
    const body = taggedBody(cutover.sql, 'authenticate_entry_freeze_authority');

    expect(body).toContain("to_regclass('public.engine_maintenance_break')");
    expect(body).toContain("to_regprocedure('public.fn_entry_purchases_frozen()')");
    expect(body).toContain(
      "to_regprocedure('public.fn_serialize_engine_maintenance_break_write()')"
    );
    expect(body).toContain("md5(p.prosrc) = 'a29498531e4b7d3889532e80fafc8d57'");
    expect(body).toContain("md5(p.prosrc) = '084ed24f99e9d08765bd86ff8b920284'");
    expect(body.match(/p\.proowner = v_relation_owner/g)).toHaveLength(2);
    expect(body).not.toContain("pg_get_userbyid(p.proowner) = '");
    expect(body).toContain("p.prorettype = 'boolean'::regtype");
    expect(body).toContain("p.prorettype = 'trigger'::regtype");
    expect(body).toContain("p.proconfig = ARRAY['search_path=public, pg_temp']::text[]");
  });

  it.each(cutovers)('$file requires the exact enabled statement trigger', (cutover) => {
    const body = taggedBody(cutover.sql, 'authenticate_entry_freeze_authority');

    expect(body).toContain("tg.tgname = 'aa_serialize_maintenance_break_write'");
    expect(body).toContain('tg.tgfoid = v_writer');
    expect(body).toContain("tg.tgenabled = 'O'");
    expect(body).toContain('tg.tgtype = 62');
    expect(body).toContain("tg.tgattr::text = ''");
    expect(body).toContain('tg.tgqual IS NULL');
    expect(body).toContain('tg.tgnargs = 0');
    expect(body).toContain('maintenance-row serialization trigger is not canonical and enabled');
  });

  it('uses one identical hard-coded authentication law at every cutover', () => {
    const bodies = cutovers.map((cutover) =>
      taggedBody(cutover.sql, 'authenticate_entry_freeze_authority')
    );
    expect(new Set(bodies).size).toBe(1);
  });
});
