import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => readFileSync(resolve(__dirname, relative), 'utf8');
const block = (source: string, tag: string): string => {
  const start = source.indexOf(`DO $${tag}$`);
  const end = source.indexOf(`$${tag}$;`, start);
  expect(start, `${tag} starts`).toBeGreaterThan(-1);
  expect(end, `${tag} ends`).toBeGreaterThan(start);
  return source.slice(start, end);
};

const gameServer = read('../GameServer.ts');
const executableGameServer = gameServer
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const eliminations = read('./TournamentManagerEliminations.ts');
const satellite = read(
  '../../../supabase/staged-migrations/20260908032729_satellite_legacy_seat_door_is_retired_after_engine_cutover.sql'
);
const spin = read(
  '../../../supabase/staged-migrations/20260908035401_legacy_spin_repair_fleet_is_removed_after_engine_cutover.sql'
);
const cash = read(
  '../../../supabase/staged-migrations/20260908044246_legacy_cash_repair_fleet_retires_only_after_zero_backlog.sql'
);
const bounty = read(
  '../../../supabase/staged-migrations/20260908045946_legacy_bounty_backpay_retires_after_atomic_receipt_cutover.sql'
);
const seatCredit = read(
  '../../../supabase/staged-migrations/20260908051200_legacy_seat_credit_repair_doors_retire_after_seat_authority_cutover.sql'
);

