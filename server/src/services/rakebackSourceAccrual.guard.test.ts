/**
 * Static financial-contract guard for the source-transaction rakeback cutover.
 * PostgreSQL 17 behavior (rollback, races, and cent conservation) is exercised
 * by scripts/ci/probes/rakeback-source-accrual/run-pg17.sh.
 */
import { describe, expect, it } from 'vitest';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(process.cwd(), '..');
const migrationName = 'rakeback_accrues_atomically_with_its_source';
const migrationDir = resolve(repoRoot, 'supabase/migrations');
const migrationCandidates = readdirSync(migrationDir).filter((file) =>
  new RegExp(`^[0-9]{14}_${migrationName}\\.sql(?:\\.pending)?$`).test(file)
);
if (migrationCandidates.length !== 1) {
  throw new Error(
    `expected exactly one staged-or-promoted ${migrationName} migration; found ${migrationCandidates.length}`
  );
}
const migrationPath = resolve(migrationDir, migrationCandidates[0]);
const migrationStat = lstatSync(migrationPath);
if (!migrationStat.isFile() || migrationStat.isSymbolicLink()) {
  throw new Error(`migration must be a regular non-symlink file: ${migrationPath}`);
}
const probeDir = resolve(repoRoot, 'scripts/ci/probes/rakeback-source-accrual');
const resolverPath = resolve(repoRoot, 'scripts/ops/lib/resolve-staged-or-promoted-migration.sh');
const runbookPath = resolve(repoRoot, 'docs/runbooks/rakeback-source-accrual-cutover.md');
const preapplyPath = resolve(repoRoot, 'scripts/ops/verify-rakeback-source-accrual-preapply.sql');
const sql = readFileSync(migrationPath, 'utf8');
const assertions = readFileSync(resolve(probeDir, 'assertions.sql'), 'utf8');
const productionProbe = readFileSync(resolve(probeDir, 'production-readonly.sql'), 'utf8');
const probeRunner = readFileSync(resolve(probeDir, 'run-pg17.sh'), 'utf8');
const migrationResolver = readFileSync(resolverPath, 'utf8');
const runbook = readFileSync(runbookPath, 'utf8');
const preapply = readFileSync(preapplyPath, 'utf8');

function functionBody(name: string): string {
  const declaration = `CREATE OR REPLACE FUNCTION public.${name}`;
  const start = sql.indexOf(declaration);
  expect(start, `${name} declaration`).toBeGreaterThanOrEqual(0);
  const bodyStart = sql.indexOf('AS $function$', start);
  expect(bodyStart, `${name} body start`).toBeGreaterThan(start);
  const bodyEnd = sql.indexOf('$function$;', bodyStart + 'AS $function$'.length);
  expect(bodyEnd, `${name} body end`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, bodyEnd);
}

const immutableTables = {
  rakeback_basis_epoch: 'trg_rakeback_epoch_is_immutable',
  rakeback_cutover_daily_user: 'trg_rakeback_cutover_user_is_immutable',
  rakeback_cutover_daily_state: 'trg_rakeback_cutover_state_is_immutable',
  rakeback_cutover_source_records: 'trg_rakeback_cutover_source_is_immutable',
  rakeback_accrual_records: 'trg_rakeback_accrual_record_is_immutable',
  rakeback_accrual_receipts: 'trg_rakeback_accrual_receipt_is_immutable',
  rakeback_accrual_reversals: 'trg_rakeback_accrual_reversal_is_immutable',
  rakeback_accrual_reversal_receipts: 'trg_rakeback_accrual_reversal_receipt_is_immutable',
  rakeback_compensation_records: 'trg_rakeback_compensation_record_is_immutable',
  rakeback_compensation_links: 'trg_rakeback_compensation_link_is_immutable',
  rakeback_closed_period_offsets: 'trg_rakeback_closed_period_offset_is_immutable',
  rakeback_period_carries: 'trg_rakeback_period_carry_is_immutable',
  rakeback_source_relinks: 'trg_rakeback_source_relink_is_immutable',
  rakeback_source_supersessions: 'trg_rakeback_source_supersession_is_immutable',
} as const;

