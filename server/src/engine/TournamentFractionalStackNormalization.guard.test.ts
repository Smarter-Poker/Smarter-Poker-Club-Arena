import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(process.cwd(), '..');
const repoPath = (path: string): string => join(repoRoot, path);
const readRepo = (path: string): string => readFileSync(repoPath(path), 'utf8');

const migrationBasenames = readdirSync(repoPath('supabase/migrations')).filter(
  (name) =>
    name.endsWith('_tournament_fractional_stacks_are_normalized_once.sql') ||
    name.endsWith('_tournament_fractional_stacks_are_normalized_once.sql.pending')
);
if (migrationBasenames.length !== 1) {
  throw new Error(
    `Expected one tournament fractional-stack normalization migration, found ${migrationBasenames.length}`
  );
}
const migrationBasename = migrationBasenames[0];
const atomicMoveBasenames = readdirSync(repoPath('supabase/migrations')).filter((name) =>
  name.endsWith('_tournament_seat_moves_are_one_atomic_receipt.sql')
);
if (atomicMoveBasenames.length !== 1) {
  throw new Error(
    `Expected one atomic tournament-seat move migration, found ${atomicMoveBasenames.length}`
  );
}
const atomicMoveBasename = atomicMoveBasenames[0];
const atomicMoveMigration = readRepo(`supabase/migrations/${atomicMoveBasename}`);
const filename = `supabase/migrations/${migrationBasename}`;
const migration = readRepo(filename);
const receiptFilename = `${filename}.receipt`;
const materializer = readRepo('scripts/ops/materialize-tournament-fractional-stack-cutover.awk');
const privateDirectoryHelper = readRepo('scripts/ops/lib/require-private-cutover-directory.sh');
const migrationResolver = readRepo('scripts/ops/lib/resolve-staged-or-promoted-migration.sh');
const renderer = readRepo('scripts/ops/render-tournament-fractional-stack-cutover.sh');
const verifier = readRepo('scripts/ops/verify-tournament-fractional-stack-cutover-artifact.sh');
const ledgerVerifier = readRepo(
  'scripts/ops/verify-tournament-fractional-stack-cutover-ledger.sql'
);
const genericLedgerVerifier = readRepo('scripts/ops/verify-migration-ledger-artifact.sh');
const postconditionVerifier = readRepo(
  'scripts/ops/verify-tournament-fractional-stack-cutover-postconditions.sh'
);
const postconditionQuery = readRepo(
  'scripts/ops/verify-tournament-fractional-stack-cutover-postconditions.sql'
);
const zeroAuthorityVerifier = readRepo(
  'scripts/ops/verify-tournament-fractional-stack-zero-authority.sh'
);
const runbook = readRepo('docs/runbooks/tournament-fractional-stack-cutover.md');
const fixture = readRepo(
  'scripts/dev/fixtures/tournament-fractional-stack-normalization-pg17-bootstrap.sql'
);
const measurement = readRepo('scripts/dev/probe-tournament-fractional-stack-measurement-pg17.sql');
const cutoverMeasurement = readRepo('scripts/ops/measure-tournament-fractional-stack-cutover.sql');
const harness = readRepo('scripts/dev/probe-tournament-fractional-stack-normalization-pg17.sh');
const eliminationManager = readRepo('server/src/tournament/TournamentManagerEliminations.ts');

