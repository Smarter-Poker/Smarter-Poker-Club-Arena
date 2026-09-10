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
const contraction = migration(stageBFiles[4]);
const forwardBoundaries = `${expansion}\n${invariant}`;
const harness = readFileSync(
  resolve(root, 'scripts/dev/probe-stage-b-forward-chain-pg17.sh'),
  'utf8'
);
const diamondFixture = readFileSync(
  resolve(root, 'scripts/dev/fixtures/stage-b-diamond-accepted-hand-current-schema.sql'),
  'utf8'
);
const cutoverRunbook = readFileSync(
  resolve(root, 'docs/runbooks/tournament-fractional-stack-cutover.md'),
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
  it('fences every host restart authority for the continuously locked cutover', () => {
    const stopAutoheal = cutoverRunbook.indexOf('docker stop -t 15 sp-autoheal');
    const stopEngine = cutoverRunbook.indexOf('docker stop -t 45 club-arena-engine');
    const canonicalStart = cutoverRunbook.indexOf(
      '/usr/local/lib/club-arena/engine-control/engine-up.sh'
    );
    const startAutoheal = cutoverRunbook.indexOf('docker start sp-autoheal', canonicalStart);
    const startTimer = cutoverRunbook.indexOf(
      'systemctl start club-arena-supervisor.timer',
      startAutoheal
    );

    expect(stopAutoheal).toBeGreaterThanOrEqual(0);
    expect(stopEngine).toBeGreaterThan(stopAutoheal);
    expect(canonicalStart).toBeGreaterThan(stopEngine);
    expect(startAutoheal).toBeGreaterThan(canonicalStart);
    expect(startTimer).toBeGreaterThan(startAutoheal);
    expect(cutoverRunbook).toContain(
      `test "$(docker inspect -f '{{.State.Status}}' sp-autoheal)" = exited`
    );
    expect(cutoverRunbook).toContain(
      `test "$(docker inspect -f '{{.State.Status}}' sp-autoheal)" = running`
    );
  });

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
    const breakWindowOverride =
      "SET LOCAL ca.break_window_migration_override = 'Stage-B 20260910042112 runs only inside its enforced :55 stopped-engine freeze; outside that window its authority is absent';";
    expect(contraction.match(/^SET LOCAL ca\.break_window_migration_override = .*;$/gm)).toEqual([
      breakWindowOverride,
    ]);
    expect(contraction.indexOf(breakWindowOverride)).toBeLessThan(
      contraction.indexOf('SELECT pg_advisory_xact_lock(')
    );
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

  it('requires the byte-authenticated 174349 live schema and a zero-player-data donor', () => {
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
      ['20260910124023', 'a_player_id_is_a_uuid_not_a_uuid_version'],
      ['20260910124524', 'a_bust_the_player_came_back_from_is_a_rebought_bust'],
      ['20260910125453', 'phase_three_versioned_final_deal_expansion'],
      ['20260910130319', 'restore_rake_attribution_retries'],
      ['20260910130421', 'a_revealed_mystery_bounty_may_name_its_own_obligation'],
      ['20260910132341', 'two_nets_that_are_reporting_history_are_answered'],
      ['20260910132644', 'the_supply_meter_swing_did_not_repeat_and_the_ledger_balances'],
      ['20260910132747', 'the_break_scorecard_names_why_a_break_never_started'],
      ['20260910132833', 'a_maintenance_kind_registered_as_info_is_recorded_not_raised'],
      ['20260910134429', 'every_seat_means_every_seat'],
      ['20260910140538', 'a_detector_does_not_report_what_it_already_answered_for'],
      ['20260910141101', 'booked_spin_continuation_preserves_floating_point_rounding'],
      ['20260910143032', 'a_declared_guard_change_is_recorded_not_raised'],
      ['20260910143719', 'the_guard_declaration_is_not_reachable_from_a_browser'],
      ['20260910145833', 'a_place_is_not_a_bounty'],
      ['20260910151228', 'the_door_was_fixed_after_the_manager_stopped_asking'],
      ['20260910154446', 'the_database_refuses_migrations_inside_the_break_window'],
      ['20260910154537', 'the_busts_the_door_can_now_accept_are_recorded'],
      ['20260910154858', 'every_player_who_busted_has_a_place'],
      ['20260910160413', 'a_finished_event_holds_no_pending_bust'],
      ['20260910160841', 'the_break_window_refusal_names_its_rule_and_explains_list_migrations'],
      ['20260910161619', 'training_solver_bounded_canary_authority'],
      ['20260910164655', 'stage_b_break_window_bootstrap_compatibility'],
      ['20260910170356', 'a_handoff_that_names_its_successor_is_not_an_incident'],
      ['20260910170952', 'an_incident_closes_when_the_check_says_zero_not_when_the_clock_says_so'],
      ['20260910171843', 'started_tournaments_resume_or_settle_instead_of_cancelling'],
      ['20260910171857', 'a_refused_finishing_place_creates_no_debt'],
      ['20260910171911', 'a_tournament_elimination_requires_a_finishing_rank'],
      ['20260910171924', 'satellite_seats_count_once_and_keep_the_funded_prize'],
      ['20260910173147', 'the_settlement_lane_is_per_tournament_for_rolling_authorities'],
      ['20260910174349', 'the_bounty_sweep_takes_one_tournament_lane_per_call'],
    ] as const;

    expect(currentLiveSources).toHaveLength(56);
    for (const [version, name] of currentLiveSources) {
      expect(harness).toContain(version);
      expect(harness).toContain(name);
    }
    for (const [version, name, bytes, sha256] of [
      [
        '20260910130319',
        'restore_rake_attribution_retries',
        8151,
        'f912f858c7f35004bfc2447fdf70329afc8a52029970e052c85c8e106fc83f2c',
      ],
      [
        '20260910130421',
        'a_revealed_mystery_bounty_may_name_its_own_obligation',
        6558,
        '2236fdbd5ce9f765dba5e9e5dc2cdb5ae5590f6e3b1f5e5180145b9918b9d400',
      ],
      [
        '20260910132341',
        'two_nets_that_are_reporting_history_are_answered',
        6738,
        '94b9bb3b748e6fe65308a4d8e69418e6afc1b3cd4461684ec655e1595bbf45b7',
      ],
      [
        '20260910132644',
        'the_supply_meter_swing_did_not_repeat_and_the_ledger_balances',
        5495,
        '4824de6d021b3e3e692aa2c061b9e3cd92bd0fd4909bb443f229d6867ecae680',
      ],
      [
        '20260910132747',
        'the_break_scorecard_names_why_a_break_never_started',
        30503,
        '6e21f8eaa025be6a16c13c55e1c691fcd00e0235ec5e6c19fb3f55114d54b413',
      ],
      [
        '20260910132833',
        'a_maintenance_kind_registered_as_info_is_recorded_not_raised',
        5510,
        '93b2edc2cc08effd21f00e66d960046c11077fe0c65278f9ec86526fa502a961',
      ],
      [
        '20260910134429',
        'every_seat_means_every_seat',
        6589,
        '0a460a25ee1948abf643d3067866f5173cb495b80bd395d9c234422cd140ddea',
      ],
      [
        '20260910140538',
        'a_detector_does_not_report_what_it_already_answered_for',
        7356,
        '0fd60dfb93f570c2eb9a718a675fcbc3afdd03d6302688cc99c17eb495074204',
      ],
      [
        '20260910141101',
        'booked_spin_continuation_preserves_floating_point_rounding',
        12053,
        '5965e38e5bafa0568b263332ad448d84340ebc4d50317983474f684ef1529e6f',
      ],
      [
        '20260910143032',
        'a_declared_guard_change_is_recorded_not_raised',
        10216,
        'b8dcbf1388dda22db434f144da18ef3fcbb5a4842850172704fecd20a86db19f',
      ],
      [
        '20260910143719',
        'the_guard_declaration_is_not_reachable_from_a_browser',
        2650,
        '07a00604216e201f811309ab3a07dac65a3f732ef1694e7beeaee40bfd219617',
      ],
      [
        '20260910145833',
        'a_place_is_not_a_bounty',
        14907,
        '6a52ae50c80423153705406a0bf855fd8a04baacba0ef155273455c20078c9a4',
      ],
      [
        '20260910151228',
        'the_door_was_fixed_after_the_manager_stopped_asking',
        4857,
        '5246718dd1252f257a1fb88c3c8d06ce3812391bc4acb3b47be8db6e4217c1ee',
      ],
      [
        '20260910154446',
        'the_database_refuses_migrations_inside_the_break_window',
        20519,
        '772758b80f3a5f44296b84aabdb1def68278f541a1d49b8b58c49f33c5d9f082',
      ],
      [
        '20260910154537',
        'the_busts_the_door_can_now_accept_are_recorded',
        7080,
        '2cf00803afc5bc6dc14cf7aa1c3a0b3284e1c34d1dd008a6945e4bacb4978f55',
      ],
      [
        '20260910154858',
        'every_player_who_busted_has_a_place',
        4795,
        'c6c6bf4bbad5212af762d5f5f3312e09688915ae4d1191199ac779ab967dd373',
      ],
      [
        '20260910160413',
        'a_finished_event_holds_no_pending_bust',
        6134,
        'cf7b45f9ef4f960a25ba03c9f0903366e1f5641adeb54ba55c3b162a03e218f3',
      ],
      [
        '20260910160841',
        'the_break_window_refusal_names_its_rule_and_explains_list_migrations',
        9261,
        '7e018da306ab9d56e82fa603f84535174a2975793aa7a74c4a4e931fc83ef34d',
      ],
      [
        '20260910161619',
        'training_solver_bounded_canary_authority',
        54632,
        'f94a331102a359f2ffa8625f07aa2c0c6ba67191833c56aaeede7a0baab74653',
      ],
      [
        '20260910164655',
        'stage_b_break_window_bootstrap_compatibility',
        27550,
        '4d613b7193b1d1d42950040a336f985c7843db6b095cd02c4d751d27d30c5ec6',
      ],
      [
        '20260910170356',
        'a_handoff_that_names_its_successor_is_not_an_incident',
        7686,
        'bb1c283dc7951c74496e55121d3042d3282a885f96b0e16cbe980a3fc40217f0',
      ],
      [
        '20260910170952',
        'an_incident_closes_when_the_check_says_zero_not_when_the_clock_says_so',
        6485,
        'da17405bdf3ac7ca0c6d5516d0db829ad227f95495c3712864a8a2aad32c8f74',
      ],
      [
        '20260910171843',
        'started_tournaments_resume_or_settle_instead_of_cancelling',
        4722,
        '85e02d3f2350b4c1c7229ab2b58e789b3b8651869c0c3834a3318d7547b10bf6',
      ],
      [
        '20260910171857',
        'a_refused_finishing_place_creates_no_debt',
        24703,
        '69d77f9968d49008f7069fe63b618b802937338e439f631806f02dba0da1220d',
      ],
      [
        '20260910171911',
        'a_tournament_elimination_requires_a_finishing_rank',
        10914,
        'cba4981055d5dd9278d7a882e3b8f0d954cd8ffccb37b6426cf4964c32504b68',
      ],
      [
        '20260910171924',
        'satellite_seats_count_once_and_keep_the_funded_prize',
        31628,
        '9a00bc662f729d5a6db25c4f10a5ceeb45509b230e35f48252620fe9dcef3fc3',
      ],
      [
        '20260910173147',
        'the_settlement_lane_is_per_tournament_for_rolling_authorities',
        50176,
        'bc620a6b093ab9769615427168763bc35aaed44e60ee190202470dfcef0f744b',
      ],
      [
        '20260910174349',
        'the_bounty_sweep_takes_one_tournament_lane_per_call',
        14494,
        '0e209beadad2f8b52e8c72c0bd3559b6fe64fab9917bfb8ac6516a6297f66a17',
      ],
    ] as const) {
      expect(harness).toContain(`('${version}','${name}',1,${bytes},`);
      expect(harness).toContain(sha256);
    }
    for (const [version, name, bytes, sha256] of [
      [
        '20260910154446',
        'the_database_refuses_migrations_inside_the_break_window',
        20519,
        '772758b80f3a5f44296b84aabdb1def68278f541a1d49b8b58c49f33c5d9f082',
      ],
      [
        '20260910154537',
        'the_busts_the_door_can_now_accept_are_recorded',
        7080,
        '2cf00803afc5bc6dc14cf7aa1c3a0b3284e1c34d1dd008a6945e4bacb4978f55',
      ],
      [
        '20260910154858',
        'every_player_who_busted_has_a_place',
        4795,
        'c6c6bf4bbad5212af762d5f5f3312e09688915ae4d1191199ac779ab967dd373',
      ],
      [
        '20260910160413',
        'a_finished_event_holds_no_pending_bust',
        6134,
        'cf7b45f9ef4f960a25ba03c9f0903366e1f5641adeb54ba55c3b162a03e218f3',
      ],
      [
        '20260910160841',
        'the_break_window_refusal_names_its_rule_and_explains_list_migrations',
        9261,
        '7e018da306ab9d56e82fa603f84535174a2975793aa7a74c4a4e931fc83ef34d',
      ],
      [
        '20260910161619',
        'training_solver_bounded_canary_authority',
        54632,
        'f94a331102a359f2ffa8625f07aa2c0c6ba67191833c56aaeede7a0baab74653',
      ],
      [
        '20260910164655',
        'stage_b_break_window_bootstrap_compatibility',
        27550,
        '4d613b7193b1d1d42950040a336f985c7843db6b095cd02c4d751d27d30c5ec6',
      ],
      [
        '20260910170356',
        'a_handoff_that_names_its_successor_is_not_an_incident',
        7686,
        'bb1c283dc7951c74496e55121d3042d3282a885f96b0e16cbe980a3fc40217f0',
      ],
      [
        '20260910170952',
        'an_incident_closes_when_the_check_says_zero_not_when_the_clock_says_so',
        6485,
        'da17405bdf3ac7ca0c6d5516d0db829ad227f95495c3712864a8a2aad32c8f74',
      ],
      [
        '20260910171843',
        'started_tournaments_resume_or_settle_instead_of_cancelling',
        4722,
        '85e02d3f2350b4c1c7229ab2b58e789b3b8651869c0c3834a3318d7547b10bf6',
      ],
      [
        '20260910171857',
        'a_refused_finishing_place_creates_no_debt',
        24703,
        '69d77f9968d49008f7069fe63b618b802937338e439f631806f02dba0da1220d',
      ],
      [
        '20260910171911',
        'a_tournament_elimination_requires_a_finishing_rank',
        10914,
        'cba4981055d5dd9278d7a882e3b8f0d954cd8ffccb37b6426cf4964c32504b68',
      ],
      [
        '20260910171924',
        'satellite_seats_count_once_and_keep_the_funded_prize',
        31628,
        '9a00bc662f729d5a6db25c4f10a5ceeb45509b230e35f48252620fe9dcef3fc3',
      ],
      [
        '20260910173147',
        'the_settlement_lane_is_per_tournament_for_rolling_authorities',
        50176,
        'bc620a6b093ab9769615427168763bc35aaed44e60ee190202470dfcef0f744b',
      ],
      [
        '20260910174349',
        'the_bounty_sweep_takes_one_tournament_lane_per_call',
        14494,
        '0e209beadad2f8b52e8c72c0bd3559b6fe64fab9917bfb8ac6516a6297f66a17',
      ],
    ] as const) {
      const source = migration(`${version}_${name}.sql`);
      expect(Buffer.byteLength(source), `${version} bytes`).toBe(bytes);
      expect(createHash('sha256').update(source).digest('hex'), `${version} SHA-256`).toBe(sha256);
    }
    expect(harness).toContain("current_live_ledger_head='20260910174349'");
    expect(harness).toContain(
      `if [[ "$anchor_receipts" != '56' || "$ledger_head" != "$current_live_ledger_head" ]]`
    );
    expect(harness).toContain(`if [[ "$exact_body_receipts" != '3' ]]`);
    expect(harness).toContain(`if [[ "$descriptor_receipts" != '2' ]]`);
    expect(harness).toContain(
      `if [[ "$audited_tail_receipts" != '40' || "$audited_tail_statements" != '43' ]]`
    );
    expect(harness).toContain(`if [[ "$player_id_functions_exact" != '2' ]]`);
    expect(harness).toContain(`if [[ "$tail_functions_exact" != '14' ]]`);
    expect(harness).toContain("'public.fn_settle_tournament_rake(uuid,text)'");
    expect(harness).toContain('657781a399203068a1a4888354757878');
    expect(harness).toContain('be08a61e1a867519048c4692b41ab1fd');
    expect(harness).toContain('AND p.proconfig=ARRAY[');
    expect(harness).toContain("'search_path=public, pg_temp','statement_timeout=30s']::text[]");
    expect(harness).toContain("'{postgres=X/postgres,service_role=X/postgres}'");
    expect(harness).toContain("'public.fn_attach_bounty_ledger_obligation()'");
    expect(harness).toContain('324f9f652d501cc93daacec52e1b3246');
    expect(harness).toContain('e2028269240a041e38fdc1cb0853e64f');
    expect(harness).toContain("p.proacl::text='{postgres=X/postgres}'");
    expect(harness).toContain("'public.fn_ca_journal_append_only()'");
    expect(harness).toContain('ac9d66e60d077d886981c428c71e5c3c');
    expect(harness).toContain('c19c4314bcb44b29f5d15e32e4dacccd');
    expect(harness).toContain('4a8621f91936630918ecf638130db22089a7b73b343bd10fc33037b63ffae771');
    expect(harness).toContain('b5acbe01ca773e3de3521abf897f37a9cc9d2cb1db36388d2ef6482d21d8792e');
    expect(harness).toContain("p.proconfig=ARRAY['search_path=public']::text[]");
    for (const [table, trigger, triggerType, definitionMd5] of [
      ['agent_commissions', 'trg_ca_append_only', 27, 'b160761b00f1575419c4480048433924'],
      ['chip_ledger', 'trg_ca_append_only', 27, '15d2fb7366e29ca4dcc19a5afb55dfab'],
      ['chip_transactions', 'trg_ca_append_only', 27, '1dcaece880bcbb143e869a3456e53065'],
      ['club_wallet_transactions', 'trg_ca_append_only', 27, '5da93870ace9289608f1de7190d872c0'],
      ['diamond_transactions', 'trg_ca_append_only', 27, '416cec9117a036d12f0ddde4db64b6a5'],
      [
        'diamond_wallet_transfers',
        'wallet_transfers_append_only',
        27,
        'eb1d6ab69891abfa2a4fc11aaff723d8',
      ],
      ['rakeback_period_payouts', 'trg_ca_append_only', 27, 'd7d02bd075ff3fd1a917e50535e1bdd7'],
      ['union_wallet_transactions', 'trg_ca_append_only', 27, '06a711ff9e0e0d5f33cb5bb891d6257c'],
      ['vip_points_ledger', 'trg_ca_append_only', 27, 'c1c67e4ef2138481fd9176346e53b332'],
      ['wallet_transactions', 'trg_ca_append_only', 27, 'b434a15ef432e8562fa6c6df4f0f3cec'],
    ] as const) {
      expect(harness).toContain(`('${table}','${trigger}',${triggerType},`);
      expect(harness).toContain(definitionMd5);
    }
    expect(harness).toContain("('tournament_bounties','trg_attach_bounty_ledger_obligation',7,");
    expect(harness).toContain('ff3e9305edae93d151545b1e39f519c3');
    expect(harness).toContain(`if [[ "$journal_trigger_bindings_exact" != '10'`);
    expect(harness).toContain(`|| "$bounty_trigger_binding_exact" != '1' ]]`);
    for (const [identity, definitionMd5, sourceMd5, definitionBytes] of [
      [
        'public.fn_ca_record_break_scorecard(timestamptz)',
        '0d9eb4d63244cfc69879f87596439c99',
        '00c4e6cb5cba2a4550e332c1f7d33746',
        10536,
      ],
      [
        'public.fn_ca_break_scorecard_push(public.ca_break_scorecards)',
        '0de54de4eee0f2cfee9a5fd9e1e368ff',
        'b76e912f943f096c2fd8ab2ab04e25e1',
        4479,
      ],
      [
        'public.ca_index_every_seat(integer)',
        '0cb93b8670db03efd2b582269fcd9e54',
        '9cf7d1857d41e1c95a8ed1151dff3c0a',
        3022,
      ],
      [
        'public.fn_ca_hand_commit_refusals(integer)',
        '9ba446c4741c6a7d6cd18d717f4418bb',
        '39f7a321222bef7f0e26e2d224a59f46',
        2562,
      ],
      [
        'public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)',
        '8545c67dc20be918ada9027d88f46312',
        '4f83c09a69eecc766a1f3984feeb9823',
        10360,
      ],
    ] as const) {
      expect(harness).toContain(`'${identity}'`);
      expect(harness).toContain(definitionMd5);
      expect(harness).toContain(sourceMd5);
      expect(harness).toContain(`octet_length(pg_get_functiondef(p.oid))=${definitionBytes}`);
    }
    expect(harness).toContain(
      "maintenance_fault_catalog_sha256='085fe4bf17888519604ad3fea787339a9e178c3a1af9ea0aa4d5449512ba8d6d'"
    );
    const breakFaultCatalogStart = harness.indexOf('emit_break_fault_catalog_functions() {');
    const breakFaultCatalogEnd = harness.indexOf('\npreflight="$({', breakFaultCatalogStart);
    expect(breakFaultCatalogStart).toBeGreaterThanOrEqual(0);
    expect(breakFaultCatalogEnd).toBeGreaterThan(breakFaultCatalogStart);
    const breakFaultCatalog = harness.slice(breakFaultCatalogStart, breakFaultCatalogEnd);
    for (const catalogField of [
      "'owner',pg_get_userbyid(c.relowner)",
      "'rls',c.relrowsecurity",
      "'force_rls',c.relforcerowsecurity",
      "'acl',c.relacl",
      "'comment',obj_description(c.oid,'pg_class')",
      "'columns',COALESCE((",
      "'constraints',COALESCE((",
      "'indexes',COALESCE((",
      "'comment',col_description(a.attrelid,a.attnum)",
      "'comment',obj_description(con.oid,'pg_constraint')",
      "'comment',obj_description(idx.oid,'pg_class')",
    ]) {
      expect(breakFaultCatalog).toContain(catalogField);
    }
    expect(breakFaultCatalog).toContain('octet_length(v_fingerprint)<>3421');
    expect(breakFaultCatalog).not.toContain('count(*) FROM public.engine_maintenance_break_faults');
    expect(harness).toContain(
      `if [[ "$break_fault_catalog_exact" != 'STAGE_B_132747_BREAK_FAULT_CATALOG_OK' ]]`
    );
    const donorFingerprint = harness.slice(harness.indexOf('donor_state_fingerprint() {'));
    expect(donorFingerprint).toContain("'volatility',p.provolatile");
    expect(donorFingerprint).toContain("'parallel',p.proparallel");
    expect(donorFingerprint).toContain("'return_type',p.prorettype::regtype::text");
    expect(donorFingerprint).toContain("'public.fn_ca_journal_append_only()'");
    expect(donorFingerprint).toContain("'public.fn_ca_record_break_scorecard(timestamptz)'");
    expect(donorFingerprint).toContain(
      "'public.fn_ca_break_scorecard_push(public.ca_break_scorecards)'"
    );
    expect(donorFingerprint).toContain("'public.ca_index_every_seat(integer)'");
    expect(donorFingerprint).toContain('tail_trigger_bindings AS (');
    expect(donorFingerprint).toContain(
      "'tail_trigger_bindings',(SELECT fingerprint FROM tail_trigger_bindings)"
    );
    expect(donorFingerprint).toContain(
      "'break_fault_catalog',\n           pg_temp.stage_b_132747_break_fault_catalog_fingerprint()"
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

  it('authenticates and fingerprints the complete inactive Phase-3 postimage', () => {
    const phase3Start = harness.indexOf('emit_phase3_postimage_functions() {');
    const phase3End = harness.indexOf('\npreflight="$({', phase3Start);
    expect(phase3Start).toBeGreaterThanOrEqual(0);
    expect(phase3End).toBeGreaterThan(phase3Start);
    const phase3 = harness.slice(phase3Start, phase3End);
    const functionTargets = phase3.match(
      /WITH target_functions\(identity\) AS \(([\s\S]*?)\n\), function_objects AS/
    )?.[1];
    const relationTargets = phase3.match(
      /target_relations\(identity\) AS \(([\s\S]*?)\n\), relation_objects AS/
    )?.[1];

    expect(functionTargets, 'Phase-3 function targets').toBeDefined();
    expect(functionTargets!.match(/^ {4}\('public\./gm)).toHaveLength(16);
    expect(relationTargets, 'Phase-3 relation targets').toBeDefined();
    expect(relationTargets!.match(/^ {4}\('public\./gm)).toHaveLength(5);
    for (const identity of [
      'public.fn_ca_tournament_deal_snapshot(uuid)',
      'public.fn_get_tournament_deal_consensus(uuid)',
      'public.fn_complete_tournament_terminal_proposal(uuid,uuid,text,uuid,text)',
      'public.fn_resolve_tournament_terminal_proposal_outcome(uuid,uuid,text,uuid,text)',
      'public.fn_begin_tournament_deal_review(uuid,uuid)',
      'public.fn_close_tournament_deal_review(uuid,uuid,text)',
    ]) {
      expect(functionTargets).toContain(identity);
      expect(harness.slice(harness.indexOf('donor_state_fingerprint() {'))).toContain(identity);
    }
    for (const relation of [
      'public.tournament_deal_proposals',
      'public.tournament_deal_proposal_consents',
      'public.tournament_deal_proposal_executions',
      'public.tournament_deal_review_policy',
      'public.tournament_deal_reviews',
    ]) {
      expect(relationTargets).toContain(relation);
    }

    expect(harness).toContain(
      "phase3_postimage_sha256='ba43e834350c2f3039413520c174bded6481709eb92ba50363be0c9a4578fb73'"
    );
    expect(phase3).toContain('octet_length(v_fingerprint)<>60578');
    expect(phase3).toContain("'public.tournament_deal_one_active_review'::regclass");
    expect(contraction).toContain(
      "pg_get_expr(i.indpred,i.indrelid,true)=\n         'state = ANY (ARRAY[''requested''::text, ''reviewing''::text])'"
    );
    expect(contraction).not.toContain(
      "'(state = ANY (ARRAY[''requested''::text, ''reviewing''::text]))'"
    );
    expect(phase3).toContain("'tournament_deal_proposal_is_immutable'");
    expect(phase3).toContain("'tournament_deal_consent_is_immutable'");
    expect(phase3).toContain("'tournament_deal_execution_is_immutable'");
    expect(phase3).toContain('WHERE singleton AND request_seconds=120 AND consent_seconds=120');
    expect(phase3).toContain("trg.tgname='require_exact_final_deal_proposal'");
    expect(phase3).toContain("status='approved'");
    expect(phase3).toContain('STAGE_B_125453_PHASE3_PREPARED_TABLES_ARE_NOT_EMPTY');

    expect(harness).toContain(
      "money_control_sha256='32b913b609d9e73469b78bb457845b26785c6c33edcb69131791f83bf0ac0558'"
    );
    expect(harness).toContain(
      "current_money_control_sha256='30f335e1b3770504c9e128ed5c5512c06f4ba440c4cea9b6f25a36bf3c933cc7'"
    );
    expect(phase3).toContain('v_money_rows<>4 OR octet_length(v_money_value)<>1671');
    expect(harness).toContain("'phase3_postimage',(SELECT fingerprint FROM phase3_postimage)");
    expect(harness).toContain('STAGE_B_125453_PHASE3_POSTIMAGE_OK');
  });

  it('authenticates the complete 174349 live tail at both contraction boundaries', () => {
    const guard = dollarBlock(contraction, 'assert_current_live_tail_174349');
    const call = 'SELECT pg_temp.assert_stage_b_current_live_tail_174349_postimage();';
    const definition = contraction.indexOf(
      'CREATE OR REPLACE FUNCTION pg_temp.assert_stage_b_current_live_tail_174349_postimage()'
    );
    const firstCall = contraction.indexOf(call);
    const finalCall = contraction.lastIndexOf(call);
    const durableMutation = contraction.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_ca_open_tournament_seat_exit_authority('
    );

    expect(
      occurrences(
        contraction,
        /CREATE OR REPLACE FUNCTION pg_temp\.assert_stage_b_current_live_tail_174349_postimage\(\)/g
      )
    ).toBe(1);
    expect(
      occurrences(
        contraction,
        /^SELECT pg_temp\.assert_stage_b_current_live_tail_174349_postimage\(\);$/gm
      )
    ).toBe(2);
    expect(definition).toBeGreaterThanOrEqual(0);
    expect(firstCall).toBeGreaterThanOrEqual(0);
    expect(firstCall).toBeGreaterThan(definition);
    expect(firstCall).toBeLessThan(durableMutation);
    expect(finalCall).toBeGreaterThan(firstCall);
    expect(contraction.trimEnd().endsWith(`${call}\n\nCOMMIT;`)).toBe(true);
    expect(contraction.slice(definition, firstCall)).toContain(
      "RETURNS void\nLANGUAGE plpgsql\nSET search_path TO 'pg_catalog','public','extensions','pg_temp'"
    );

    for (const [version, name, bytes, sha256] of [
      [
        '20260910130319',
        'restore_rake_attribution_retries',
        8151,
        'f912f858c7f35004bfc2447fdf70329afc8a52029970e052c85c8e106fc83f2c',
      ],
      [
        '20260910130421',
        'a_revealed_mystery_bounty_may_name_its_own_obligation',
        6558,
        '2236fdbd5ce9f765dba5e9e5dc2cdb5ae5590f6e3b1f5e5180145b9918b9d400',
      ],
      [
        '20260910132341',
        'two_nets_that_are_reporting_history_are_answered',
        6738,
        '94b9bb3b748e6fe65308a4d8e69418e6afc1b3cd4461684ec655e1595bbf45b7',
      ],
      [
        '20260910132644',
        'the_supply_meter_swing_did_not_repeat_and_the_ledger_balances',
        5495,
        '4824de6d021b3e3e692aa2c061b9e3cd92bd0fd4909bb443f229d6867ecae680',
      ],
      [
        '20260910132747',
        'the_break_scorecard_names_why_a_break_never_started',
        30503,
        '6e21f8eaa025be6a16c13c55e1c691fcd00e0235ec5e6c19fb3f55114d54b413',
      ],
      [
        '20260910132833',
        'a_maintenance_kind_registered_as_info_is_recorded_not_raised',
        5510,
        '93b2edc2cc08effd21f00e66d960046c11077fe0c65278f9ec86526fa502a961',
      ],
      [
        '20260910134429',
        'every_seat_means_every_seat',
        6589,
        '0a460a25ee1948abf643d3067866f5173cb495b80bd395d9c234422cd140ddea',
      ],
      [
        '20260910140538',
        'a_detector_does_not_report_what_it_already_answered_for',
        7356,
        '0fd60dfb93f570c2eb9a718a675fcbc3afdd03d6302688cc99c17eb495074204',
      ],
      [
        '20260910141101',
        'booked_spin_continuation_preserves_floating_point_rounding',
        12053,
        '5965e38e5bafa0568b263332ad448d84340ebc4d50317983474f684ef1529e6f',
      ],
      [
        '20260910143032',
        'a_declared_guard_change_is_recorded_not_raised',
        10216,
        'b8dcbf1388dda22db434f144da18ef3fcbb5a4842850172704fecd20a86db19f',
      ],
      [
        '20260910143719',
        'the_guard_declaration_is_not_reachable_from_a_browser',
        2650,
        '07a00604216e201f811309ab3a07dac65a3f732ef1694e7beeaee40bfd219617',
      ],
      [
        '20260910145833',
        'a_place_is_not_a_bounty',
        14907,
        '6a52ae50c80423153705406a0bf855fd8a04baacba0ef155273455c20078c9a4',
      ],
      [
        '20260910151228',
        'the_door_was_fixed_after_the_manager_stopped_asking',
        4857,
        '5246718dd1252f257a1fb88c3c8d06ce3812391bc4acb3b47be8db6e4217c1ee',
      ],
      [
        '20260910154446',
        'the_database_refuses_migrations_inside_the_break_window',
        20519,
        '772758b80f3a5f44296b84aabdb1def68278f541a1d49b8b58c49f33c5d9f082',
      ],
      [
        '20260910154537',
        'the_busts_the_door_can_now_accept_are_recorded',
        7080,
        '2cf00803afc5bc6dc14cf7aa1c3a0b3284e1c34d1dd008a6945e4bacb4978f55',
      ],
      [
        '20260910154858',
        'every_player_who_busted_has_a_place',
        4795,
        'c6c6bf4bbad5212af762d5f5f3312e09688915ae4d1191199ac779ab967dd373',
      ],
      [
        '20260910160413',
        'a_finished_event_holds_no_pending_bust',
        6134,
        'cf7b45f9ef4f960a25ba03c9f0903366e1f5641adeb54ba55c3b162a03e218f3',
      ],
      [
        '20260910160841',
        'the_break_window_refusal_names_its_rule_and_explains_list_migrations',
        9261,
        '7e018da306ab9d56e82fa603f84535174a2975793aa7a74c4a4e931fc83ef34d',
      ],
      [
        '20260910161619',
        'training_solver_bounded_canary_authority',
        54632,
        'f94a331102a359f2ffa8625f07aa2c0c6ba67191833c56aaeede7a0baab74653',
      ],
      [
        '20260910164655',
        'stage_b_break_window_bootstrap_compatibility',
        27550,
        '4d613b7193b1d1d42950040a336f985c7843db6b095cd02c4d751d27d30c5ec6',
      ],
      [
        '20260910170356',
        'a_handoff_that_names_its_successor_is_not_an_incident',
        7686,
        'bb1c283dc7951c74496e55121d3042d3282a885f96b0e16cbe980a3fc40217f0',
      ],
      [
        '20260910170952',
        'an_incident_closes_when_the_check_says_zero_not_when_the_clock_says_so',
        6485,
        'da17405bdf3ac7ca0c6d5516d0db829ad227f95495c3712864a8a2aad32c8f74',
      ],
      [
        '20260910171843',
        'started_tournaments_resume_or_settle_instead_of_cancelling',
        4722,
        '85e02d3f2350b4c1c7229ab2b58e789b3b8651869c0c3834a3318d7547b10bf6',
      ],
      [
        '20260910171857',
        'a_refused_finishing_place_creates_no_debt',
        24703,
        '69d77f9968d49008f7069fe63b618b802937338e439f631806f02dba0da1220d',
      ],
      [
        '20260910171911',
        'a_tournament_elimination_requires_a_finishing_rank',
        10914,
        'cba4981055d5dd9278d7a882e3b8f0d954cd8ffccb37b6426cf4964c32504b68',
      ],
      [
        '20260910171924',
        'satellite_seats_count_once_and_keep_the_funded_prize',
        31628,
        '9a00bc662f729d5a6db25c4f10a5ceeb45509b230e35f48252620fe9dcef3fc3',
      ],
      [
        '20260910173147',
        'the_settlement_lane_is_per_tournament_for_rolling_authorities',
        50176,
        'bc620a6b093ab9769615427168763bc35aaed44e60ee190202470dfcef0f744b',
      ],
      [
        '20260910174349',
        'the_bounty_sweep_takes_one_tournament_lane_per_call',
        14494,
        '0e209beadad2f8b52e8c72c0bd3559b6fe64fab9917bfb8ac6516a6297f66a17',
      ],
    ] as const) {
      expect(guard).toContain(`('${version}','${name}',${bytes},`);
      expect(guard).toContain(sha256);
    }
    expect(guard).toContain("IS DISTINCT FROM '20260910174349' THEN");
    expect(guard).toContain('all twenty-eight byte-exact 130319-174349 live-tail migrations');
    expect(guard).toContain('cardinality(m.statements) IS DISTINCT FROM 1');
    expect(guard).toContain('octet_length(m.statements[1]) IS DISTINCT FROM');
    expect(guard).toContain("convert_to(m.statements[1],'UTF8'),'sha256'");

    for (const [identity, definitionMd5, sourceMd5] of [
      [
        'public.fn_settle_tournament_rake(uuid,text)',
        '657781a399203068a1a4888354757878',
        'be08a61e1a867519048c4692b41ab1fd',
      ],
      [
        'public.fn_attach_bounty_ledger_obligation()',
        '324f9f652d501cc93daacec52e1b3246',
        'e2028269240a041e38fdc1cb0853e64f',
      ],
      [
        'public.fn_ca_journal_append_only()',
        'ac9d66e60d077d886981c428c71e5c3c',
        'c19c4314bcb44b29f5d15e32e4dacccd',
      ],
      [
        'public.fn_ca_record_break_scorecard(timestamp with time zone)',
        '0d9eb4d63244cfc69879f87596439c99',
        '00c4e6cb5cba2a4550e332c1f7d33746',
      ],
      [
        'public.fn_ca_break_scorecard_push(public.ca_break_scorecards)',
        '0de54de4eee0f2cfee9a5fd9e1e368ff',
        'b76e912f943f096c2fd8ab2ab04e25e1',
      ],
      [
        'public.ca_index_every_seat(integer)',
        '0cb93b8670db03efd2b582269fcd9e54',
        '9cf7d1857d41e1c95a8ed1151dff3c0a',
      ],
      [
        'public.fn_ca_hand_commit_refusals(integer)',
        '9ba446c4741c6a7d6cd18d717f4418bb',
        '39f7a321222bef7f0e26e2d224a59f46',
      ],
      [
        'public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)',
        '8545c67dc20be918ada9027d88f46312',
        '4f83c09a69eecc766a1f3984feeb9823',
      ],
      [
        'public.fn_ca_declare_guard_redefinition(text,text)',
        '3a3746dc6e0a5b7a1db97805588c0eb8',
        '9d10bbc7e34373e82ce9e92e563297bc',
      ],
      [
        'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)',
        '5437a59dbe68a08e9df13baa422a903c',
        '590f0f782e127288f33763bbab8c89f0',
      ],
      [
        'public.fn_ca_break_window_ddl_guard()',
        '6ea4dfd3876346b309a06db40ee8fadd',
        'b698de4b9ae596b1814928e78ee668c9',
      ],
      [
        'public.fn_ca_break_window_governs(text,text)',
        '2b30cf850c450681f97b90e7598f0412',
        '9bc3e63d54109b30f4ad808e36843b82',
      ],
      [
        'public.fn_ca_break_window_refuses_migrations(timestamp with time zone)',
        '0c5f501b57d8d704edbe24a036630e2d',
        '79b467b435ed6d368f9da32d5908cc79',
      ],
      [
        'public.fn_ca_stage_b_ledger_bootstrap_allowed(text,text,text)',
        '8cbd9ea1c1dbc24c24be02fb9d447b20',
        'ac9d5cdc943e88aa0c0bb6cd2410fbdc',
      ],
      [
        'public.fn_ca_financial_alert_to_incident()',
        '5f01207b21a3e2353f6c47291162f22a',
        '2479f66166ce003c48896d1aab55487b',
      ],
      [
        'public.fn_ca_close_incidents_the_check_no_longer_finds()',
        '0c1a9e2e63771d7dfbf2c305b057b0f2',
        '8e2005a0cfa79cf14e396ceb799df926',
      ],
      [
        'public.fn_ca_escrow_on_rake_record()',
        '0dc096bb5615758ed945365a45997c8c',
        '3e628d6a57a93eeb61d494ee33f989a3',
      ],
      [
        'public.fn_ca_tournament_escrow(uuid)',
        '68d99bdb6dc9a46906336b9ed6987e97',
        '56663389f8348d2ab35a54460c0b7632',
      ],
      [
        'public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)',
        '9877846ffabee004690e6b24a3ddcee2',
        '3acb4c1d763181905cf5b64287f8f28f',
      ],
      [
        'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)',
        '1b03285a00dc01df0f177e25ebe57147',
        '0f491a45693fcf3182719647c5ed7aee',
      ],
      [
        'public.fn_ca_release_unseatable_registrant_at_launch(uuid,uuid,uuid,text)',
        'cf10ddacc96d73a7e8adb6785ca1d331',
        '4170a9f0298fb2e1e97ab7be5e2ec048',
      ],
      [
        'public.fn_lock_daily_mission_user(uuid)',
        '0e9d2905374930bda4529a8febc6eff6',
        '66c5a8c8da7471773a58dd7c346c9df0',
      ],
      [
        'public.fn_mystery_bounty_pay(uuid)',
        'd666baf91b06f9305191fcbc0b9c7aee',
        '8f16f673aeaafac711da36b0df9466a2',
      ],
      [
        'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
        '43c53a2b376cb28161584db487bfd17c',
        'f00ad0e9a08496d96f6375cbf6f30678',
      ],
      [
        'public.fn_satellite_target_player_provenance_is_immutable()',
        '68f98d4ec2cb186aae11787f1666cffc',
        '266a6b06f5cc44bc953ca4c31933d7db',
      ],
      [
        'public.fn_tournament_live_seat_acquisition_requires_authority()',
        '82f74aa99f0bbdeace392401c25e0ba1',
        '5a60bdd761aaaaad4b3bf982a3c50f6e',
      ],
      [
        'public.fn_tournament_payouts_are_append_only()',
        'f3fca4d1245a05dcc03d98a93d0a641a',
        '6cfe150a2a360d878c9c389499e7b196',
      ],
      [
        'public.fn_sweep_pending_tournament_bounties(uuid,integer)',
        '30ca1181317d0f76d7a549ceab37b493',
        '9a16c59eb58695facd75a2d7406b7c28',
      ],
    ] as const) {
      expect(guard).toContain(identity);
      expect(guard).toContain(definitionMd5);
      expect(guard).toContain(sourceMd5);
    }
    const compactGuard = guard.replace(/\s+/g, '');
    for (const exactCatalogRow of [
      `('public.fn_ca_escrow_on_rake_record()',
        '0dc096bb5615758ed945365a45997c8c','3e628d6a57a93eeb61d494ee33f989a3',
        'plpgsql',true,'v','u',false,false,'f',false,'trigger',0,0,
        ARRAY['search_path=public']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
      `('public.fn_ca_tournament_escrow(uuid)',
        '68d99bdb6dc9a46906336b9ed6987e97','56663389f8348d2ab35a54460c0b7632',
        'sql',true,'s','u',false,false,'f',true,'record',1,0,
        ARRAY['search_path=public']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
      `('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)',
        '9877846ffabee004690e6b24a3ddcee2','3acb4c1d763181905cf5b64287f8f28f',
        'plpgsql',false,'v','u',false,false,'f',false,'void',2,1,
        ARRAY['search_path=public, pg_temp']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
      `('public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)',
        '1b03285a00dc01df0f177e25ebe57147','0f491a45693fcf3182719647c5ed7aee',
        'plpgsql',true,'v','u',false,false,'f',false,'uuid',3,1,
        ARRAY['search_path=public, pg_temp']::text[],'{postgres=X/postgres}')`,
      `('public.fn_ca_release_unseatable_registrant_at_launch(uuid,uuid,uuid,text)',
        'cf10ddacc96d73a7e8adb6785ca1d331','4170a9f0298fb2e1e97ab7be5e2ec048',
        'plpgsql',true,'v','u',false,false,'f',false,'jsonb',4,1,
        ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
      `('public.fn_lock_daily_mission_user(uuid)',
        '0e9d2905374930bda4529a8febc6eff6','66c5a8c8da7471773a58dd7c346c9df0',
        'plpgsql',true,'v','u',false,false,'f',false,'void',1,0,
        ARRAY['search_path=pg_catalog, public, pg_temp']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
      `('public.fn_mystery_bounty_pay(uuid)',
        'd666baf91b06f9305191fcbc0b9c7aee','8f16f673aeaafac711da36b0df9466a2',
        'plpgsql',true,'v','u',false,false,'f',false,'jsonb',1,0,
        ARRAY['search_path=public, pg_temp']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
      `('public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
        '43c53a2b376cb28161584db487bfd17c','f00ad0e9a08496d96f6375cbf6f30678',
        'plpgsql',true,'v','u',false,false,'f',false,'jsonb',7,0,
        ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
      `('public.fn_satellite_target_player_provenance_is_immutable()',
        '68f98d4ec2cb186aae11787f1666cffc','266a6b06f5cc44bc953ca4c31933d7db',
        'plpgsql',true,'v','u',false,false,'f',false,'trigger',0,0,
        ARRAY['search_path=public']::text[],'{postgres=X/postgres}')`,
      `('public.fn_tournament_live_seat_acquisition_requires_authority()',
        '82f74aa99f0bbdeace392401c25e0ba1','5a60bdd761aaaaad4b3bf982a3c50f6e',
        'plpgsql',true,'v','u',false,false,'f',false,'trigger',0,0,
        ARRAY['search_path=public, pg_temp']::text[],'{postgres=X/postgres}')`,
      `('public.fn_tournament_payouts_are_append_only()',
        'f3fca4d1245a05dcc03d98a93d0a641a','6cfe150a2a360d878c9c389499e7b196',
        'plpgsql',false,'v','u',false,false,'f',false,'trigger',0,0,
        ARRAY['search_path=public']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
      `('public.fn_sweep_pending_tournament_bounties(uuid,integer)',
        '30ca1181317d0f76d7a549ceab37b493','9a16c59eb58695facd75a2d7406b7c28',
        'plpgsql',true,'v','u',false,false,'f',false,'jsonb',2,2,
        ARRAY['search_path=public, pg_temp']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
    ] as const) {
      expect(compactGuard).toContain(exactCatalogRow.replace(/\s+/g, ''));
    }
    expect(guard).toContain('IF v_count<>28 OR v_bad<>0 THEN');
    expect(guard).toContain(
      'md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM\n                   expected.definition_md5'
    );
    expect(guard).toContain('md5(p.prosrc) IS DISTINCT FROM expected.source_md5');
    expect(guard).toContain("p.proowner IS DISTINCT FROM 'postgres'::regrole");
    expect(guard).toContain('l.lanname IS DISTINCT FROM expected.language_name');
    expect(guard).toContain('p.prosecdef IS DISTINCT FROM expected.security_definer');
    expect(guard).toContain('p.provolatile IS DISTINCT FROM expected.volatility::"char"');
    expect(guard).toContain('p.proparallel IS DISTINCT FROM expected.parallel_safety::"char"');
    expect(guard).toContain('p.proisstrict IS DISTINCT FROM expected.is_strict');
    expect(guard).toContain('p.proleakproof IS DISTINCT FROM expected.is_leakproof');
    expect(guard).toContain('p.prokind IS DISTINCT FROM expected.kind::"char"');
    expect(guard).toContain('p.proretset IS DISTINCT FROM expected.returns_set');
    expect(guard).toContain('p.prorettype IS DISTINCT FROM to_regtype(expected.return_type)');
    expect(guard).toContain('p.pronargs IS DISTINCT FROM expected.nargs');
    expect(guard).toContain('p.pronargdefaults IS DISTINCT FROM expected.argdefaults');
    expect(guard).toContain('p.proconfig IS DISTINCT FROM expected.configuration');
    expect(guard).toContain('p.proacl::text IS DISTINCT FROM expected.acl_text');
    expect(guard).toContain("ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]");
    expect(guard).toContain("'{postgres=X/postgres,service_role=X/postgres}'");
    expect(guard).toContain("'{postgres=X/postgres}'");
    for (const breakWindowCatalogEntry of [
      'ca_break_window_migration_overrides',
      'ca_break_window_migration_overrides_reason_check',
      'ca_break_window_migration_overrides_id_seq',
      'ca_break_window_refuses_ddl',
      'ca_break_window_refuses_drops',
      'ddl_command_end',
      'sql_drop',
      '{postgres=arwdDxtm/postgres,service_role=r/postgres}',
      '{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}',
    ]) {
      expect(guard).toContain(breakWindowCatalogEntry);
    }

    for (const guardDefinitionCatalogEntry of [
      'ca_guard_defs',
      'declared_ref',
      'declared_at',
      'ca_guard_defs_pkey',
      '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}',
      'The migration that deliberately redefined this guard and moved the baseline',
    ]) {
      expect(guard).toContain(guardDefinitionCatalogEntry);
    }
    expect(guard).toContain('IF v_count<>5 OR v_bad<>0 OR (');

    for (const catalogEntry of [
      'engine_maintenance_break_faults',
      'announced_at',
      'engine_version',
      'engine_maintenance_break_faults_outcome_check',
      'engine_maintenance_break_faults_stage_check',
      'engine_maintenance_break_faults_pkey',
      'idx_engine_maintenance_break_faults_announced_at',
      '{postgres=arwdDxtm/postgres,service_role=ar/postgres}',
      'no browser role may do either.',
    ]) {
      expect(guard).toContain(catalogEntry);
    }
    expect(guard).toContain('FROM pg_policy policy');
    expect(guard).toContain('IF v_count<>7 OR v_bad<>0 OR (');
    expect(guard).toContain('IF v_count<>3 OR v_bad<>0 OR (');
    expect(guard).toContain('IF v_count<>2 OR v_bad<>0 OR (');
    expect(guard).toContain('format_type(a.atttypid,a.atttypmod)');
    expect(guard).toContain('pg_get_constraintdef(con.oid,true)');
    expect(guard).toContain(
      'constraint_name,constraint_type,is_deferrable,is_deferred,is_validated,no_inherit'
    );
    expect(guard).not.toContain(
      'constraint_name,constraint_type,deferrable,deferred,validated,no_inherit'
    );
    expect(guard).toContain('pg_get_indexdef(i.indexrelid)');

    for (const triggerHash of [
      'ff3e9305edae93d151545b1e39f519c3',
      'b160761b00f1575419c4480048433924',
      '15d2fb7366e29ca4dcc19a5afb55dfab',
      '1dcaece880bcbb143e869a3456e53065',
      '5da93870ace9289608f1de7190d872c0',
      '416cec9117a036d12f0ddde4db64b6a5',
      'eb1d6ab69891abfa2a4fc11aaff723d8',
      'd7d02bd075ff3fd1a917e50535e1bdd7',
      '06a711ff9e0e0d5f33cb5bb891d6257c',
      'c1c67e4ef2138481fd9176346e53b332',
      'b434a15ef432e8562fa6c6df4f0f3cec',
      'c7350e02f70dcd0a95b3325bcbdab924',
      'bf08da3e12849cf1cf33226441d9e116',
      'd33542ca1293e3c444ae151d9659e28a',
      '9ec06cfc7cbf46abb8159a5ce13fb59e',
      '12f229da39eeba946d4230155f854b0d',
    ]) {
      expect(guard).toContain(triggerHash);
    }
    for (const exactTriggerRow of [
      `('public.fn_ca_escrow_on_rake_record()',
        'public.rake_records','zz_ca_escrow_rake_record',
        'bf08da3e12849cf1cf33226441d9e116',5,'',true)`,
      `('public.fn_tournament_live_seat_acquisition_requires_authority()',
        'public.table_seats','a0_tournament_live_seat_root_guard',
        'd33542ca1293e3c444ae151d9659e28a',23,'2 4 3 13',false)`,
      `('public.fn_satellite_target_player_provenance_is_immutable()',
        'public.tournament_players','satellite_target_player_provenance_is_immutable',
        '9ec06cfc7cbf46abb8159a5ce13fb59e',31,'1 2 3 21 25',false)`,
      `('public.fn_tournament_payouts_are_append_only()',
        'public.tournament_payouts','trg_tournament_payouts_append_only',
        '12f229da39eeba946d4230155f854b0d',27,'',false)`,
    ] as const) {
      expect(compactGuard).toContain(exactTriggerRow.replace(/\s+/g, ''));
    }
    expect(guard).toContain('md5(pg_get_triggerdef(tg.oid,true))');
    expect(guard).toContain('IF v_count<>16 OR v_bad<>0 OR (');
    expect(guard).toContain('tg.tgfoid=ANY(ARRAY[');
    expect(guard).toContain('tg.tgenabled IS DISTINCT FROM');
    expect(guard).toContain('tg.tgisinternal IS DISTINCT FROM false');
    expect(guard).toContain('tg.tgdeferrable IS DISTINCT FROM false');
    expect(guard).toContain('tg.tginitdeferred IS DISTINCT FROM false');
    expect(guard).toContain('tg.tgtype IS DISTINCT FROM expected.trigger_type');
    expect(guard).toContain('tg.tgattr::text IS DISTINCT FROM expected.attribute_numbers');
    expect(guard).toContain(
      '(tg.tgqual IS NOT NULL) IS DISTINCT FROM\n                   expected.has_qualifier'
    );
    expect(guard).toContain('tg.tgnargs IS DISTINCT FROM 0');
    expect(guard).toContain(')<>16 THEN');
    expect(guard).not.toContain('ca_drift_incidents');
    expect(guard).not.toContain('resolved_at');

    const mutablePreimage = dollarBlock(
      contraction,
      'require_stage_b_171924_mutable_function_preimage'
    );
    const mutableCarry = dollarBlock(contraction, 'verify_stage_b_171924_mutable_sources_carried');
    expect(contraction.indexOf('$require_stage_b_171924_mutable_function_preimage$')).toBeLessThan(
      durableMutation
    );
    expect(contraction.indexOf('$verify_stage_b_171924_mutable_sources_carried$')).toBeGreaterThan(
      durableMutation
    );
    expect(contraction.indexOf('$verify_stage_b_171924_mutable_sources_carried$')).toBeLessThan(
      finalCall
    );
    for (const exactMutableRow of [
      `('public.atomic_cancel_tournament(uuid,uuid)',
        'bdfeeafe38b7691305f02c741faa1d12','16ea7acbbf76613a0a1193dff18f1330',
        33038,'c2e469b5894407c7a806b30177bf0062654effcfddc378544e038426b6691dc6',
        32778,'30288544fd40e61f902fd6f363368e05e220cbef06ab10edba9ea1e387709f2c',
        2,0,ARRAY['search_path=public, extensions, pg_temp',
                  'statement_timeout=120s']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
      `('public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
        '5a3aa8bd1a48d18b793e39c09b645b41','ebabbaf0456d80335aaa2e04471d0ab6',
        21743,'531dbe7ba420ccfcff790ee90b0452e74f1a0232dbdd7535c9376d6696ee58cf',
        21367,'7f51ae874957250d6e2c5df40573170e6deaafe8f1d39b5417a41587c419a1ad',
        8,2,ARRAY['search_path=public']::text[],'{postgres=X/postgres}')`,
      `('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)',
        'eefbf339094c8bc7420ef226132ae453','b4937067d9bf337e1466095b9e1d5424',
        8145,'51c2f60bf067ca670e00631089e0268ecf6cb6f7c64a0401b710c200b617293d',
        7848,'b4daec2a24918030b2bef95fab45d1518bfc57cfae8dfbe9a9d948dda369c321',
        5,1,ARRAY['search_path=public, pg_temp']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
      `('public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
        '208fe48a2697811d14e55a64271083a6','2c21c56c6a9d4a2f8ee79082bd4fef57',
        13012,'3346c472a44a350bb0a8a88fc4b9e834be8b33bdf01ea57c7bc37576ae9b0bab',
        12717,'b10fdda12351a80c3775a28d5667a4eee9ac91b281ee3925793c44b4122d54dc',
        5,2,ARRAY['search_path=public']::text[],
        '{postgres=X/postgres,service_role=X/postgres}')`,
    ] as const) {
      expect(mutablePreimage.replace(/\s+/g, '')).toContain(exactMutableRow.replace(/\s+/g, ''));
    }
    expect(mutablePreimage).toContain('IF v_count<>4 OR v_bad<>0 THEN');
    expect(mutablePreimage).toContain('octet_length(pg_get_functiondef(p.oid))');
    expect(mutablePreimage).toContain("convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'");
    expect(mutablePreimage).toContain('octet_length(p.prosrc)<>expected.source_bytes');
    expect(mutablePreimage).toContain("convert_to(p.prosrc,'UTF8'),'sha256'");
    for (const [identity, sourceMd5, sourceBytes] of [
      [
        'public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)',
        '16ea7acbbf76613a0a1193dff18f1330',
        32778,
      ],
      [
        'public.fn_eliminate_tournament_player_atomic_pre_seat_guard(uuid,uuid,integer,numeric,numeric)',
        'b4937067d9bf337e1466095b9e1d5424',
        7848,
      ],
      [
        'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',
        'ebabbaf0456d80335aaa2e04471d0ab6',
        21367,
      ],
      [
        'public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
        '2c21c56c6a9d4a2f8ee79082bd4fef57',
        12717,
      ],
    ] as const) {
      expect(mutableCarry).toContain(identity);
      expect(mutableCarry).toContain(`md5(p.prosrc)='${sourceMd5}'`);
      expect(mutableCarry).toContain(`octet_length(p.prosrc)=${sourceBytes}`);
    }

    const rollingLaneMigration = migration(
      '20260910173147_the_settlement_lane_is_per_tournament_for_rolling_authorities.sql'
    );
    const rollingLane = functionBody(
      rollingLaneMigration,
      'fn_ca_lock_settlement_lane_for_tournament'
    );
    const seatExit = functionBody(contraction, 'fn_ca_open_tournament_seat_exit_authority');
    const moveResolver = functionBody(contraction, 'fn_resolve_committed_tournament_seat_move');
    expect(rollingLane).toContain('PERFORM pg_advisory_xact_lock_shared(');
    expect(rollingLane).toContain("hashtextextended('ca:tournament-terminal-settlement:v1', 0)");
    expect(rollingLane).toContain(
      "hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0)"
    );
    expect(
      occurrences(seatExit, /fn_ca_lock_settlement_lane_for_tournament\(p_tournament_id\)/g)
    ).toBe(1);
    expect(seatExit).not.toContain('fn_ca_lock_settlement_lane_global');
    expect(occurrences(moveResolver, /PERFORM pg_advisory_xact_lock_shared\(/g)).toBe(2);
    expect(moveResolver).toContain("hashtextextended('ca:tournament-terminal-settlement:v1',0)");
    expect(moveResolver).toContain(
      "hashtextextended('ca:tournament-terminal-settlement:v1:'||p_tournament_id::text,0)"
    );
    expect(moveResolver).not.toContain('fn_ca_lock_settlement_lane_for_tournament');

    const finalPostimage = dollarBlock(contraction, 'verify_current_postimage_contraction');
    expect(finalPostimage).toContain('3acb4c1d763181905cf5b64287f8f28f');
    expect(finalPostimage).not.toContain('2bc939035496d764ff9d6c14b52fa1e7');
    expect(finalPostimage).toMatch(
      /AND p\.prosrc NOT LIKE\s+'%p_operation IN \(''cancel'',''satellite_finish'',''terminal_finish''\)%'/
    );
    expect(finalPostimage).not.toContain('mixed tournament seat-exit lane dispatch drifted');
    expect(finalPostimage).toContain(
      'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'
    );
    expect(finalPostimage).toContain('pg_advisory_xact_lock_shared');

    const bountySweep = functionBody(
      migration('20260910174349_the_bounty_sweep_takes_one_tournament_lane_per_call.sql'),
      'fn_sweep_pending_tournament_bounties'
    );
    expect(occurrences(bountySweep, /fn_ca_lock_settlement_lane_for_tournament\(v_scope\)/g)).toBe(
      1
    );
    expect(bountySweep).toContain('AND bo.tournament_id = v_scope');
    expect(bountySweep).not.toContain('fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)');
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
      'STAGE_B_125453_PHASE3_POSTIMAGE_OK',
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