describe('rakeback accrues with its source transaction', () => {
  it('has one staged-or-promoted artifact and a receipt-bound stopped-engine cutover', () => {
    expect(migrationCandidates).toHaveLength(1);
    expect(migrationResolver).toContain('Expected exactly one staged-or-promoted');
    expect(probeRunner).toContain('resolve-staged-or-promoted-migration.sh');
    expect(probeRunner).toContain('resolve_staged_or_promoted_migration');
    expect(runbook).toContain('scripts/ops/verify-migration-ledger-artifact.sh');
    expect(runbook).toContain('PREAPPLY');
    expect(runbook).toContain('apply_migration');
    expect(runbook).toContain('APPLIED_VERSION');
    expect(runbook.toLowerCase()).toContain('source-seal');
    expect(runbook).toContain('/var/lock/club-arena-engine-up.lock');
    expect(runbook).toContain('systemctl stop club-arena-supervisor.timer');
    expect(runbook).toContain('docker stop -t 45 club-arena-engine');
    expect(runbook).toContain('scripts/ops/verify-rakeback-source-accrual-preapply.sh');
    expect(runbook).toContain('production-readonly.sql');
    expect(runbook).toContain('ENGINE_UP_LOCK_HELD=1');
    expect(runbook).toContain('unknown outcome');
    expect(preapply).toContain('SET TRANSACTION READ ONLY');
    expect(preapply).toContain('rakeback accrual dependencies changed');
    expect(preapply).toContain('RAKEBACK_PENDING_PERIOD_HAS_PAYOUT_CHILD');
    expect(preapply).toContain('rakeback_cutover_compensation_links');
    expect(preapply).toContain('cutover club-days do not allocate exactly');
    expect(preapply).toContain('RAKEBACK_SOURCE_ACCRUAL_PREAPPLY_OK');
    expect(preapply).toContain('fn_rakeback_lock_period_keys(uuid,date,date,uuid[])');
    expect(preapply).toContain('trg_rakeback_source_delete_is_reversed');
    expect(probeRunner).toContain('rendered-preapply.sql');
    expect(probeRunner).toContain('RAKEBACK_SOURCE_ACCRUAL_PREAPPLY_OK');
    for (const dependencyHash of [
      'b00b5d017cb5a3699038e1bb8896b5d6',
      '2078fb6e89f22704096974ecf933e385',
      '74d61a3e0caf1037f6e6633eff0dd611',
      'f9b2424384371f47f9fba2006a3f646d',
      'd59ea94ab309a36c5d5a1298cbc604d3',
      'a34e26b81ceeda38237b739245ff11f6',
      'b78ca0d8726cc7fce4d66ef6c2030027',
      '0af831a32835021d60f7098e07ce4ad5',
      '708827dbc7fabd0b753d3a7b8596f076',
    ]) {
      expect(sql, dependencyHash).toContain(dependencyHash);
      expect(preapply, dependencyHash).toContain(dependencyHash);
    }
  });

  it('cuts over under one no-gap lock and records exact source membership', () => {
    expect(sql).toMatch(
      /LOCK TABLE public\.rake_records,[\s\S]*?public\.rakeback_daily_user,[\s\S]*?public\.rakeback_daily_state,[\s\S]*?public\.rakeback_periods[\s\S]*?IN SHARE ROW EXCLUSIVE MODE;/
    );
    expect(sql).toContain('CREATE TABLE public.rakeback_basis_epoch');
    expect(sql).toContain('CREATE TABLE public.rakeback_cutover_source_records');
    expect(sql).toContain('rakeback_cutover_expected_daily_user');
    expect(sql).toContain('cutover club-days do not allocate exactly');
    expect(sql).toContain("'cutover_materialized'");
    expect(productionProbe).toContain('LEFT JOIN public.rakeback_cutover_source_records');
    expect(productionProbe).not.toMatch(/\(r\.created_at,\s*r\.id\)\s*(?:<=|<|>=|>)/);
    expect(sql).toContain("'public.fn_tournament_fee_names_its_player()'::regprocedure");
    expect(sql).toContain("'public.fn_player_rakeback_rate(uuid,uuid,numeric)'::regprocedure");
    expect(sql).toContain("t.tgname = 'trg_tournament_fee_names_its_player'");
    expect(sql).toContain("t.tgenabled = 'O'");
    expect(probeRunner).toContain('tournament_attribution_md5');
    expect(probeRunner).toContain('tournament_attribution_trigger_md5');
    expect(probeRunner).toContain('rate_md5');
    expect(assertions).toContain('tournament attribution dependency named only');
  });

  it('writes exact immutable player receipts in the source transaction', () => {
    const body = functionBody('fn_rakeback_accrue_source_record');
    expect(body).toContain('fn_allocate_rake_credits');
    expect(body).toContain('v_allocated_cents IS DISTINCT FROM v_source_cents');
    expect(body).toContain('INSERT INTO public.rakeback_accrual_records');
    expect(body).toContain('INSERT INTO public.rakeback_accrual_receipts');
    expect(body).toContain('INSERT INTO public.rakeback_daily_user');
    expect(body).toContain('INSERT INTO public.rakeback_daily_state');
    expect(body).toContain('fn_rakeback_lock_period_keys');
    const lockPeriods = functionBody('fn_rakeback_lock_period_keys');
    expect(lockPeriods).toContain('ORDER BY p.id');
    expect(lockPeriods.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      lockPeriods.indexOf('ORDER BY p.id')
    );
    expect(sql).toMatch(
      /CREATE TRIGGER trg_rakeback_accrues_with_rake_record\s+AFTER INSERT ON public\.rake_records/
    );
    expect(sql).toMatch(
      /CREATE TRIGGER trg_rakeback_accrues_with_first_attribution[\s\S]*?ON public\.rake_records/
    );
  });

  it('compensates every negative refund and a source DELETE through exact originals', () => {
    const negative = functionBody('fn_rakeback_compensate_source_record');
    const deletion = functionBody('fn_rakeback_reverse_deleted_source_record');
    expect(negative).toContain('INSERT INTO public.rakeback_compensation_records');
    expect(negative).toContain('INSERT INTO public.rakeback_compensation_links');
    expect(negative).toContain('negative_source_compensation');
    expect(negative).toContain('v_linked_cents <> v_negative_cents');
    expect(negative).toContain('fn_rakeback_apply_reversal_basis');
    expect(negative).toContain("(p.created_at AT TIME ZONE 'UTC')::date < e.basis_from_day");
    expect(deletion).toContain('fn_rakeback_materialize_cutover_record');
    expect(deletion).toContain('fn_rakeback_apply_reversal_basis');
    expect(sql).toMatch(
      /CREATE TRIGGER trg_rakeback_compensates_with_negative_record\s+AFTER INSERT ON public\.rake_records/
    );
    expect(sql).toMatch(
      /CREATE TRIGGER trg_rakeback_source_delete_is_reversed\s+BEFORE DELETE ON public\.rake_records/
    );
    for (const route of [
      'fn_unregister_from_tournament',
      'atomic_cancel_tournament',
      'GameServer.cancel_refund',
      'fn_spin_book_entry',
      'fn_join_table_reservation',
    ]) {
      expect(assertions, route).toContain(route);
    }
  });

  it('preserves paid history and carries exact refund debt through open periods', () => {
    const apply = functionBody('fn_rakeback_apply_reversal_basis');
    const carry = functionBody('fn_rakeback_carry_negative_period');
    expect(sql).toContain('CREATE TABLE public.rakeback_closed_period_offsets');
    expect(sql).toContain('CREATE TABLE public.rakeback_period_carries');
    expect(apply).toContain("v_period.status <> 'pending'");
    expect(apply).toContain('INSERT INTO public.rakeback_closed_period_offsets');
    expect(carry).toContain('INSERT INTO public.rakeback_period_carries');
    expect(carry).toContain('-v_cents');
    expect(sql).toContain('OR e.total_rake < 0');
    expect(sql).toContain('PERFORM public.fn_rakeback_lock_period_id(p_period_id)');
    expect(sql).toContain('IF v_rake_total < 0 THEN');
    expect(assertions).toContain('cutover paid refund did not post its current open offset');
    expect(assertions).toContain('pre-cutover paid-origin refund did not commit');
    expect(assertions).toContain('pre-cutover paid original evidence origin');
    expect(assertions).toContain('pre-cutover paid-origin fee deletion did not commit');
    expect(assertions).toContain('pre-cutover paid fee delete offset');
    expect(assertions).toContain('historical low-cent paid delete offset');
    expect(assertions).toContain('paid-origin negative source did not commit');
    expect(assertions).toContain('negative basis carry');
    expect(assertions).toContain('zero-rate refund period');
    expect(assertions).toContain('zero-rate refund carry');
    expect(sql).toContain(
      'DROP CONSTRAINT rakeback_periods_user_id_club_id_period_start_period_end_key'
    );
    expect(sql).toContain('CREATE UNIQUE INDEX rakeback_periods_one_pending_user_club_week_idx');
    expect(sql.match(/ON CONFLICT \(user_id, club_id, period_start\)/g)).toHaveLength(2);
    expect(sql).toContain("WHERE status = 'pending'");
    expect(assertions).toContain('club-scoped paid/pending identity has');
    expect(assertions).toContain('legacy paid period changed');
    expect(assertions).toContain('post-paid pending period is');
    expect(assertions).toContain('legacy duplicate pending projection was not consolidated');
    expect(assertions).toContain('second club period is');
  });

  it('rejects reversed UUID replay and serializes null-hand supersession', () => {
    const accrual = functionBody('fn_rakeback_accrue_source_record');
    const supersede = functionBody('fn_rakeback_supersede_ghost_source');
    expect(accrual).toContain("'rakeback-hand:'");
    expect(accrual).toContain('cannot be reinserted after its source was reversed');
    expect(accrual).toContain('fn_rakeback_supersede_ghost_source');
    expect(accrual).toContain('INSERT INTO public.rakeback_source_supersessions');
    expect(supersede).toContain("'superseded_ghost_twin'");
    expect(supersede).toContain('fn_rakeback_apply_reversal_basis');
    expect(probeRunner).toContain('ghost-race-a.sql');
    expect(probeRunner).toContain('ghost-race-b.sql');
    expect(probeRunner).toContain('ghost-race-assert.sql');
  });

  it('freezes all source provenance except the audited one-time hand relink', () => {
    const sourceGuard = functionBody('fn_rakeback_source_basis_is_immutable');
    const relink = functionBody('fn_rakeback_record_hand_relink');
    const fingerprint = functionBody('fn_rakeback_source_fingerprint');
    for (const field of [
      'id',
      'club_id',
      'table_id',
      'global_hand_id',
      'tournament_id',
      'is_tournament',
      'source',
      'rake_amount',
      'player_contributions',
      'rake_method',
      'created_at',
      'metadata',
    ]) {
      expect(sourceGuard, field).toContain(`NEW.${field} IS DISTINCT FROM OLD.${field}`);
    }
    for (const fingerprintKey of [
      "'hand_id'",
      "'table_id'",
      "'global_hand_id'",
      "'tournament_id'",
      "'is_tournament'",
      "'source'",
      "'source_created_at_epoch_us'",
    ]) {
      expect(fingerprint, fingerprintKey).toContain(fingerprintKey);
    }
    expect(fingerprint).toContain('extract(epoch FROM p_source_created_at)');
    expect(relink).toContain("'historical_source_evidence'");
    expect(relink).toContain('rakeback_source_relinks');
    expect(relink).toContain('was already relinked once');
    expect(assertions).toContain('America/Chicago');
    expect(assertions).toContain('second pre-epoch relink was accepted');
    expect(assertions).toContain('tournament provenance mutation was accepted');
    expect(assertions).toContain('tournament-kind provenance mutation was accepted');
    expect(assertions).toContain('source provenance mutation was accepted');
    expect(assertions).toContain('global hand provenance mutation was accepted');
    expect(assertions).toContain('source primary key mutation was accepted');
    expect(assertions).toContain('direct hand provenance mutation was accepted');
    expect(sql).toMatch(
      /CREATE TRIGGER trg_rakeback_source_basis_is_immutable\s+BEFORE UPDATE OF id,[\s\S]*?global_hand_id/
    );
  });

  it('protects every new financial table with RLS, least privilege, and immutability', () => {
    for (const [table, trigger] of Object.entries(immutableTables)) {
      expect(sql, `${table} RLS`).toContain(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`
      );
      expect(sql, `${table} revoke`).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE public\\.${table}\\s+FROM PUBLIC, anon, authenticated, service_role;`
        )
      );
      expect(sql, `${table} service read`).toContain(
        `GRANT SELECT ON TABLE public.${table} TO service_role;`
      );
      expect(sql, `${table} immutable trigger`).toMatch(
        new RegExp(`CREATE TRIGGER ${trigger}[\\s\\S]*?ON public\\.${table}`)
      );
    }
    expect(sql).not.toMatch(/ON DELETE CASCADE/);
    expect(sql).toContain('DROP POLICY IF EXISTS rakeback_periods_update_own');
    expect(sql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s+ON TABLE public\.rakeback_periods FROM PUBLIC, anon, authenticated;/
    );
    expect(assertions).toContain('browser still has a direct rakeback period mutation door');
    expect(productionProbe).toContain('browser still has a direct rakeback period mutation door');
  });

  it('keeps compatibility projections bounded and exposes no repair writer', () => {
    const day = functionBody('fn_rakeback_recompute_day');
    const periods = functionBody('fn_rakeback_recompute_periods');
    expect(day).not.toContain('rake_records');
    expect(day).not.toMatch(/DELETE\s+FROM\s+(?:public\.)?rakeback_daily_user/i);
    expect(periods).not.toContain('rake_records');
    expect(periods).not.toContain('fn_rakeback_recompute_day');
    expect(periods).toContain('rakeback_daily_user');
    expect(periods).toContain("'days_scanned', 0");
    expect(sql).not.toMatch(/cron\.schedule\s*\(/i);
    for (const triggerFunction of [
      'fn_rakeback_accrue_source_record()',
      'fn_rakeback_compensate_source_record()',
      'fn_rakeback_reverse_deleted_source_record()',
      'fn_rakeback_source_basis_is_immutable()',
      'fn_rakeback_record_hand_relink()',
      'fn_rakeback_receipt_is_immutable()',
    ]) {
      expect(sql, triggerFunction).toContain(`REVOKE ALL ON FUNCTION public.${triggerFunction}`);
      expect(sql, triggerFunction).not.toContain(
        `GRANT EXECUTE ON FUNCTION public.${triggerFunction}`
      );
    }
  });
});