describe('fractional tournament stacks are normalized once at a stopped exact-build cutover', () => {
  it('sorts in the exact expansion, contractions, DB-first move, normalization order', () => {
    const prerequisiteBasenames = [
      '_hand_settlement_targets_exact_seat_generation.sql',
      '_tournament_manager_request_fencing_is_strict.sql',
      '_hand_settlement_requires_exact_seat_generation.sql',
    ].map((prerequisiteSuffix) => {
      const matches = readdirSync(repoPath('supabase/migrations')).filter((name) =>
        name.endsWith(prerequisiteSuffix)
      );
      expect(matches).toHaveLength(1);
      return matches[0];
    });
    expect(migrationBasenames).toHaveLength(1);
    const totalOrder = [...prerequisiteBasenames, atomicMoveBasename, migrationBasename];
    for (let index = 1; index < totalOrder.length; index++) {
      expect(totalOrder[index - 1] < totalOrder[index]).toBe(true);
    }
    expect(atomicMoveMigration).toContain("NOTIFY pgrst, 'reload schema'");
    expect(migration).toContain("('tournament_seat_moves_are_one_atomic_receipt')");
    expect(migration).toContain("to_regclass('public.tournament_seat_move_receipts') IS NULL");
    expect(migration).toContain('index_catalog.indisunique');
    expect(migration).toContain("ARRAY['tournament_id', 'table_id', 'seat_number']::text[]");
  });

  it('ships as either the all-sentinel staging template or one receipt-sealed exact artifact', () => {
    const sentinels = [
      "c_engine_sha8 constant text := '__CUTOVER_ENGINE_SHA8__'",
      "c_tournament_ids_csv constant text := '__CUTOVER_TOURNAMENT_IDS_CSV__'",
      'c_tournament_count constant integer := -1',
      'c_table_count constant integer := -1',
      'c_active_seat_count constant integer := -1',
      'c_fractional_seat_count constant integer := -1',
      'c_total_chips constant numeric := -1',
      "c_preimage_sha256 constant text := '__CUTOVER_PREIMAGE_SHA256__'",
      "c_postimage_sha256 constant text := '__CUTOVER_POSTIMAGE_SHA256__'",
    ];
    const sentinelCount = sentinels.filter((sentinel) => migration.includes(sentinel)).length;
    expect([0, sentinels.length]).toContain(sentinelCount);

    if (sentinelCount === sentinels.length) {
      expect(existsSync(repoPath(receiptFilename))).toBe(false);
    } else {
      expect(existsSync(repoPath(receiptFilename))).toBe(true);
      const receipt = readRepo(receiptFilename);
      expect(receipt.endsWith('\n')).toBe(true);
      const lines = receipt.trimEnd().split('\n');
      const expectedKeys = [
        'CUTOVER_ENGINE_SHA8',
        'CUTOVER_TOURNAMENT_IDS_CSV',
        'CUTOVER_TOURNAMENT_COUNT',
        'CUTOVER_TABLE_COUNT',
        'CUTOVER_ACTIVE_SEAT_COUNT',
        'CUTOVER_FRACTIONAL_SEAT_COUNT',
        'CUTOVER_TOTAL_CHIPS',
        'CUTOVER_PREIMAGE_SHA256',
        'CUTOVER_POSTIMAGE_SHA256',
        'RENDERED_MIGRATION_SHA256',
      ];
      expect(lines).toHaveLength(expectedKeys.length);
      const values = new Map<string, string>();
      lines.forEach((line, index) => {
        const separator = line.indexOf('=');
        expect(separator).toBeGreaterThan(0);
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        expect(key).toBe(expectedKeys[index]);
        expect(values.has(key)).toBe(false);
        values.set(key, value);
      });
      expect(values.get('CUTOVER_ENGINE_SHA8')).toMatch(/^[0-9a-f]{8}$/);
      for (const key of [
        'CUTOVER_PREIMAGE_SHA256',
        'CUTOVER_POSTIMAGE_SHA256',
        'RENDERED_MIGRATION_SHA256',
      ]) {
        expect(values.get(key)).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(values.get('CUTOVER_PREIMAGE_SHA256')).not.toBe(
        values.get('CUTOVER_POSTIMAGE_SHA256')
      );
      expect(createHash('sha256').update(migration).digest('hex')).toBe(
        values.get('RENDERED_MIGRATION_SHA256')
      );
      expect(migration).toContain(
        `c_engine_sha8 constant text := '${values.get('CUTOVER_ENGINE_SHA8')}'`
      );
      expect(migration).toContain(
        `c_tournament_ids_csv constant text := '${values.get('CUTOVER_TOURNAMENT_IDS_CSV')}'`
      );
      for (const [key, declaration] of [
        ['CUTOVER_TOURNAMENT_COUNT', 'c_tournament_count constant integer'],
        ['CUTOVER_TABLE_COUNT', 'c_table_count constant integer'],
        ['CUTOVER_ACTIVE_SEAT_COUNT', 'c_active_seat_count constant integer'],
        ['CUTOVER_FRACTIONAL_SEAT_COUNT', 'c_fractional_seat_count constant integer'],
        ['CUTOVER_TOTAL_CHIPS', 'c_total_chips constant numeric'],
      ] as const) {
        expect(migration).toContain(`${declaration} := ${values.get(key)};`);
      }
      expect(migration).toContain(
        `c_preimage_sha256 constant text := '${values.get('CUTOVER_PREIMAGE_SHA256')}'`
      );
      expect(migration).toContain(
        `c_postimage_sha256 constant text := '${values.get('CUTOVER_POSTIMAGE_SHA256')}'`
      );
    }

    const prerequisite = migration.indexOf('FRACTIONAL_STACK_PREREQUISITE_MISSING');
    const sourceAcl = migration.indexOf('strict source markers or application ACL changed');
    const schema = migration.indexOf('FRACTIONAL_STACK_SCHEMA_DRIFT');
    const emptyReplay = migration.indexOf('empty chronological replay: no tournament estate');
    const unset = migration.indexOf('FRACTIONAL_STACK_CUTOVER_LITERALS_UNSET');
    expect(prerequisite).toBeGreaterThan(-1);
    expect(sourceAcl).toBeGreaterThan(prerequisite);
    expect(schema).toBeGreaterThan(sourceAcl);
    expect(emptyReplay).toBeGreaterThan(schema);
    expect(unset).toBeGreaterThan(emptyReplay);
    expect(migration).toContain('AND NOT EXISTS (SELECT 1 FROM public.tournaments)');
    expect(migration).toContain('AND NOT EXISTS (SELECT 1 FROM public.tournament_players)');
    expect(migration).toContain("lower(COALESCE(tb.game_type::text, '')) = 'tournament'");
  });

  it('materializes once, verifies byte-exact evidence, and atomically refuses late path races', () => {
    expect(materializer).toContain('hits_engine != 1');
    expect(materializer).toContain('hits_post != 1');
    expect(renderer).toContain('-f "$materializer" "$migration"');
    expect(renderer).toContain('resolve_staged_or_promoted_migration');
    expect(harness).toContain('resolve_staged_or_promoted_migration');
    expect(migrationResolver).toContain('.sql.pending');
    expect(migrationResolver).toContain('found ${resolved_count}');
    expect(renderer).toContain('DATABASE_URL is not accepted');
    expect(renderer).not.toContain('$psql_bin "$DATABASE_URL"');
    expect(renderer).toContain('ln "$render_tmp" "$output"');
    expect(renderer).toContain('ln "$receipt_tmp" "${output}.receipt"');
    expect(renderer).toContain('require_private_cutover_directory "$output_dir"');
    expect(verifier).toContain('require_private_cutover_directory "$rendered_dir"');
    expect(verifier).toContain('resolve_staged_or_promoted_migration');
    expect(privateDirectoryHelper).toContain("== '700'");
    expect(privateDirectoryHelper).toContain('== "${EUID}"');
    expect(privateDirectoryHelper).toContain('"$logical" == "$physical"');
    expect(verifier).toContain('RENDERED_ARTIFACT_VERIFIED');
    expect(verifier).toContain('cmp -s "$verification_tmp" "$rendered"');
    expect(verifier).toContain('Evidence must have mode 0600');
    expect(verifier).toContain('LEDGER_ARTIFACT_VERIFIED');
    expect(verifier).toContain('LEDGER_NAME_PRISTINE');
    expect(ledgerVerifier).toContain('(SELECT count(*) FROM named)');
    expect(genericLedgerVerifier).toContain('MIGRATION_LEDGER_NAME_PRISTINE');
    expect(genericLedgerVerifier).toContain('MIGRATION_LEDGER_ARTIFACT_VERIFIED');
    expect(postconditionVerifier).toContain('TOURNAMENT_WHOLE_CHIP_POSTCONDITIONS_VERIFIED');
    expect(zeroAuthorityVerifier).toContain('TOURNAMENT_CUTOVER_ZERO_AUTHORITY_VERIFIED');
    expect(ledgerVerifier).toContain("extensions.digest(statements[1], 'sha256')");
    expect(ledgerVerifier).toContain("name = 'tournament_fractional_stacks_are_normalized_once'");
    expect(harness).toContain('operator-output-race');
    expect(harness).toContain('operator-receipt-race');
    expect(harness).toContain('operator-tampered');
    expect(harness).toContain('operator-receipt-tampered');
    expect(harness).toContain('operator-ledger-duplicate');
    expect(harness).toContain('operator-receipt-trailing');
    expect(harness).toContain('world-writable');
  });

  it('documents one executable two-window order with exact proof commands', () => {
    expect(runbook).not.toContain('enforceFreeze=true');
    expect(runbook).not.toContain('declaredBy=SHA8');
    expect(runbook).toContain('verify-tournament-fractional-stack-zero-authority.sh "$SHA8"');
    expect(runbook).toContain('tournament-fractional-stack-cutover.sql PREAPPLY');
    expect(runbook).toContain('verify-tournament-fractional-stack-cutover-postconditions.sh');
    expect(runbook).toContain('tournament_seat_moves_are_one_atomic_receipt PREAPPLY');
    expect(runbook).toContain(
      'tournament_seat_moves_are_one_atomic_receipt "$MOVE_APPLIED_VERSION" "$MOVE_FILE"'
    );
    expect(runbook).toContain('atomic seat move < fractional normalization');
    expect(runbook).toContain('must not be submitted again here');
    expect(runbook).toContain('ledger-assigned activation version');
    expect(runbook).toContain('The normalization receipt must sort before the activation receipt');
    expect(migration).not.toContain('patch the same nine literals in this canonical migration');
  });

  it('identifies prerequisites by unique exact name, independent of remote ledger version', () => {
    for (const name of [
      'hand_settlement_targets_exact_seat_generation',
      'tournament_manager_request_fencing_is_strict',
      'hand_settlement_requires_exact_seat_generation',
      'tournament_seat_moves_are_one_atomic_receipt',
    ]) {
      expect(migration).toContain(`('${name}')`);
      expect(fixture).toContain(`'${name}'`);
    }
    expect(migration).toContain('WHERE m.name = required.name) <> 1');
    expect(migration).not.toMatch(/m\.version\s*=|m\.version\s+IN/);
    expect(fixture).toContain(
      "('20260908161534', 'hand_settlement_targets_exact_seat_generation')"
    );
    expect(fixture).toContain("('20260908162211', 'tournament_manager_request_fencing_is_strict')");
    expect(fixture).toContain(
      "('20260908162847', 'hand_settlement_requires_exact_seat_generation')"
    );
  });

  it('takes the global realtime lock first and every moving authority NOWAIT', () => {
    const begin = migration.indexOf('BEGIN;');
    const realtime = migration.indexOf(
      'LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;'
    );
    const body = migration.indexOf('DO $normalize_fractional_tournament_stacks$');
    expect(realtime).toBeGreaterThan(begin);
    expect(realtime).toBeLessThan(body);
    for (const lock of [
      'supabase_migrations.schema_migrations IN SHARE MODE NOWAIT',
      'public.engine_maintenance_break IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      'public.engine_leader IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      'public.engine_table_leases IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      'public.engine_tournament_leases IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      'public.tournaments IN ACCESS EXCLUSIVE MODE NOWAIT',
      'public.tournament_players IN ACCESS EXCLUSIVE MODE NOWAIT',
      'public.tables IN ACCESS EXCLUSIVE MODE NOWAIT',
      'public.table_seats IN ACCESS EXCLUSIVE MODE NOWAIT',
      'public.hand_state_snapshots IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      'public.settlement_idempotency_keys IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      'public.hand_atomic_commits IN SHARE ROW EXCLUSIVE MODE NOWAIT',
    ]) {
      expect(migration).toContain(`LOCK TABLE ${lock};`);
    }
  });

  it('requires the exact freeze owner, stale leases, and a completely quiet hand barrier', () => {
    expect(migration).toContain("b.phase = 'counting_down'");
    expect(migration).toContain('b.enforce_freeze');
    expect(migration).toContain('b.declared_by = c_engine_sha8');
    expect(migration).toContain("v_cutover_at - interval '30 seconds'");
    expect(migration).toContain('v_break_announced_at');
    expect(migration).toContain('l.acquired_at >= v_break_announced_at');
    expect(migration).toContain('l.heartbeat_at >= v_break_announced_at');
    expect(migration).toContain('FRACTIONAL_STACK_ENGINE_STILL_LIVE');
    expect(migration).toContain('FRACTIONAL_STACK_ENGINE_VERSION_DRIFT');
    expect(migration).toContain('NOT h.is_complete');
    expect(migration).toContain("k.status = 'in_flight'");
    expect(migration).toContain('c.post_commit_completed_at IS NULL');
    expect(migration).toContain('FRACTIONAL_STACK_HAND_IN_FLIGHT');
  });

  it('pins all nonterminal cohorts and exact seat/player generations without touching wallets or history', () => {
    expect(fixture).toContain("'Stable Tie B', 'REGISTERING'");
    expect(migration).toContain("tp.status::text IN ('registered', 'playing')");
    expect(migration).toContain("p.tournament_status = 'COMPLETING'");
    expect(migration).toContain("tp.status::text = 'winner'");
    expect(migration).toContain("p.tournament_status = 'RUNNING'");
    expect(migration).toContain('s.joined_at = p.seat_joined_at');
    expect(migration).toContain('s.stack IS NOT DISTINCT FROM p.old_stack');
    expect(migration).toContain('tp.status::text = p.old_player_status');
    expect(migration).toContain('FRACTIONAL_STACK_PARTIAL_SEAT_WRITE');
    expect(migration).toContain('FRACTIONAL_STACK_PARTIAL_PLAYER_WRITE');
    expect(migration).toContain('FRACTIONAL_STACK_AGGREGATE_IS_FRACTIONAL');
    expect(migration).toContain('sum(p.target_stack) IS DISTINCT FROM sum(p.old_stack)');
    expect(migration).not.toMatch(/UPDATE\s+public\.(?:wallet|chip_transactions)/i);
    expect(migration).toContain("IN ('COMPLETED', 'CANCELLED', 'CANCELED')");
  });

  it('uses the measurement residue predicate at apply and certifies global topology', () => {
    const driftStart = migration.indexOf(
      'Fractions OR the exact one-chip legacy mirror residue in any other'
    );
    const driftEnd = migration.indexOf('FRACTIONAL_STACK_UNMEASURED_LIVE_COHORT', driftStart);
    const drift = migration.slice(driftStart, driftEnd);
    for (const anchor of [
      's.stack <> trunc(s.stack)',
      's.stack = trunc(s.stack)',
      's.stack >= 1',
      'tp.chips = s.stack::bigint - 1',
    ]) {
      expect(cutoverMeasurement).toContain(anchor);
      expect(drift).toContain(anchor);
    }
    expect(migration).toContain(
      'global nonterminal seat/roster topology is not one exact whole-chip mirror'
    );
    expect(postconditionQuery).not.toContain('t.id = ANY(e.tournament_ids)');
    expect(postconditionQuery).not.toContain('tp.tournament_id = ANY(e.tournament_ids)');
    expect(harness).toContain('unmeasured_residue_after_zero_render');
    expect(harness).toContain('unmeasured_residue_after_positive_render');
    expect(harness).toMatch(
      /zero_cohort_unrelated_missing_mirror[\s\S]*?expect_file_failure zero_cohort_unrelated_missing_mirror[\s\S]*?FRACTIONAL_STACK_IDENTITY_MISMATCH/
    );
  });

  it('uses deterministic largest remainder and hashes complete pre/postimages', () => {
    const stableOrder =
      /ORDER BY \(p\.old_stack - floor\(p\.old_stack\)\) DESC,[\s\S]*?p\.table_id, p\.seat_number, p\.seat_id,[\s\S]*?p\.seat_joined_at, p\.user_id/;
    expect(migration).toMatch(stableOrder);
    expect(measurement).toMatch(
      /ORDER BY \(old_stack - floor\(old_stack\)\) DESC,[\s\S]*?table_id, seat_number, seat_id, seat_joined_at, user_id/
    );
    for (const narrative of [
      "'tournament', p.tournament_before",
      "'table', p.table_before",
      "'seat', p.seat_before",
      "'tournament_player', p.player_before",
    ]) {
      expect(migration).toContain(narrative);
    }
    const topologyProof = migration.indexOf(
      'player status/table/seat or one-active-generation mapping drifted'
    );
    const exactPostimageBranch = migration.indexOf(
      'IF v_actual_preimage_sha256 = c_postimage_sha256 THEN'
    );
    expect(topologyProof).toBeGreaterThan(-1);
    expect(topologyProof).toBeLessThan(exactPostimageBranch);
    expect(migration).toContain('FRACTIONAL_STACK_RETRY_POSTIMAGE_INVALID');
    expect(migration).toContain('fractional tournament stack cutover already has exact postimage');
  });
});

describe('future tournament chip ingress fails before coercion or partial write', () => {
  it('replaces the owner-only sync child with exact-schema all-or-none validation', () => {
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_sync_tournament_chips(');
    const end = migration.indexOf('REVOKE ALL ON FUNCTION public.fn_sync_tournament_chips', start);
    const strictSync = migration.slice(start, end);
    expect(strictSync).toContain('TOURNAMENT_CHIP_SYNC_INPUT_INVALID');
    expect(strictSync).toContain('TOURNAMENT_CHIP_SYNC_RECIPIENT_MISMATCH');
    expect(strictSync).toContain("(v_item - ARRAY['user_id', 'chips']) <> '{}'::jsonb");
    expect(strictSync).toContain('v_chip_value <> trunc(v_chip_value)');
    expect(strictSync).toContain('v_chip_value > 9999999999999');
    expect(strictSync).toContain('v_user_id = ANY(v_user_ids)');
    expect(strictSync).toContain('v_matched_count <> cardinality(v_user_ids)');
    expect(strictSync).toContain('ORDER BY tp.user_id');
    expect(strictSync).toContain('FOR UPDATE OF tp');
    expect(strictSync).not.toMatch(/floor\(|GREATEST\(/i);
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_sync_tournament_chips(uuid, jsonb)'
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_sync_tournament_chips\(uuid, jsonb\)[\s\S]{0,80}?TO service_role;/
    );
  });

  it('locks the live-seat source after only live roster rows and quarantines unsafe identities', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_sync_tournament_live_seat_chips('
    );
    const end = migration.indexOf(
      'REVOKE ALL ON FUNCTION public.fn_sync_tournament_live_seat_chips',
      start
    );
    const liveSync = migration.slice(start, end);
    const playerLock = liveSync.indexOf('LIVE_SEAT_LOCK_ORDER_PLAYERS_SEATS');
    const seatLock = liveSync.indexOf('FOR UPDATE OF s;');
    const snapshot = liveSync.indexOf('WITH live AS (');
    const child = liveSync.indexOf('v_synced := public.fn_sync_tournament_chips');
    const returnedMismatch = liveSync.indexOf(
      "'recipient_mismatch_user_ids', v_recipient_mismatch_user_ids"
    );

    expect(playerLock).toBeGreaterThan(-1);
    expect(seatLock).toBeGreaterThan(playerLock);
    expect(snapshot).toBeGreaterThan(seatLock);
    expect(child).toBeGreaterThan(snapshot);
    expect(returnedMismatch).toBeGreaterThan(child);
    expect(liveSync).toContain("tp.status::text IN ('registered', 'playing')");
    expect(liveSync).toContain("tp.status::text = 'playing'");
    expect(liveSync).toContain('FULL OUTER JOIN roster');
    expect(liveSync).toContain('active_count = 0');
    expect(liveSync).toContain('active_count = 1');
    expect(liveSync).toContain('active_count <> 1');
    expect(liveSync).toContain('player_count <> 1');
    expect(liveSync).toContain('active_seat.left_at IS NULL');
    expect(liveSync).toContain('v_locked_user_ids');
    expect(liveSync).toContain('user_id = ANY(v_locked_user_ids)');
    expect(liveSync).not.toMatch(/FOR UPDATE OF t;/);
    expect(liveSync).not.toMatch(/floor\(|GREATEST\(|COALESCE\(latest_stack/i);
    expect(liveSync).toContain("jsonb_build_object('user_id', user_id, 'chips', latest_stack)");

    // The rolling live-seat sync was the pre-cutover caller. Current
    // eliminations commit the exact seat generation and stack in the atomic
    // elimination receipt, so reintroducing that broad sync would create a
    // second stack writer after the cutover.
    expect(eliminationManager).not.toContain("'fn_sync_tournament_live_seat_chips'");
    expect(eliminationManager).toContain("'fn_eliminate_tournament_player_atomic'");
  });

  it('guards configuration, bomb-pot ante, table stacks, revivals and classification transitions', () => {
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OF status, starting_chips, rebuy_chips, addon_chips, blind_structure'
    );
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF table_id, stack, left_at');
    expect(migration).toMatch(
      /BEFORE INSERT OR UPDATE OF tournament_id, game_type, small_blind, big_blind, ante,[\s\S]*?bomb_pot_enabled, bomb_pot_ante_multiplier, bomb_pot_ante_fixed/
    );
    expect(migration).toContain(
      "v_tournament_id IS NOT NULL\n      OR lower(COALESCE(NEW.game_type::text, '')) = 'tournament'"
    );
    expect(migration).toContain('FOR SHARE OF tb;');
    expect(migration).toContain(
      'a table with fractional active seats cannot become a tournament table'
    );
    expect(migration).toContain(
      'a terminal tournament with malformed child chips cannot become nonterminal'
    );
    expect(migration).toContain("v_tournament_status IN ('COMPLETED', 'CANCELLED', 'CANCELED')");
    expect(migration).toContain('NEW.stack IS NOT DISTINCT FROM OLD.stack');
    expect(migration).toContain('bomb_pot_ante_fixed <> trunc');
  });

  it('rejects missing, scalar, empty and all-break ladders while preserving break metadata', () => {
    expect(migration).toContain("(to_jsonb(t) ->> 'blind_structure') IS NULL");
    expect(migration).toContain(
      "jsonb_typeof(\n                (to_jsonb(t) ->> 'blind_structure')::jsonb"
    );
    expect(migration).toContain('jsonb_array_length(v_structure) = 0');
    expect(migration).toContain('blind_structure needs a non-break level');
    expect(migration).toContain(
      "IF COALESCE((v_level ->> 'isBreak')::boolean, false) THEN\n          CONTINUE;"
    );
    for (const alias of [
      'smallBlind',
      'small_blind',
      "'small'",
      "'sb'",
      'bigBlind',
      'big_blind',
      "'big'",
      "'bb'",
    ]) {
      expect(migration).toContain(alias);
    }
  });

  it('keeps cash cents and proves rollback, replay, lock refusal, races and every strict RPC rejection on PG17', () => {
    for (const marker of [
      'FRACTIONAL_STACK_CUTOVER_LITERALS_UNSET',
      'FRACTIONAL_STACK_ENGINE_STILL_LIVE',
      'FRACTIONAL_STACK_HAND_IN_FLIGHT',
      'FRACTIONAL_STACK_SOURCE_DRIFT',
      'FRACTIONAL_STACK_IDENTITY_MISMATCH',
      'FRACTIONAL_STACK_AGGREGATE_IS_FRACTIONAL',
      'FRACTIONAL_STACK_UNMEASURED_LIVE_COHORT',
      'FRACTIONAL_STACK_PARTIAL_SEAT_WRITE',
      'TOURNAMENT_CHIP_SYNC_INPUT_INVALID',
      'TOURNAMENT_CHIP_SYNC_RECIPIENT_MISMATCH',
      'recipient_mismatch_user_ids',
      'null_blind_structure',
      'empty_blind_structure',
      'all_break_blind_structure',
      'live-seat-newer-source',
      'live-seat-snapshot-wrapper',
      'live-seat-atomic-elimination',
      'live-seat-seatless-playing',
      'exact-postimage-topology-drift',
      'live-seat-ambiguous-generation',
      'live-seat-unequal-active-generations',
      'historical-old-build-lease',
      'causal-wrong-build-lease',
      'fractional-table-first',
      'fractional-seat-first',
      'could not obtain lock on relation',
    ]) {
      expect(harness).toContain(marker);
    }
    expect(fixture).toContain("NULL, 'cash', 'running', 0.25, 0.50, 0.10, true, 0.25");
    expect(harness).toContain('assert_normalized_sync_postimage');
    expect(harness).toContain('assert_legacy_preimage');
  });
});