describe('stage-two repair-fleet retirement follows the published root authorities', () => {
  it('has no executable engine caller or timer for any retired terminal repair', () => {
    for (const retired of [
      'fn_sweep_unsettled_tournament_rake',
      'fn_payout_guarantee_check',
      'fn_repair_tournament_rake_attribution',
      'fn_backpay_tournament_rake_attribution',
      'fn_ca_return_unawarded_spin_draws',
      'lastRakeSweepAt',
      'lastPayoutGuaranteeCheckAt',
      'lastRakeAttributionRepairAt',
    ]) {
      expect(executableGameServer).not.toContain(retired);
    }
    expect(executableGameServer).toContain('recoverStuckCompletingTournaments');
    expect(executableGameServer).toContain("supabase.rpc('fn_spin_expire_unfilled'");
  });

  it('uses only current semantic cutover versions in every staged family', () => {
    expect(satellite).toContain("migration_version IS DISTINCT FROM '20260909014421'");
    expect(satellite).toContain("c.migration_version = '20260909014534'");
    expect(spin).toContain("migration_version IS DISTINCT FROM '20260909014433'");
    expect(cash).toContain("c.migration_version = '20260909014534'");
    expect(cash).toContain('restamped after 20260909014457');
    expect(bounty).toContain("c.migration_version = '20260909014534'");
    expect(bounty).toContain("c.migration_version='20260909014545'");
    expect(seatCredit).toContain("c.migration_version='20260909014545'");
    for (const stale of [
      '20260908221040',
      '20260908221055',
      '20260908221143',
      '20260908221218',
      '20260908221234',
    ]) {
      expect([satellite, spin, cash, bounty, seatCredit].join('\n')).not.toContain(stale);
    }
  });

  it('requires the stage-one hold door to be absent instead of dropping it again', () => {
    const preflight = block(cash, 'preflight');
    expect(preflight).toContain(
      "to_regprocedure('public.fn_release_tournament_holds(uuid)') IS NOT NULL"
    );
    expect(preflight).toContain('requires 20260909041438');
    expect(cash).not.toContain('DROP FUNCTION public.fn_release_tournament_holds(uuid)');
    expect(block(cash, 'cash_dependency_and_invocation_gate')).not.toContain(
      'fn_release_tournament_holds'
    );
  });

  it('requires owner-only cash components and one exact drained engine cohort', () => {
    const preflight = block(cash, 'preflight');
    const cohort = block(cash, 'exact_cash_engine_cohort_gate');
    expect(preflight).toContain('acl.grantee<>p.proowner');
    expect(preflight).toContain('requires 20260909043000 owner-only component ACL');
    expect(cohort).toContain("c_required_engine_version constant text := '__SET_AFTER_PUBLISH__'");
    expect(cohort).toContain("c_minimum_cohort_age constant interval := interval '60 seconds'");
    expect(cohort).toContain('FROM public.engine_table_leases l');
    expect(cohort).toContain('FROM public.engine_tournament_leases l');
    expect(cohort.match(/l\.instance_id IS DISTINCT FROM v_leader\.instance_id/g)).toHaveLength(2);
  });

  it('retires the Spin cancellation reconciler only after a drained build and zero backlog', () => {
    const cohort = block(spin, 'exact_spin_engine_cohort_gate');
    const preflight = block(spin, 'preflight');
    const verify = block(spin, 'verify');
    expect(cohort).toContain("c_required_engine_version constant text := '__SET_AFTER_PUBLISH__'");
    expect(cohort).toContain("c_minimum_cohort_age constant interval := interval '60 seconds'");
    expect(cohort).toContain('FROM public.engine_table_leases l');
    expect(cohort).toContain('FROM public.engine_tournament_leases l');
    expect(preflight).toContain("l.kind IN ('surplus_return','draw_reversal')");
    expect(preflight).toContain('Spin cancellation reconciler cannot retire while');
    expect(spin).toContain(
      'DROP FUNCTION public.fn_ca_return_unawarded_spin_draws(boolean,integer)'
    );
    expect(verify).toContain('fn_ca_return_unawarded_spin_draws(boolean,integer)');
    expect(verify).toContain('a live database routine still calls a retired Spin writer');
  });

  it('treats the seat-release trigger as a stage-one prerequisite, never a stage-two drop', () => {
    const prerequisite = block(bounty, 'cleanup_prerequisites');
    expect(prerequisite).toContain("c.authority='tournament_seat_exit_authority:v1'");
    expect(prerequisite).toContain("c.migration_version='20260909014545'");
    expect(prerequisite).toContain('fn_release_seats_on_tournament_finish()');
    expect(prerequisite).toContain("tg.tgname='trg_release_seats_on_tournament_finish'");
    expect(bounty).not.toContain('DROP TRIGGER IF EXISTS trg_release_seats_on_tournament_finish');
    expect(bounty).not.toContain(
      'DROP FUNCTION public.fn_release_seats_on_tournament_finish() RESTRICT;'
    );
    expect(block(bounty, 'no_running_backpay')).not.toContain('fnreleaseseatsontournamentfinish');
    expect(block(bounty, 'retire_bounty_rosters')).not.toContain(
      'fn_release_seats_on_tournament_finish'
    );
  });

  it('keeps the terminal-rake zero-debt proof syntactically singular', () => {
    const proof = block(bounty, 'all_terminal_rake_debt_is_zero');
    expect(proof).toContain('SELECT 1 FROM public.rake_records r');
    expect(proof).not.toMatch(
      /SELECT 1 FROM public\.rake_records r\s+SELECT 1 FROM public\.rake_records r/
    );
  });

  it('keeps a service-only read path for satellite hand-for-hand depth', () => {
    expect(eliminations).toContain("'fn_get_tournament_satellite_entitlement_depth'");
    expect(satellite).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_get_tournament_satellite_entitlement_depth('
    );
    expect(satellite).not.toContain(
      'DROP FUNCTION public.fn_get_tournament_satellite_entitlement_depth(uuid)'
    );
    const start = satellite.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_get_tournament_satellite_entitlement_depth('
    );
    const end = satellite.indexOf('$satellite_depth$;', start);
    const depth = satellite.slice(start, end);
    expect(depth).toContain('STABLE');
    expect(depth).toContain('floor(v_pool/v_ticket_cost)::integer');
    expect(depth).toContain('CASE WHEN v_remainder>0 THEN 1 ELSE 0 END');
    expect(depth).not.toContain('fn_materialize_satellite_entitlements_locked');
    expect(depth).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|PERFORM)\b/);
    expect(block(satellite, 'verify_legacy_satellite_door_retired')).toContain(
      'hand-for-hand satellite depth read is absent, mutable or incorrectly exposed'
    );
  });
});
