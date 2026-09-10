/**
 * Stage B expands its private authority schema before it repairs production
 * data, then installs the permanent terminal-break invariant after the repair.
 * Neither boundary may replay or overwrite the newer 034411 postimage, and
 * every Stage-B reservation must sort after the 035435 live ledger head.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const productionPostimageFile =
  '20260910034411_seat_proof_lock_generic_plan_lobby_policy_hashed_and_tick_in.sql';
const spinPostimageFile =
  '20260910034412_spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row.sql';
const settlementLanePostimageFile =
  '20260910035435_the_settlement_lane_is_per_tournament_not_platform_wide.sql';
const expansionFile = '20260910042007_stage_b_forward_authority_expansion.sql';
const repairFile = '20260910042020_stage_b_exact_precondition_repairs.sql';
const invariantFile = '20260910042033_stage_b_terminal_break_invariant.sql';

function migration(file: string): string {
  return readFileSync(resolve(root, 'supabase', 'migrations', file), 'utf8');
}

const productionPostimage = migration(productionPostimageFile);
const productionCode = productionPostimage.replace(/^\s*--.*$/gm, '');
const spinPostimage = migration(spinPostimageFile);
const settlementLanePostimage = migration(settlementLanePostimageFile);
const expansion = migration(expansionFile);
const repair = migration(repairFile);
const invariant = migration(invariantFile);
const forwardBoundaries = `${expansion}\n${invariant}`;
const harness = readFileSync(
  resolve(root, 'scripts/dev/probe-stage-b-forward-chain-pg17.sh'),
  'utf8'
);

function occurrences(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function functionBody(source: string, name: string): string {
  const definition = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const delimiter = 'AS $function$';
  const bodyStart = source.indexOf(delimiter, definition) + delimiter.length;
  const bodyEnd = source.indexOf('$function$;', bodyStart);

  expect(definition, `${name} definition`).toBeGreaterThanOrEqual(0);
  expect(bodyStart, `${name} body`).toBeGreaterThan(delimiter.length - 1);
  expect(bodyEnd, `${name} terminator`).toBeGreaterThan(bodyStart);
  return source.slice(bodyStart, bodyEnd);
}

function dollarBlock(source: string, tag: string): string {
  const delimiter = `$${tag}$`;
  const blockStart = source.indexOf(delimiter);
  const blockEnd = source.indexOf(delimiter, blockStart + delimiter.length);

  expect(blockStart, `${tag} opening delimiter`).toBeGreaterThanOrEqual(0);
  expect(blockEnd, `${tag} closing delimiter`).toBeGreaterThan(blockStart);
  return source.slice(blockStart + delimiter.length, blockEnd);
}

describe('the reserved Stage-B forward authority boundaries stay split', () => {
  it('uses the exact reserved order above the production postimage', () => {
    const versions = [
      productionPostimageFile,
      spinPostimageFile,
      settlementLanePostimageFile,
      expansionFile,
      repairFile,
      invariantFile,
    ].map((file) => file.slice(0, 14));

    expect(versions).toEqual([...versions].sort());
    expect(expansion).toContain('-- 20260910042007_stage_b_forward_authority_expansion');
    expect(invariant).toContain('-- 20260910042033_stage_b_terminal_break_invariant');
    expect(spinPostimage).toContain(
      '-- 20260910034412_spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row.sql'
    );
    expect(settlementLanePostimage).toContain('v_done <> 30');
  });

  it('expands only the private schema and binds repair rows to the exact #2 boundary', () => {
    expect(expansion.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(expansion.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(occurrences(expansion, /^CREATE TABLE public\./gm)).toBe(8);
    expect(expansion).toContain(
      "migration_version='20260910042020_stage_b_exact_precondition_repairs'"
    );
    expect(expansion).toContain(
      "normalization_version = '20260910042020_stage_b_exact_precondition_repairs'"
    );
    expect(expansion).toContain(
      "migration_version='20260910042112_stage_b_current_postimage_contraction'"
    );

    for (const relation of [
      'tournament_seat_exit_authority_cutover',
      'tournament_pending_zero_seat_cutover_receipts',
      'tournament_paid_candidate_cutover_receipts',
      'tournament_positive_orphan_cutover_receipts',
      'tournament_seat_exit_authorizations',
      'tournament_seat_move_receipts',
      'tournament_mutator_scheduler_retirement_receipts',
      'tournament_terminal_break_normalization_receipts',
    ]) {
      expect(expansion).toContain(`CREATE TABLE public.${relation}`);
    }

    expect(expansion).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(expansion).not.toMatch(/\bUPDATE\s+public\./i);
    expect(expansion).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(expansion).not.toContain(
      'CREATE FUNCTION public.fn_ca_open_tournament_seat_exit_authority'
    );
    expect(expansion).not.toContain(
      'CREATE FUNCTION public.fn_guard_terminal_tournament_break_state'
    );
    expect(expansion).not.toContain('ALTER TABLE public.tournaments');
    expect(expansion).toContain('Stage-B schema expansion unexpectedly wrote relation %');
  });

  it('admits only the authenticated transaction-local terminal-break normalization', () => {
    const guardHash = '8861ea6a0b6af900b806c20cf09db699';
    const repairVersion = '20260910042020_stage_b_exact_precondition_repairs';
    const authenticate = dollarBlock(
      repair,
      'authenticate_receipted_tournament_immutability_guard'
    );
    const temporaryGuard = dollarBlock(repair, 'stage_b_terminal_break_normalization_guard');
    const normalize = dollarBlock(repair, 'normalize_terminal_break_residue');
    const verifyRestored = dollarBlock(
      repair,
      'verify_receipted_tournament_immutability_guard_restored'
    );

    expect(authenticate).toContain(`md5(p.prosrc)='${guardHash}'`);
    expect(verifyRestored).toContain(`md5(p.prosrc)='${guardHash}'`);
    expect(occurrences(repair, new RegExp(`md5\\(p\\.prosrc\\)='${guardHash}'`, 'g'))).toBe(2);
    expect(
      createHash('md5')
        .update(functionBody(repair, 'fn_receipted_tournament_is_immutable'))
        .digest('hex')
    ).toBe(guardHash);

    expect(repair).not.toMatch(/\bDISABLE\s+TRIGGER\b/i);
    expect(repair).not.toMatch(/\bDROP\s+TRIGGER\b/i);

    expect(temporaryGuard).toContain(
      `current_setting(\n             'app.stage_b_terminal_break_normalization',true\n           )='${repairVersion}'`
    );
    expect(normalize).toContain(
      `PERFORM set_config(\n    'app.stage_b_terminal_break_normalization',\n    '${repairVersion}',true);`
    );
    expect(normalize).toContain(
      "PERFORM set_config('app.stage_b_terminal_break_normalization','',true);"
    );
    expect(normalize).not.toMatch(/set_config\([^;]*?,\s*false\s*\);/i);

    expect(temporaryGuard).toContain(
      "to_jsonb(NEW)-ARRAY[\n           'on_break','break_started_at','break_ends_at','updated_at'\n         ]::text[]"
    );
    expect(temporaryGuard).toContain(
      "to_jsonb(OLD)-ARRAY[\n           'on_break','break_started_at','break_ends_at','updated_at'\n         ]::text[]"
    );
    expect(temporaryGuard).toContain(
      'FROM public.tournament_terminal_break_normalization_receipts r'
    );
    expect(temporaryGuard).toContain(
      `r.normalization_version=\n                  '${repairVersion}'`
    );
    expect(temporaryGuard).toContain("r.terminal_status=upper(COALESCE(OLD.status::text,''))");
    expect(temporaryGuard).toContain(
      'r.on_break_before IS NOT DISTINCT FROM\n                  COALESCE(OLD.on_break,false)'
    );
    expect(temporaryGuard).toContain(
      'r.break_started_at_before IS NOT DISTINCT FROM\n                  OLD.break_started_at'
    );
    expect(temporaryGuard).toContain(
      'r.break_ends_at_before IS NOT DISTINCT FROM OLD.break_ends_at'
    );

    const updateStart = normalize.indexOf('UPDATE public.tournaments t');
    const updateEnd = normalize.indexOf('GET DIAGNOSTICS v_updated=ROW_COUNT;', updateStart);
    expect(updateStart, 'terminal-break normalization UPDATE').toBeGreaterThanOrEqual(0);
    expect(updateEnd, 'terminal-break normalization row count').toBeGreaterThan(updateStart);
    const update = normalize.slice(updateStart, updateEnd);
    const setStart = update.indexOf('SET ');
    const setEnd = update.indexOf('\n    FROM ', setStart);
    expect(setStart, 'terminal-break normalization SET').toBeGreaterThanOrEqual(0);
    expect(setEnd, 'terminal-break normalization FROM').toBeGreaterThan(setStart);
    const assignments = [
      ...update.slice(setStart, setEnd).matchAll(/(?:SET|,)\s*([a-z_]+)\s*=/g),
    ].map((match) => match[1]);
    expect(assignments).toEqual(['on_break', 'break_started_at', 'break_ends_at', 'updated_at']);
    expect(update).toContain('SET on_break=false');
    expect(update).toContain('break_started_at=NULL');
    expect(update).toContain('break_ends_at=NULL');
    expect(update).toContain('updated_at=GREATEST(t.updated_at,transaction_timestamp())');
    expect(update).toContain('t.id=r.tournament_id');
    expect(update).toContain('upper(t.status::text)=r.terminal_status');
    expect(update).toContain('COALESCE(t.on_break,false) IS NOT DISTINCT FROM r.on_break_before');
    expect(update).toContain('t.break_started_at IS NOT DISTINCT FROM r.break_started_at_before');
    expect(update).toContain('t.break_ends_at IS NOT DISTINCT FROM r.break_ends_at_before');

    const temporaryDefinition = repair.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_receipted_tournament_is_immutable()'
    );
    const normalization = repair.indexOf('DO $normalize_terminal_break_residue$');
    const restoredDefinition = repair.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_receipted_tournament_is_immutable()',
      temporaryDefinition + 1
    );
    const restoredVerification = repair.indexOf(
      'DO $verify_receipted_tournament_immutability_guard_restored$'
    );
    const missingFinishClaim = repair.indexOf('DO $repair_unique_missing_atomic_finish_claim$');

    expect(temporaryDefinition).toBeGreaterThanOrEqual(0);
    expect(normalization).toBeGreaterThan(temporaryDefinition);
    expect(restoredDefinition).toBeGreaterThan(normalization);
    expect(restoredVerification).toBeGreaterThan(restoredDefinition);
    expect(missingFinishClaim).toBeGreaterThan(restoredVerification);
    expect(
      occurrences(
        repair,
        /CREATE OR REPLACE FUNCTION public\.fn_receipted_tournament_is_immutable\(\)/g
      )
    ).toBe(2);
  });

  it('installs the permanent invariant only after the exact repair cohort', () => {
    expect(repair).toContain('LOCK TABLE public.tournament_obligations IN SHARE MODE;');
    expect(repair).not.toContain('tournament_place_obligations');

    expect(invariant.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(invariant.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(invariant).toContain('DO $require_repaired_terminal_break_postimage$');
    expect(invariant).toContain(
      "normalization_version <>\n             '20260910042020_stage_b_exact_precondition_repairs'"
    );
    expect(invariant).toContain('NOT v_database_is_pristine AND v_receipt_count = 0');
    expect(invariant).not.toContain('v_receipt_count <> 1308');
    expect(invariant).toContain('r.on_break_before');
    expect(invariant).toContain('r.break_started_at_before IS NOT NULL');
    expect(invariant).toContain('r.break_ends_at_before IS NOT NULL');
    expect(invariant).toContain('upper(t.status::text) IS DISTINCT FROM r.terminal_status');
    expect(invariant).toContain('terminal break invariant found uncaptured terminal break residue');
    expect(invariant).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(invariant).not.toMatch(
      /INSERT\s+INTO\s+public\.tournament_terminal_break_normalization_receipts/i
    );
    expect(invariant).not.toMatch(/UPDATE\s+public\.tournaments\s+(?:t\s+)?SET/i);

    expect(invariant).toContain(
      'CREATE FUNCTION public.fn_guard_terminal_tournament_break_state()'
    );
    expect(invariant).toContain("upper(OLD.status::text) IN ('COMPLETED','CANCELLED')");
    expect(invariant).toContain("USING ERRCODE='check_violation'");
    expect(invariant).toContain('NEW.on_break := false;');
    expect(invariant).toContain('CREATE TRIGGER aaa_guard_terminal_tournament_break_state');
    expect(invariant).toContain('tournaments_terminal_break_state_is_clear');
    expect(invariant).toMatch(
      /ADD CONSTRAINT tournaments_terminal_break_state_is_clear[\s\S]*?NOT VALID;[\s\S]*?VALIDATE CONSTRAINT tournaments_terminal_break_state_is_clear;/
    );

    expect(invariant).toContain(
      'CREATE FUNCTION smarter_private.fn_tournament_finish_readiness_for_terminal_candidate('
    );
    expect(invariant).toContain("failure.value->>'code'='terminal_break_flag_set'");
    expect(invariant).toContain('OLD.status::text');
    expect(invariant).toContain('NEW.break_ends_at');
    expect(invariant).toContain('finish-certificate readiness call is not unique');
    expect(invariant).toContain('REVOKE ALL ON FUNCTION');
  });
});

describe('Stage B preserves the 034411 production postimage', () => {
  it('pins the seven current-postimage statements semantically', () => {
    expect(occurrences(productionPostimage, /CREATE OR REPLACE FUNCTION/g)).toBe(2);
    expect(occurrences(productionCode, /ALTER POLICY poker_arena_tournament_access/g)).toBe(1);
    expect(occurrences(productionPostimage, /^CREATE INDEX IF NOT EXISTS/gm)).toBe(4);
    expect(occurrences(productionPostimage, /^CREATE INDEX CONCURRENTLY IF NOT EXISTS/gm)).toBe(0);
    expect(productionPostimage.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(productionPostimage.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(productionPostimage.indexOf('BEGIN;')).toBeLessThan(
      productionPostimage.indexOf('CREATE OR REPLACE FUNCTION')
    );
    expect(productionPostimage.indexOf('COMMIT;')).toBeLessThan(
      productionPostimage.indexOf('CREATE INDEX IF NOT EXISTS idx_tournaments_updated_at')
    );
    expect(
      createHash('md5')
        .update(functionBody(productionPostimage, 'trg_lock_and_validate_tournament_live_seat'))
        .digest('hex')
    ).toBe('27e86e2b51bb6cfb17c13569c8870f10');
    expect(
      createHash('md5')
        .update(functionBody(productionPostimage, 'fn_active_maintenance_release_boundary'))
        .digest('hex')
    ).toBe('9e66fb8c6cbecfa67fb91a924723a797');

    expect(productionPostimage).toContain('NEW.table_id IS NOT DISTINCT FROM OLD.table_id');
    expect(productionPostimage).toContain(
      '(t.id = v_old_tournament_id OR t.id = v_new_tournament_id)'
    );
    expect(productionCode).not.toContain('t.id = ANY(v_ids)');
    expect(productionPostimage).toContain(
      'FROM public.fn_lock_tournament_launch_proof_parents(v_ids)'
    );
    expect(productionPostimage).toContain("p.status IN ('registered', 'playing')");
    expect(productionPostimage).toContain("USING ERRCODE = '23514'");

    expect(productionPostimage).toContain('OFFSET 0) t');
    expect(productionPostimage).toContain('t.shifted ?& c_required_steps');
    expect(productionPostimage).toContain('COALESCE(union_id, club_id) IN (');
    expect(productionCode).not.toContain('fn_poker_can_read_games(COALESCE(union_id, club_id))');
    expect(productionPostimage).toMatch(
      /idx_cash_seat_moves_cancelled_player[\s\S]*?\(player_id, created_at\)[\s\S]*?state = 'cancelled'/
    );
    expect(productionPostimage).toMatch(
      /idx_tables_cluster_open[\s\S]*?\(cluster_id, role, main_index, created_at\)[\s\S]*?lifecycle <> 'closed'/
    );
    expect(productionPostimage).toMatch(
      /idx_tables_cluster_closed_status_drift[\s\S]*?lifecycle = 'closed' AND status <> 'closed'/
    );
    expect(productionPostimage).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_tournaments_updated_at[\s\S]*?\(updated_at DESC\)/
    );
  });

  it('forbids both forward boundaries from replacing or retiring 034411 objects', () => {
    for (const fn of [
      'trg_lock_and_validate_tournament_live_seat',
      'fn_active_maintenance_release_boundary',
    ]) {
      expect(forwardBoundaries).not.toMatch(
        new RegExp(`(?:CREATE(?: OR REPLACE)?|DROP) FUNCTION public\\.${fn}\\(`)
      );
    }

    expect(forwardBoundaries).not.toMatch(/(?:ALTER|DROP) POLICY poker_arena_tournament_access/);
    for (const index of [
      'idx_cash_seat_moves_cancelled_player',
      'idx_tables_cluster_open',
      'idx_tables_cluster_closed_status_drift',
      'idx_tournaments_updated_at',
    ]) {
      expect(forwardBoundaries).not.toMatch(
        new RegExp(`(?:ALTER|DROP|REINDEX) INDEX(?: IF EXISTS)? ${index}`)
      );
    }
    expect(forwardBoundaries).not.toMatch(
      /(?:DROP TRIGGER|DISABLE TRIGGER) aa_tournament_live_seat_proof_lock/
    );
  });
});

describe('the Stage-B rehearsal emits literal psql meta-commands', () => {
  it('passes backslash commands as printf data instead of an escape-bearing format', () => {
    const start = harness.indexOf('run_chain_prefix() {');
    const end = harness.indexOf('\nkeyshare_postimage_fingerprint() {', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const runner = harness.slice(start, end);

    expect(runner).not.toContain('printf "\\\\echo');
    expect(runner).not.toContain('printf "\\\\ir');
    expect(runner).not.toContain('\u001b');
    expect(runner.match(/printf '%s\\n' "\\\\echo APPLYING/g)).toHaveLength(1);
    expect(runner.match(/printf '%s\\n' "\\\\echo REPLAYING/g)).toHaveLength(1);
    expect(runner.match(/printf '%s\\n' "\\\\ir /g)).toHaveLength(2);
    expect(harness).not.toContain('ind.oid');
    expect(harness.match(/CASE WHEN idx\.oid IS NULL THEN NULL/g)).toHaveLength(3);
  });
});
