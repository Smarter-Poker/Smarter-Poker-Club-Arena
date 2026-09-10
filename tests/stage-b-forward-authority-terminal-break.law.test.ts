/**
 * Stage B expands its private authority schema before it repairs production
 * data, then installs the permanent terminal-break invariant after the repair.
 * Neither boundary may replay or overwrite the newer 034411 postimage. The
 * rehearsal follows the six immutable logical IDs; temporary physical filenames
 * are not chronology and must never be compared with the live ledger head.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const productionPostimageFile =
  '20260910034411_seat_proof_lock_generic_plan_lobby_policy_hashed_and_tick_in.sql';
const spinPostimageFile =
  '20260910034412_spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row.sql';
const settlementLanePostimageFile =
  '20260910035435_the_settlement_lane_is_per_tournament_not_platform_wide.sql';
const seatMoveHotfixFile = '20260910051447_the_seat_move_door_the_engine_calls_exists.sql';

function stagedMigrationFile(suffix: string): string {
  const matches = readdirSync(resolve(root, 'supabase', 'migrations')).filter((file) =>
    file.endsWith(`_${suffix}.sql`)
  );
  expect(matches, `${suffix} migration`).toHaveLength(1);
  return matches[0];
}

const stageBChain = [
  ['stage_b_forward_authority_expansion', '20260910042007_stage_b_forward_authority_expansion'],
  ['stage_b_exact_precondition_repairs', '20260910042020_stage_b_exact_precondition_repairs'],
  ['stage_b_terminal_break_invariant', '20260910042033_stage_b_terminal_break_invariant'],
  [
    'stage_b_atomic_finish_precertification',
    '20260910042058_stage_b_atomic_finish_precertification',
  ],
  ['stage_b_current_postimage_contraction', '20260910042112_stage_b_current_postimage_contraction'],
  ['stage_b_lease_keyshare_once', '20260910042137_stage_b_lease_keyshare_once'],
] as const;
const stageBFiles = stageBChain.map(([suffix]) => stagedMigrationFile(suffix));
const [expansionFile, repairFile, invariantFile] = stageBFiles;
const stageBPristineGateRelations = [
  'auth.users',
  'public.clubs',
  'public.tournaments',
  'public.tables',
  'public.chip_ledger',
  'public.tournament_tickets',
] as const;

function migration(file: string): string {
  return readFileSync(resolve(root, 'supabase', 'migrations', file), 'utf8');
}

const productionPostimage = migration(productionPostimageFile);
const productionCode = productionPostimage.replace(/^\s*--.*$/gm, '');
const spinPostimage = migration(spinPostimageFile);
const settlementLanePostimage = migration(settlementLanePostimageFile);
const seatMoveHotfix = migration(seatMoveHotfixFile);
const expansion = migration(expansionFile);
const repair = migration(repairFile);
const invariant = migration(invariantFile);
const forwardBoundaries = `${expansion}\n${invariant}`;
const harness = readFileSync(
  resolve(root, 'scripts/dev/probe-stage-b-forward-chain-pg17.sh'),
  'utf8'
);
const diamondFixture = readFileSync(
  resolve(root, 'scripts/dev/fixtures/stage-b-diamond-accepted-hand-current-schema.sql'),
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
  it('uses semantic chain order and all six immutable logical IDs', () => {
    expect(stageBFiles).toHaveLength(6);
    stageBChain.forEach(([, logicalId], index) => {
      expect(migration(stageBFiles[index]).split(/\r?\n/, 1)[0]).toBe(`-- ${logicalId}`);
    });

    const chainNames = harness
      .match(/chain_names=\(\n([\s\S]*?)\n\)/)?.[1]
      .trim()
      .split(/\s+/);
    const chainLogicalIds = harness
      .match(/chain_logical_ids=\(\n([\s\S]*?)\n\)/)?.[1]
      .trim()
      .split(/\s+/);
    expect(chainNames).toEqual(stageBChain.map(([suffix]) => suffix));
    expect(chainLogicalIds).toEqual(stageBChain.map(([, logicalId]) => logicalId.slice(0, 14)));
    expect(harness).toContain(
      'Stage-B semantic suffixes and logical identities are not one-to-one.'
    );
    expect(harness).toContain('Stage-B logical identities are not strictly ordered');
    expect(harness).not.toContain('first_stage_b_version');
    expect(harness).not.toContain('Stage-B starts at or before the current ledger head');
    expect(harness).not.toContain('does not follow the applied seat-move hotfix');
    expect(spinPostimage).toContain(
      '-- 20260910034412_spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row.sql'
    );
    expect(settlementLanePostimage).toContain('v_done <> 30');
    expect(seatMoveHotfix).toContain(
      '-- 20260910051125_the_seat_move_door_the_engine_calls_exists'
    );
  });

  it('adopts the exact hotfix tables and expands only the remaining private schema', () => {
    expect(expansion.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(expansion.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(occurrences(expansion, /^CREATE TABLE public\./gm)).toBe(6);
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
      'tournament_mutator_scheduler_retirement_receipts',
      'tournament_terminal_break_normalization_receipts',
    ]) {
      expect(expansion).toContain(`CREATE TABLE public.${relation}`);
    }

    for (const adoptedRelation of [
      'tournament_seat_exit_authorizations',
      'tournament_seat_move_receipts',
    ]) {
      expect(expansion).not.toContain(`CREATE TABLE public.${adoptedRelation}`);
      expect(expansion).not.toMatch(
        new RegExp(`(?:DROP|TRUNCATE) TABLE(?: IF EXISTS)? public\\.${adoptedRelation}`)
      );
    }

    expect(expansion).toContain("m.name='the_seat_move_door_the_engine_calls_exists'");
    expect(expansion).toContain("m.version='20260910051447'");
    expect(expansion).toContain('b3f1bb62152627444b33c82b806c00ba3587aeebbe3d13800faf69fae7809ea2');
    expect(expansion).toContain('556029bd3b99e8bb0ef36db2a28ed862');
    expect(expansion).toContain('d13f29c5d5a781fe2a7f834673ecc820');
    for (const functionHash of [
      '85534593874dc5d908193ccbfc309719',
      '25cf8792d0d7b4ebf1d383072ca2834c',
      '0811b7a7795234ed8bc84c606d9a5a62',
      '68813ee03e355e2eec053e15bf40f98d',
      '466c39065b59cf7922a5859df9f26bd3',
      '37bc550ccb878c042773d0789c8ef355',
    ]) {
      expect(expansion).toContain(functionHash);
    }
    expect(expansion).toContain('stage_b_move_receipt_preimage');
    expect(expansion).toContain(
      'LOCK TABLE public.tournament_seat_exit_authorizations,\n' +
        '           public.tournament_seat_move_receipts\n' +
        '  IN SHARE MODE NOWAIT;'
    );
    expect(expansion).toContain(
      'Stage-B expansion changed an immutable seat-move receipt preimage'
    );
    expect(expansion).toContain(
      'EXISTS (SELECT 1 FROM public.tournament_seat_exit_authorizations)'
    );

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
    expect(harness).toContain('the_seat_move_door_the_engine_calls_exists');
    expect(harness).not.toContain("baseline_receipts\" != '4'");
    expect(
      occurrences(
        harness,
        /encode\(extensions\.digest\(actual\.statements\[1\],'sha256'\),'hex'\)/g
      )
    ).toBe(2);
  });

  it('requires the byte-authenticated 080728 live schema and a zero-player-data donor', () => {
    const currentLiveSources = [
      ['20260910034411', 'seat_proof_lock_generic_plan_lobby_policy_hashed_and_tick_in'],
      ['20260910034412', 'spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row'],
      ['20260910035435', 'the_settlement_lane_is_per_tournament_not_platform_wide'],
      ['20260910051447', 'the_seat_move_door_the_engine_calls_exists'],
      ['20260910052523', 'hand_projection_outbox_notifies_its_listener'],
      ['20260910054638', 'tables_policy_hashed_auth_admin_trusted_and_unfilled_spins_e'],
      ['20260910054712', 'a_hand_settles_each_seat_once'],
      ['20260910055857', 'tournament_bounty_per_pot_evidence'],
      ['20260910060034', 'cash_entry_close_proves_the_reserved_unpaid_ladder'],
      ['20260910062308', 'server_financial_alerts_accept_an_entity_id'],
      ['20260910063559', 'a_busy_manager_keeps_its_lease'],
      ['20260910064305', 'a_union_ticket_is_issued_at_the_club_the_winner_plays_from'],
      ['20260910064701', 'a_hand_commit_does_not_hold_the_lease_against_its_own_heartb'],
      ['20260910065825', 'the_journal_window_is_a_snapshot_not_a_clock'],
      ['20260910070417', 'a_ticket_entry_is_an_entry'],
      ['20260910071131', 'cash_entry_reprice_service_only_access'],
      ['20260910072322', 'the_knockout_door_owns_every_bust_a_hand_took'],
      ['20260910072351', 'an_elimination_without_a_place_cannot_be_written'],
      ['20260910073355', 'the_retired_sweeps_keep_their_disabled_schedule_rows'],
      ['20260910073818', 'the_break_writer_outwaits_the_doors_it_serializes'],
      ['20260910074504', 'a_manager_sweeps_itself_once_when_it_adopts_the_event'],
      ['20260910075958', 'a_deferred_check_reads_the_row_at_commit_not_the_statement'],
      ['20260910080137', 'the_outbox_leaves_the_realtime_publication'],
      ['20260910080242', 'the_guard_that_stopped_five_satellites_is_answered_for'],
      ['20260910080728', 'three_money_doors_are_audited_and_registered'],
    ] as const;

    expect(currentLiveSources).toHaveLength(25);
    for (const [version, name] of currentLiveSources) {
      expect(harness).toContain(version);
      expect(harness).toContain(name);
    }
    expect(harness).toContain("current_live_ledger_head='20260910080728'");
    expect(harness).toContain(
      `if [[ "$anchor_receipts" != '25' || "$ledger_head" != "$current_live_ledger_head" ]]`
    );
    expect(harness).toContain(`if [[ "$exact_body_receipts" != '3' ]]`);
    expect(harness).toContain(`if [[ "$descriptor_receipts" != '2' ]]`);
    expect(harness).toContain(
      `if [[ "$audited_tail_receipts" != '9' || "$audited_tail_statements" != '12' ]]`
    );
    expect(harness).toContain('emit_zero_player_data_assertion_function() {');
    expect(harness).toContain(
      'CREATE OR REPLACE FUNCTION pg_temp.assert_zero_player_data_baseline()'
    );
    const zeroDataRelationArray = harness.match(
      /FOREACH v_relation_name IN ARRAY ARRAY\[([\s\S]*?)\]::text\[\] LOOP/
    )?.[1];
    expect(zeroDataRelationArray, 'zero-data donor relation array').toBeDefined();
    const zeroDataRelations = [...zeroDataRelationArray!.matchAll(/'([^']+)'/g)].map(
      (match) => match[1]
    );
    expect(new Set(zeroDataRelations).size).toBe(zeroDataRelations.length);
    expect(zeroDataRelations).toEqual(expect.arrayContaining([...stageBPristineGateRelations]));
    expect(harness).toContain(
      "IF to_regclass('public.poker_diamond_obligations') IS NOT NULL THEN"
    );
    expect(harness).toContain('SELECT pg_temp.assert_zero_player_data_baseline() AS rows');
    expect(harness).toContain(`if [[ "$donor_data_rows" != '0' ]]`);
    expect(harness).toContain('use a production-schema zero-data clone');
    expect(harness).toContain("echo 'STAGE_B_CURRENT_LIVE_SCHEMA_MANIFEST_OK'");
    expect(harness).toContain("echo 'STAGE_B_ZERO_PLAYER_DATA_BASELINE_OK'");
  });

  it('makes each finalized behavioral rehearsal contract part of the default run', () => {
    const preparationStart = harness.indexOf('prepare_current_postimage_template() {');
    const preparationEnd = harness.indexOf(
      '\nkeyshare_postimage_fingerprint() {',
      preparationStart
    );
    expect(preparationStart).toBeGreaterThanOrEqual(0);
    expect(preparationEnd).toBeGreaterThan(preparationStart);
    const preparation = harness.slice(preparationStart, preparationEnd);
    const defaultRunStart = harness.indexOf("create_scenario_database 'terminal_residue'");
    expect(defaultRunStart).toBeGreaterThanOrEqual(0);
    const defaultRun = harness.slice(defaultRunStart);

    expect(defaultRun).toContain('run_terminal_residue_success "$terminal_residue_database"');
    expect(defaultRun).toContain('run_terminal_candidate_behavior "$terminal_residue_database"');
    expect(defaultRun).toContain(
      'run_late_missing_finish_claim_rollback "$late_finish_claim_database"'
    );
    expect(defaultRun).toContain(
      'prepare_current_postimage_template "$current_postimage_database"'
    );
    expect(defaultRun).toContain(
      `create_scenario_database 'keyshare_mixed' "$current_postimage_database"`
    );
    expect(defaultRun).toContain(
      `create_scenario_database 'keyshare_clean' "$current_postimage_database"`
    );
    expect(defaultRun).toContain('run_keyshare_unknown_preimage_rollback "$mixed_database"');
    expect(defaultRun).toContain('run_chain_prefix 6 true "$clean_database" 5');
    expect(defaultRun).toContain('assert_current_live_tail_postimage "$mixed_database"');
    expect(defaultRun).toContain('assert_current_live_tail_postimage "$clean_database"');

    for (const marker of [
      'STAGE_B_DIAMOND_ACCEPTED_HAND_SUCCESS_REPLAY_ROLLBACK_OK',
      'STAGE_B_DIAMOND_ACCEPTED_HAND_CURRENT_SCHEMA_OK',
      'STAGE_B_080728_CONTROL_POSTIMAGE_OK',
    ]) {
      expect(preparation).toContain(marker);
    }
    expect(harness).toContain('STAGE_B_LEASE_KEYSHARE_UNKNOWN_PREIMAGE_ROLLBACK_OK');
    expect(defaultRun).toContain("echo 'STAGE_B_LEASE_KEYSHARE_REPLAY_OK'");
    expect(harness).toContain('LEASE_KEYSHARE_UNKNOWN_PREIMAGE: table key 1, tournament key 0');
    expect(harness).not.toContain('LEASE_KEYSHARE_MIXED_PREIMAGE');
    expect(harness).not.toContain('STAGE_B_LEASE_KEYSHARE_MIXED_STATE_ROLLBACK_OK');
  });

  it('executes the candidate-aware terminal transition without forgiving another failure', () => {
    const start = harness.indexOf('run_terminal_candidate_behavior() {');
    const end = harness.indexOf('\nseed_noncanonical_missing_finish_claim() {', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const candidate = harness.slice(start, end);

    expect(candidate).toContain('ENABLE TRIGGER zzzzzz_tournaments_financial_certificate');
    expect(candidate).toContain("UPDATE public.tournaments SET status='COMPLETED'");
    expect(candidate).toContain("evidence->'failures'='[]'::jsonb");
    expect(candidate).toContain("position('rake_not_settled' IN v_message)=0");
    expect(candidate).toContain("position('terminal_break_flag_set' IN v_message)>0");
    expect(candidate).toContain('STAGE_B_TERMINAL_CANDIDATE_FAILURE_DID_NOT_ROLL_BACK');
    expect(candidate).toContain('STAGE_B_TERMINAL_CANDIDATE_BEHAVIOR_OK');
  });

  it('fingerprints all six functions authenticated by the key-share boundary', () => {
    const start = harness.indexOf('emit_keyshare_fingerprint_function() {');
    const end = harness.indexOf('\nemit_terminal_guard_fingerprint_function() {', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const fingerprint = harness.slice(start, end);

    for (const identity of [
      'fn_ca_commit_hand_settlement_exact_before_obligations',
      'fn_ca_resolve_unbound_pending_addons',
      'fn_close_empty_tournament_table',
      'fn_smarter_data_api_pre_request',
      'claim_tournament_lease_v2',
      'heartbeat_tournament_leases_v4',
    ]) {
      expect(fingerprint).toContain(identity);
    }
    expect(fingerprint).toContain('count(*) FROM function_rows WHERE oid IS NOT NULL)<>6');
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
    expect(invariant).not.toContain('NOT v_database_is_pristine AND v_receipt_count = 0');
    expect(invariant).toContain("authority = 'tournament_seat_exit_authority:v1'");
    expect(invariant).toContain("'20260910042020_stage_b_exact_precondition_repairs'");
    expect(invariant).toContain('v_cutover_count <> 1 OR v_authenticated_cutover_count <> 1');
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
    const prefixStart = harness.indexOf('run_chain_prefix() {');
    const prefixEnd = harness.indexOf(
      '\nemit_current_live_tail_postimage_assertion() {',
      prefixStart
    );
    expect(prefixStart).toBeGreaterThanOrEqual(0);
    expect(prefixEnd).toBeGreaterThan(prefixStart);
    const prefixRunner = harness.slice(prefixStart, prefixEnd);
    const preparationStart = harness.indexOf('prepare_current_postimage_template() {');
    const preparationEnd = harness.indexOf(
      '\nkeyshare_postimage_fingerprint() {',
      preparationStart
    );
    expect(preparationStart).toBeGreaterThanOrEqual(0);
    expect(preparationEnd).toBeGreaterThan(preparationStart);
    const preparationRunner = harness.slice(preparationStart, preparationEnd);
    const runners = `${prefixRunner}\n${preparationRunner}`;

    expect(runners).not.toContain('printf "\\\\echo');
    expect(runners).not.toContain('printf "\\\\ir');
    expect(runners).not.toContain('\u001b');
    expect(prefixRunner.match(/printf '%s\\n' "\\\\echo APPLYING/g)).toHaveLength(1);
    expect(prefixRunner.match(/printf '%s\\n' "\\\\echo REPLAYING/g)).toHaveLength(1);
    expect(prefixRunner.match(/printf '%s\\n' "\\\\ir /g)).toHaveLength(2);
    expect(preparationRunner.match(/printf '%s\\n' "\\\\echo APPLYING/g)).toHaveLength(1);
    expect(preparationRunner.match(/printf '%s\\n' "\\\\echo RUNNING/g)).toHaveLength(1);
    expect(preparationRunner.match(/printf '%s\\n' "\\\\echo REPLAYING/g)).toBeNull();
    expect(preparationRunner.match(/printf '%s\\n' "\\\\ir /g)).toHaveLength(2);
    expect(preparationRunner).not.toContain('chain_files[4]');
    expect(harness).not.toContain('#1-#5 or its exact replay');
    expect(diamondFixture).not.toContain('stage_b_diamond_current_postimage_snapshot');
    expect(diamondFixture).not.toContain('assert_stage_b_current_postimage_replay_exact');
    expect(harness).not.toContain('ind.oid');
    expect(harness.match(/CASE WHEN idx\.oid IS NULL THEN NULL/g)).toHaveLength(3);
  });
});
