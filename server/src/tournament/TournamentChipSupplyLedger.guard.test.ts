import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(process.cwd(), '..');
const readRepo = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');
const migrationNames = readdirSync(join(repoRoot, 'supabase/migrations')).filter(
  (name) =>
    name.endsWith('_tournament_chip_supply_is_an_immutable_conserved_ledger.sql') ||
    name.endsWith('_tournament_chip_supply_is_an_immutable_conserved_ledger.sql.pending')
);
if (migrationNames.length !== 1) {
  throw new Error(`Expected one tournament chip-supply migration, found ${migrationNames.length}`);
}
const sealMigrationNames = readdirSync(join(repoRoot, 'supabase/migrations')).filter((name) =>
  name.endsWith('_tournament_chip_supply_rpc_names_are_sealed_until_activation.sql')
);
if (sealMigrationNames.length !== 1) {
  throw new Error(
    `Expected one tournament chip-supply RPC seal migration, found ${sealMigrationNames.length}`
  );
}
const versionSealMigrationNames = readdirSync(join(repoRoot, 'supabase/migrations')).filter(
  (name) => name.endsWith('_tournament_launch_supply_version_zero_is_explicit.sql')
);
if (versionSealMigrationNames.length !== 1) {
  throw new Error(
    `Expected one tournament launch supply-version seal, found ${versionSealMigrationNames.length}`
  );
}
const migration = readRepo(`supabase/migrations/${migrationNames[0]}`);
const sealMigration = readRepo(`supabase/migrations/${sealMigrationNames[0]}`);
const versionSealMigration = readRepo(`supabase/migrations/${versionSealMigrationNames[0]}`);
const fixture = readRepo('scripts/dev/fixtures/tournament-chip-supply-ledger-pg17-bootstrap.sql');
const runtimeProbe = readRepo('scripts/dev/probe-tournament-chip-supply-ledger-pg17.sql');
const harness = readRepo('scripts/dev/probe-tournament-chip-supply-ledger-pg17.sh');
const activationRunbook = readRepo('docs/runbooks/tournament-fractional-stack-cutover.md');

describe('tournament chip supply is one immutable conserved ledger', () => {
  it('publishes an explicit zero-only supply version without activating the ledger', () => {
    expect(versionSealMigrationNames[0].localeCompare(sealMigrationNames[0])).toBeGreaterThan(0);
    expect(versionSealMigration).toContain(
      'ADD COLUMN IF NOT EXISTS supply_version smallint NOT NULL DEFAULT 0'
    );
    expect(versionSealMigration).toContain('CHECK (supply_version = 0) NOT VALID');
    expect(versionSealMigration).toContain(
      'VALIDATE CONSTRAINT tournament_launch_receipts_supply_version_check'
    );
    expect(versionSealMigration).toContain('WHERE supply_version IS DISTINCT FROM 0');
    expect(versionSealMigration).not.toContain('ALTER COLUMN supply_version SET DEFAULT 1');
    expect(versionSealMigration).not.toContain('GRANT ');
    expect(versionSealMigration).not.toContain('CREATE TRIGGER');
    expect(versionSealMigration).not.toContain('cron.');
    expect(versionSealMigration).not.toContain('supply_roster_count');

    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS tournament_launch_receipts_supply_version_check'
    );
    expect(migration).toContain('CHECK (supply_version IN (0, 1)) NOT VALID');
    expect(migration).toContain('ALTER COLUMN supply_version SET DEFAULT 1');
  });

  it('publishes fail-closed RPC signatures before the capable caller can ship', () => {
    expect(sealMigrationNames[0].localeCompare(migrationNames[0])).toBeLessThan(0);
    for (const signature of [
      'fn_issue_tournament_launch_stacks(',
      'fn_materialize_tournament_launch_seats(',
      'fn_project_tournament_launch_seat_stacks(',
    ]) {
      expect(sealMigration).toContain(`CREATE FUNCTION public.${signature}`);
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${signature}`);
    }
    expect(sealMigration).toContain('TOURNAMENT_CHIP_SUPPLY_NOT_ACTIVE');
    expect(sealMigration).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(sealMigration).toContain("p.prorettype = 'jsonb'::regtype");
    expect(sealMigration).toContain("p.proconfig @> ARRAY['search_path=public, pg_temp']");
    expect(sealMigration).not.toContain('GRANT EXECUTE');
    expect(sealMigration).not.toContain('rpc/fn_issue_tournament_launch_stacks');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_issue_tournament_launch_stacks('
    );
  });

  it('versions only new entry generations and never invents a legacy backfill', () => {
    expect(migration).toContain('chip_supply_generation uuid DEFAULT gen_random_uuid()');
    expect(migration).toContain('Existing\n-- generations are deliberately NOT reconstructed');
    expect(migration).toContain('NEW.supply_version := 0');
    expect(migration).toContain('NEW.supply_version := 1');
    expect(migration).toContain("'legacy_supply_unversioned'");
    expect(fixture).toContain("'Legacy Supply', 'REGISTERING'");
    expect(runtimeProbe).toContain('legacy completion shape drifted');
    expect(runtimeProbe).toContain('re-registration reused a closed supply generation');
  });

  it('keeps supply facts private, semantically unique and append-only', () => {
    expect(migration).toContain('CREATE TABLE public.tournament_chip_supply_events');
    expect(migration).toContain('UNIQUE (tournament_id, semantic_key)');
    expect(migration).toContain('tournament_chip_supply_events_generation_idx');
    expect(migration).toContain('tournament_chip_supply_events_one_open_idx');
    expect(migration).toContain('tournament_chip_supply_events_one_close_idx');
    expect(migration).toContain("event_kind = 'entry_opened' AND amount_delta = 0");
    expect(migration).toContain("event_kind = 'entry_closed'");
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE public.tournament_chip_supply_events');
    expect(migration).toContain("RAISE EXCEPTION 'tournament chip supply events are append-only'");
    expect(migration).toContain('CREATE TRIGGER tournament_chip_supply_event_insert_is_valid');
    expect(migration).toContain('TOURNAMENT_CHIP_SUPPLY_EVENT_AFTER_CLOSE');
    expect(migration).toContain('TOURNAMENT_CHIP_SUPPLY_CLOSE_DELTA_MISMATCH');
    expect(migration).toContain('TOURNAMENT_CHIP_SUPPLY_ZERO_CLOSE_REQUIRES_UNISSUED_ENTRY');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.trg_validate_tournament_chip_supply_event_insert()'
    );
    expect(runtimeProbe).toContain('browser or service roles retained chip-supply table DML');
    expect(runtimeProbe).toContain("'append-only'");
    expect(runtimeProbe).toContain('refused close delta mutated immutable supply history');
    expect(runtimeProbe).toContain(
      'zero close was not limited to one deliberately unissued generation'
    );
  });

  it('dual-writes every issuance and prestart reversal in the source transaction', () => {
    for (const event of [
      "'entry_opened'",
      "'registration_bonus'",
      "'initial_stack'",
      "'rebuy'",
      "'reentry'",
      "'addon'",
      "'entry_closed'",
    ]) {
      expect(migration).toContain(event);
    }
    expect(migration).toContain("'process_tournament_rebuy'");
    expect(migration).toContain('TOURNAMENT_CHIP_SUPPLY_REENTRY_REQUIRES_EXACT_ZERO');
    expect(migration).toContain('TOURNAMENT_CHIP_SUPPLY_REENTRY_GENERATION_UNPROVEN');
    expect(migration).toContain('CREATE TRIGGER ay_close_tournament_chip_supply_on_cancel');
    expect(migration).toContain('TOURNAMENT_CHIP_SUPPLY_CANCEL_HISTORY_CORRUPT');
    expect(migration).toContain('TOURNAMENT_CHIP_SUPPLY_CANCEL_NOT_CONSERVED');
    expect(migration).toContain('fn_append_tournament_chip_supply_event(');
    expect(migration).toContain('$patch_human_seat_first_supply_lock_order$');
    expect(migration).toContain('$patch_late_registration_supply_lock_order$');
    expect(migration).toContain('$patch_seat_leave_supply_lock_order$');
    expect(migration).toContain('TOURNAMENT_CHIP_SUPPLY_PARENT_FIRST');
    expect(migration).toContain(
      'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'
    );
    expect(migration).toContain("count(*) FILTER (WHERE e.event_kind = 'entry_closed') = 0");
    expect(migration).toContain('JOIN public.hand_atomic_commits h');
    expect(migration).toContain('s.id = c.seat_id');
    expect(migration).toContain('s.joined_at = c.seat_joined_at');
    expect(migration).toContain('c.hand_number >= 1000000');
    expect(migration).toContain('THEN tp.chips + v_stack');
    expect(runtimeProbe).toContain('canonical purchase supply drifted');
    expect(runtimeProbe).toContain('prestart unregister did not reverse exact issued supply');
    expect(runtimeProbe).toContain(
      'seat-leave or cancellation did not reverse its exact supply generation'
    );
    expect(runtimeProbe).toContain(
      'forced refund failure did not roll back wallet, player, cancellation and supply closes'
    );
    expect(runtimeProbe).toContain(
      'midgame cancellation did not close every still-open supply generation'
    );
    expect(runtimeProbe).toContain('seat-first path erased a registration bonus');
  });

  it('exposes one exact manager-only issue, materialize and Spin projection protocol', () => {
    for (const signature of [
      'fn_issue_tournament_launch_stacks(',
      'fn_materialize_tournament_launch_seats(',
      'fn_project_tournament_launch_seat_stacks(',
    ]) {
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${signature}`);
    }
    for (const key of [
      "'supply_version', 1",
      "'issued_chips', v_issued",
      "'roster_chips', v_roster",
      "'felt_chips', v_felt",
      "'players', v_players",
    ]) {
      expect(migration).toContain(key);
    }
    expect(migration).toContain("'tables', v_tables");
    expect(migration).toContain("'stacks_deferred', v_deferred");
    expect(migration).toContain("'created_projection_count', v_created");
    expect(migration).toContain("interval '14.8 seconds'");
    expect(migration).toContain('SET current_players = (');
    expect(runtimeProbe).toContain('non-Spin exact completion drifted');
    expect(runtimeProbe).toContain('Spin materialization leaked supply early');
    expect(runtimeProbe).toContain('Spin projection replay was not idempotent');
  });

  it('routes all three mutations through exact protocol-2 lease fencing', () => {
    const issue = migration.indexOf("'rpc/fn_issue_tournament_launch_stacks'");
    const materialize = migration.indexOf("'rpc/fn_materialize_tournament_launch_seats'");
    const project = migration.indexOf("'rpc/fn_project_tournament_launch_seat_stacks'");
    const servicePaths = migration.indexOf("'rpc/fn_decline_tournament_rebuy'", issue);
    expect(issue).toBeGreaterThan(-1);
    expect(materialize).toBeGreaterThan(issue);
    expect(project).toBeGreaterThan(materialize);
    expect(servicePaths).toBeGreaterThan(project);
    expect(migration).toContain('fn_assert_tournament_manager_write_scope(p_tournament_id)');
    expect(migration).toContain('v_current_generation IS DISTINCT FROM p_lease_generation');
    expect(migration).toContain("v_heartbeat_at < clock_timestamp() - interval '30 seconds'");
    expect(runtimeProbe).toContain('TOURNAMENT_MANAGER_AUTHORITY_REQUIRED');
    expect(runtimeProbe).toContain('DATA_ACTOR_INVALID');
    expect(runtimeProbe).toContain('TOURNAMENT_MANAGER_FENCED');
    expect(runtimeProbe).toContain('TOURNAMENT_MANAGER_SCOPE_VIOLATION');
  });

  it('fails closed on roster, coordinate, collision, deal and exact-total drift', () => {
    for (const marker of [
      'TOURNAMENT_LAUNCH_SUPPLY_ROSTER_CHANGED',
      'TOURNAMENT_LAUNCH_SUPPLY_ALREADY_DEALT',
      'TOURNAMENT_LAUNCH_SEAT_ASSIGNMENT_SET_MISMATCH',
      'TOURNAMENT_LAUNCH_SEAT_EXISTING_OWNERSHIP_MISMATCH',
      'TOURNAMENT_LAUNCH_SEAT_TARGET_OCCUPIED',
      'TOURNAMENT_LAUNCH_SUPPLY_ISSUANCE_NOT_CONSERVED',
      'TOURNAMENT_LAUNCH_SEAT_MATERIALIZATION_NOT_CONSERVED',
      'launch_supply_not_conserved',
    ]) {
      expect(migration).toContain(marker);
    }
    expect(runtimeProbe).toContain('collision refusal left a partial materialization');
    expect(runtimeProbe).toContain('materialization replay drifted');
  });

  it('removes the timer repair and ships an executable PostgreSQL 17 proof', () => {
    expect(migration).toContain('jobname = $1 ORDER BY jobid');
    expect(migration).toContain("USING 'credit-stalled-seat-first-stacks'");
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.fn_credit_stalled_seat_first_stacks() RESTRICT'
    );
    expect(harness).toContain('postgresql@17');
    expect(harness).toContain('resolve_staged_or_promoted_migration');
    expect(harness).toContain("-c listen_addresses='' -k ${socket_dir}");
    expect(harness).toContain('pg_exec -f "$seal_migration"');
    expect(harness.indexOf('pg_exec -f "$seal_migration"')).toBeLessThan(
      harness.indexOf('pg_exec -f "$migration"')
    );
    expect(harness).toContain('TOURNAMENT_CHIP_SUPPLY_LEDGER_PG17_OK');
    expect(harness).toContain('CHIP_SUPPLY_RACE_POSITIVE_FIRST');
    expect(harness).toContain('CHIP_SUPPLY_RACE_CANCEL_FIRST');
    expect(harness).toContain('CHIP_SUPPLY_PARENT_FIRST_CANCEL');
    expect(harness).toContain('CHIP_SUPPLY_PARENT_FIRST_SEAT_WRITER');
    expect(harness).toContain('FOR UPDATE NOWAIT');
    expect(harness).toContain('TOURNAMENT_CHIP_SUPPLY_LEDGER_RACE_PG17_OK');
    expect(harness).toContain(
      'positive-first cancellation did not close the committed issuance exactly'
    );
    expect(harness).toContain('cancel-first race admitted or stranded post-close issuance');
    expect(harness).toContain(
      'parent-first seat writer mutated a child or supply after cancellation'
    );
    expect(harness).toContain('TOURNAMENT_CHIP_SUPPLY_LEDGER_PG17_VERIFIED');
    expect(runtimeProbe).toContain("'TOURNAMENT_CHIP_SUPPLY_LEDGER_PG17_OK'");
    expect(activationRunbook).toContain('ledger-assigned activation version');
    expect(activationRunbook).toContain(
      'The normalization receipt must sort before the activation receipt'
    );
  });
});
