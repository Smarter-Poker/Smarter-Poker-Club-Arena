/**
 * Stage B is one bounded six-migration authority chain. These laws pin the
 * chain, its stopped-engine authority, the objects it owns, and the executable
 * rehearsal without coupling it to unrelated feature migrations or a moving
 * database ledger head.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const migrationsDirectory = resolve(root, 'supabase/migrations');

const chain = [
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

function migrationFile(suffix: string): string {
  const matches = readdirSync(migrationsDirectory).filter(
    (file) => file.endsWith('_' + suffix + '.sql') || file.endsWith('_' + suffix + '.sql.pending')
  );
  expect(matches, suffix + ' migration').toHaveLength(1);
  return resolve(migrationsDirectory, matches[0]);
}

function migration(suffix: string): string {
  return readFileSync(migrationFile(suffix), 'utf8');
}

function dollarBlock(source: string, tag: string): string {
  const delimiter = '$' + tag + '$';
  const start = source.indexOf(delimiter);
  const end = source.indexOf(delimiter, start + delimiter.length);
  expect(start, 'opening ' + delimiter).toBeGreaterThanOrEqual(0);
  expect(end, 'closing ' + delimiter).toBeGreaterThan(start);
  return source.slice(start + delimiter.length, end);
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
  expect(start, name + ' definition').toBeGreaterThanOrEqual(0);
  const tail = source.slice(start);
  const opening = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(tail);
  expect(opening, name + ' body delimiter').not.toBeNull();
  const bodyStart = start + opening!.index + opening![0].length;
  const bodyEnd = source.indexOf(opening![1], bodyStart);
  expect(bodyEnd, name + ' body terminator').toBeGreaterThan(bodyStart);
  return source.slice(bodyStart, bodyEnd);
}

const sources = chain.map(([suffix]) => migration(suffix));
const [expansion, repair, invariant, atomicFinish, contraction, keyshare] = sources;
const harness = readFileSync(
  resolve(root, 'scripts/dev/probe-stage-b-forward-chain-pg17.sh'),
  'utf8'
);
const bountyRebuyProbe = readFileSync(
  resolve(root, 'scripts/ci/probes/bounty-rebuy-generation-atomicity.sql'),
  'utf8'
);
const runbook = readFileSync(
  resolve(root, 'docs/runbooks/lease-heartbeat-keyshare-cutover.md'),
  'utf8'
);
const zeroAuthority = readFileSync(
  resolve(root, 'scripts/ops/verify-stage-b-zero-authority.sh'),
  'utf8'
);
const productionPostimage = readFileSync(
  resolve(
    migrationsDirectory,
    '20260910034411_seat_proof_lock_generic_plan_lobby_policy_hashed_and_tick_in.sql'
  ),
  'utf8'
);

const unrelated = [
  '20260910065825',
  '20260910125453',
  '20260910161619',
  '20260910170952',
  '20260910181625',
  '20260910183316',
] as const;

describe('the reserved Stage-B forward authority remains one bounded chain', () => {
  it('resolves exactly one staged or promoted source for every immutable logical identity', () => {
    expect(sources).toHaveLength(6);
    chain.forEach(([, logical], index) => {
      expect(sources[index].split(/\r?\n/, 1)[0]).toBe('-- ' + logical);
    });
    expect(harness).toContain('chain_names=(');
    expect(harness).toContain('chain_logical_ids=(');
    for (const [suffix, logical] of chain) {
      expect(harness).toContain(suffix);
      expect(harness).toContain(logical.slice(0, 14));
    }
  });

  it('fences every restart authority for one continuously locked cutover', () => {
    const stopAutoheal = runbook.indexOf('docker stop -t 15 sp-autoheal');
    const stopEngine = runbook.indexOf('docker stop -t 45 club-arena-engine');
    const canonicalStart = runbook.indexOf('/usr/local/lib/club-arena/engine-control/engine-up.sh');
    const startAutoheal = runbook.indexOf('docker start sp-autoheal', canonicalStart);
    const startTimer = runbook.indexOf(
      'systemctl start club-arena-supervisor.timer',
      startAutoheal
    );
    expect(stopAutoheal).toBeGreaterThanOrEqual(0);
    expect(stopEngine).toBeGreaterThan(stopAutoheal);
    expect(canonicalStart).toBeGreaterThan(stopEngine);
    expect(startAutoheal).toBeGreaterThan(canonicalStart);
    expect(startTimer).toBeGreaterThan(startAutoheal);
    expect(runbook).toContain('verify-stage-b-zero-authority.sh "$SHA8"');
    expect(zeroAuthority).toContain('STAGE_B_ZERO_AUTHORITY_VERIFIED');
  });

  it('authenticates bounded prerequisites instead of a moving ledger head', () => {
    expect(harness).not.toContain('current_live_ledger_head');
    expect(harness).not.toContain('SELECT max(version)');
    expect(harness).toContain('if [[ "$anchor_receipts" != \'62\' ]]');
    expect(harness).toContain('if [[ "$descriptor_receipts" != \'11\' ]]');
    expect(harness).toContain(
      'if [[ "$audited_tail_receipts" != \'38\' || "$audited_tail_statements" != \'41\' ]]'
    );
    expect(harness).toContain('if [[ "$tail_functions_exact" != \'12\' ]]');
    expect(harness).toContain('assert_zero_player_data_baseline');
    expect(harness).toContain('20260910164655');
    for (const exactFinalDealPrerequisite of [
      '20260911050554',
      'final_deal_receipts_survive_real_terminal_settlement',
      '82770',
      'b4af55173b825be5ecf48c6c3bbcca1e828493cdafc47becf00d73ad3186c871',
    ]) {
      expect(harness).toContain(exactFinalDealPrerequisite);
    }
    expect(harness).toContain('final_deal_v2_functions');
    expect(harness).toContain('p.prorettype=expected.return_type::regtype');
    expect(harness).toContain('p.proacl::text=CASE WHEN expected.service_execute');
    expect(harness).toContain('AND p.proconfig=expected.config');
    expect(harness).toContain("final_deal_v2_functions_exact\" != '1'");
    expect(harness).toContain("final_deal_v2_schema_exact\" != '1'");
    expect(harness.match(/AND NOT c\.relforcerowsecurity/g)).toHaveLength(2);
    expect(harness.match(/\{postgres=arwdDxtm\/postgres,service_role=r\/postgres\}/g)).toHaveLength(
      2
    );
    expect(harness).toContain('STAGE_B_11050554_TABLE_CATALOG_CHANGED');
    for (const exactFinalDealPostimage of [
      '96a61ea5e16560735bcb70b355aa79ab',
      '90f7506df2f1a94fe22952714fcd9f85',
      'bb4b0e1d1c758943fca29f9a83d064e4',
      '260c94b41d7f2bb021a88a546a1714ac',
      '82078938fd926c94a0ab778acd77dd61',
      '3e43d26ddd36a55e736a9a304a89ba9a',
      'ddc5e3121ed9cc73d41525e6c1ba6c34',
      'd994347e1b76c936ce13361d73f94fd2',
      '80362aed787137219432f6039bf03158',
      'b1941b2e55dade307ecd74068ab3e500',
      '9f5f5fefa77ae93bfeffc9f414a63a0d',
      'd338c5278ef1247ff0f4a7c4ba774cc5',
      '993e6e1de9edba2fe235d86ff6c243c9',
      '3585ddbfdb0a197243d5e6eefb6b670f',
      'f1fc7a0bf480b1034f0f1d9cba3b4d0b',
      '852e35483b67c1fc59b6347b51c79cb8',
      'e685ad4c6440decb7f57310d455c5bd0',
      '8e0d121a711f6b7afade68125d032f8d',
    ]) {
      expect(harness).toContain(exactFinalDealPostimage);
    }
    for (const version of unrelated) expect(harness).not.toContain(version);
    expect(harness).not.toContain('phase3_postimage');
    expect(harness).not.toContain('STAGE_B_125453_PHASE3_POSTIMAGE_OK');
  });

  it('contracts only Stage-B-owned mutable preimages and the exact bootstrap', () => {
    expect(contraction).toContain('assert_stage_b_owned_postimage');
    expect(contraction).toContain('SELECT pg_temp.assert_stage_b_owned_postimage(false);');
    expect(contraction).toContain('SELECT pg_temp.assert_stage_b_owned_postimage(true);');
    expect(contraction).toContain('20260910164655');
    expect(contraction).toContain(
      '4d613b7193b1d1d42950040a336f985c7843db6b095cd02c4d751d27d30c5ec6'
    );
    expect(contraction).toContain('IF v_count<>9 OR v_bad<>0 THEN');
    for (const identity of [
      'fn_settle_tournament_rake',
      'fn_claim_bounty_legacy_candidate_20260907',
      'fn_ca_open_tournament_seat_exit_authority',
      'fn_mystery_bounty_pay',
      'fn_resolve_committed_tournament_seat_move',
    ]) {
      expect(contraction).toContain(identity);
    }
    for (const version of unrelated) expect(contraction).not.toContain(version);
    for (const rpc of [
      'fn_require_exact_final_deal_proposal',
      'complete_tournament_terminal_proposal',
      'begin_tournament_deal_review',
      'close_tournament_deal_review',
      'get_tournament_deal_consensus',
      'resolve_tournament_terminal_proposal_outcome',
    ]) {
      expect(contraction).not.toContain(rpc);
    }
  });

  it('authenticates and preserves the exact live tail through 11072837', () => {
    const exactTail = [
      [
        '20260911050554',
        'final_deal_receipts_survive_real_terminal_settlement',
        '82770',
        'b4af55173b825be5ecf48c6c3bbcca1e828493cdafc47becf00d73ad3186c871',
      ],
      [
        '20260911052216',
        'the_daily_free_spin_leaves_the_building',
        '49343',
        '4778ce9d373a98e8b10cb31e496bf18e4e527c0a158f37a4e4fcf500b3c9b995',
      ],
      [
        '20260911052648',
        'bounty_rebuy_settles_its_exact_prior_entry_generation',
        '22463',
        '4f9616b84906a7479c60dd0a266c2c2d1bb056828aa53ef45095ea31d058c5e2',
      ],
      [
        '20260911061449',
        'the_welcome_spin_answers_the_same_everywhere',
        '45362',
        '3d6efc9bc8f00e5e9840ed09d806ea9fa3d8513117a8acb8f7580d56443f4cc1',
      ],
      [
        '20260911061723',
        'cancel_unstarted_entries_to_their_exact_funded_origin_wallet',
        '16739',
        '84f2d79130e27bd687c848a45bb65bf5b63ac2ebf0d4e9bf360dc1ec19cd284a',
      ],
      [
        '20260911062053',
        'the_operator_sees_the_money_and_the_room',
        '22888',
        '3f01c9da1e26451d8d8a938e1b942f70f2bdcff4db7a96e452210c5632d07648',
      ],
      [
        '20260911064427',
        'the_player_can_see_the_day_and_the_way_out',
        '20833',
        '9a5109e118fd3877b816126652b3e5ac0f8b54780d2dc6b37be33e61cd4b0bc6',
      ],
      [
        '20260911072424',
        'the_mint_that_is_gone_stops_being_reported',
        '22537',
        'a12119f40903928cf8febcca78f10b34a5b44cd8be6a996ccc68dd9c0dc69ecc',
      ],
      [
        '20260911072837',
        'legacy_rakeback_closed_period_single_payer',
        '36786',
        'a55e792f12040799a20fcf6d54969059efecaea3869c3aa148191fe1b083c4c7',
      ],
    ] as const;
    for (const descriptor of exactTail) {
      for (const value of descriptor) {
        expect(expansion).toContain(value);
        expect(contraction).toContain(value);
        expect(harness).toContain(value);
      }
    }

    for (const [fileName, expectedBytes, expectedSha256] of [
      [
        '20260911050554_final_deal_receipts_survive_real_terminal_settlement.sql',
        82770,
        'b4af55173b825be5ecf48c6c3bbcca1e828493cdafc47becf00d73ad3186c871',
      ],
      [
        '20260911052216_the_daily_free_spin_leaves_the_building.sql',
        49343,
        '4778ce9d373a98e8b10cb31e496bf18e4e527c0a158f37a4e4fcf500b3c9b995',
      ],
      [
        '20260911052648_bounty_rebuy_settles_its_exact_prior_entry_generation.sql',
        22463,
        '4f9616b84906a7479c60dd0a266c2c2d1bb056828aa53ef45095ea31d058c5e2',
      ],
      [
        '20260911061449_the_welcome_spin_answers_the_same_everywhere.sql',
        45362,
        '3d6efc9bc8f00e5e9840ed09d806ea9fa3d8513117a8acb8f7580d56443f4cc1',
      ],
      [
        '20260911061723_cancel_unstarted_entries_to_their_exact_funded_origin_wallet.sql',
        16739,
        '84f2d79130e27bd687c848a45bb65bf5b63ac2ebf0d4e9bf360dc1ec19cd284a',
      ],
      [
        '20260911062053_the_operator_sees_the_money_and_the_room.sql',
        22888,
        '3f01c9da1e26451d8d8a938e1b942f70f2bdcff4db7a96e452210c5632d07648',
      ],
      [
        '20260911064427_the_player_can_see_the_day_and_the_way_out.sql',
        20833,
        '9a5109e118fd3877b816126652b3e5ac0f8b54780d2dc6b37be33e61cd4b0bc6',
      ],
      [
        '20260911072424_the_mint_that_is_gone_stops_being_reported.sql',
        22537,
        'a12119f40903928cf8febcca78f10b34a5b44cd8be6a996ccc68dd9c0dc69ecc',
      ],
      [
        '20260911072837_legacy_rakeback_closed_period_single_payer.sql',
        36786,
        'a55e792f12040799a20fcf6d54969059efecaea3869c3aa148191fe1b083c4c7',
      ],
    ] as const) {
      const receipt = readFileSync(resolve(migrationsDirectory, fileName));
      expect(receipt.byteLength).toBe(expectedBytes);
      expect(createHash('sha256').update(receipt).digest('hex')).toBe(expectedSha256);
    }

    const terminalWrapper = functionBody(contraction, 'fn_complete_tournament_terminal');
    expect(createHash('md5').update(terminalWrapper).digest('hex')).toBe(
      '96a61ea5e16560735bcb70b355aa79ab'
    );
    expect(terminalWrapper).toContain('PERFORM public.fn_ca_lock_settlement_lane_global();');
    expect(contraction).not.toMatch(
      /ALTER FUNCTION public\.fn_settle_tournament_final_table_deal\(uuid\)\s+SET search_path TO public,pg_temp;/
    );
    expect(contraction).toContain("ARRAY['search_path=public','statement_timeout=30s']");
    expect(contraction).toContain(
      "CASE WHEN p_after_contraction\n                THEN '{postgres=X/postgres}'"
    );

    for (const exactPreservation of [
      'STAGE_B_11052216_WHEEL_CATALOG_PRESERVED',
      '607e4daf9060a1176e032016b8879808',
      'f793ed628fe609fe9fe2aa30a76bc4c7',
      "source='fn_collect_bounty'\n            AND note='Exact-generation fixed and PKO bounty payer used by the atomic live authority.'",
      'STAGE_B_11052648_BOUNTY_REBUY_ATOMICITY_OK',
    ]) {
      expect(harness).toContain(exactPreservation);
    }
    expect(createHash('sha256').update(bountyRebuyProbe).digest('hex')).toBe(
      'ef8e7fe7c0705ad265dab8f416485302b379437ab94f055f08c98e5cff3a6a5e'
    );
    expect(Buffer.byteLength(bountyRebuyProbe)).toBe(42772);
    expect(bountyRebuyProbe).toContain(
      "VALUES('fn_mystery_bounty_pay','DB caller') ON CONFLICT(source) DO NOTHING"
    );
    expect(runbook).toContain('exact 42,772-byte bounty-rebuy atomicity probe');
    expect(runbook).toContain('ef8e7fe7c0705ad265dab8f416485302b379437ab94f055f08c98e5cff3a6a5e');
    for (const exactLiveFunctionDefinition of [
      '480be3139fe0878e637ce54f533a2170',
      '8397b4f24c6d1a072d7b2d946f45e3d6',
      '185dcb02134aa1f1fd2d87cdddbcfd26',
      'cb81d2c33985e46bd56dc3c4f1320e67',
      '311ed77e7726f0c7515859a9140d526c',
      '18cf8159e315f322ac7cc09e1f913671',
      'b16256830158e669defcff8751cb5be7',
      '0a3e3ba2dc6c6e09ddef561e93e67b7d',
      'c5bbfca7dcc4aedc286c4004f5f5d2c1',
      'c7bee6802ab30d625c32503a4d6609e1',
      '38bf96ba348994fd40264584c26107d8',
      '237168031dfb0fb80bdaa8ff15f25172',
      '6361f556eac2ff2940e3f49f485176d0',
      'f676b2cbb361896dfa61f7e5f9413f46',
      '6bbb0ff983fc61c9f8c18cc2201e0f93',
      '3437a8e83051385947c6b48e7c399a90',
      'a6adf208eae8476128f197c16f83d6c5',
      '0286145366f00c7cad0a996f05630851',
    ]) {
      expect(contraction).toContain(exactLiveFunctionDefinition);
      expect(harness).toContain(exactLiveFunctionDefinition);
    }
  });

  it('changes only the audited final-deal completion-guard call site', () => {
    const preimage = dollarBlock(invariant, 'require_final_deal_v2_completion_guard_preimage');
    const substitution = dollarBlock(invariant, 'make_finish_certificate_candidate_aware');
    expect(preimage).toContain('d994347e1b76c936ce13361d73f94fd2');
    expect(preimage).toContain('8a05956d1fd25d649f1f80b133ed3ed0');
    expect(preimage).toContain('20260911050554');
    expect(substitution).toContain(
      'v_ready := public.fn_tournament_finish_readiness(NEW.id,v_winner);'
    );
    expect(substitution).toContain(
      'smarter_private.fn_tournament_finish_readiness_for_terminal_candidate('
    );
    expect(substitution).toContain('8e0d121a711f6b7afade68125d032f8d');
    expect(substitution).toContain('0a3e3ba2dc6c6e09ddef561e93e67b7d');
    expect(invariant).toContain("p.proacl::text='{postgres=X/postgres}'");
    expect(invariant).toContain("p.proconfig=ARRAY['search_path=public, pg_temp']::text[]");
    expect(invariant.match(/cd94d89d898acd094eeb1dccc1a0a296/g)).toHaveLength(2);
    expect(invariant).toContain(
      "tg.tgfoid=\n              'public.fn_guard_tournament_completed_certificate()'::regprocedure"
    );
    expect(invariant.match(/cc90af9b34abd78a5892ac074e6d1057/g)).toHaveLength(2);
  });

  it('seals all seven settlement-trigger bindings while changing only D to O', () => {
    expect(contraction).toContain('CREATE TEMP TABLE stage_b_settlement_trigger_preimage');
    expect(contraction).toContain(
      'Stage-B settlement trigger composition changed more than D to O'
    );
    expect(contraction).toContain('tg.tgqual::text AS trigger_when');
    expect(contraction).toContain('after.tgqual::text IS DISTINCT FROM before.trigger_when');
    expect(contraction).toContain('md5(actual.trigger_when) IS DISTINCT FROM expected.when_md5');
    expect(contraction).toContain(
      "FROM pg_trigger tg\n            WHERE tg.tgrelid='public.tournaments'::regclass"
    );
    expect(contraction).toContain(') after ON after.tgname=before.tgname');
    expect(contraction).not.toContain('FULL JOIN pg_trigger after');
    expect(contraction).not.toContain('after.tgqual IS DISTINCT FROM before.tgqual');
    expect(contraction).not.toContain('pg_get_expr(after.tgqual');
    expect(contraction).not.toContain('OR actual.trigger_when IS NOT NULL OR');
    expect(harness).toContain('md5(tg.tgqual::text) IS NOT DISTINCT FROM expected.when_md5');
    expect(harness).not.toContain('AND tg.tgqual IS NULL AND tg.tgnargs=0');
    for (const triggerDefinitionMd5 of [
      'e7bdddc429922d39b1db20916a442351',
      'd068b2ee511bad5e75dae19a424dde87',
      '481ecc9520193a0ba670e1a7f2eddb41',
      '79b2ecea0a7e0f1b4946436eb1404623',
      'cd94d89d898acd094eeb1dccc1a0a296',
      'd79234029c6246e6431c8f6907ac935c',
      'f75ff7a6ad7952e4ca090cde1516615c',
    ]) {
      expect(contraction).toContain(triggerDefinitionMd5);
      expect(harness).toContain(triggerDefinitionMd5);
    }
    for (const functionIdentity of [
      'public.trg_guard_atomic_satellite_completion()',
      'public.trg_tournament_atomic_place_completion_guard()',
      'public.trg_atomic_final_table_deal_completion_guard()',
      'public.fn_guard_tournament_completing_claim()',
      'public.fn_guard_tournament_completed_certificate()',
      'public.trg_tournament_pool_finalization_window_guard()',
      'public.trg_freeze_finalized_tournament_prize_pool()',
    ]) {
      expect(contraction).toContain(functionIdentity);
      expect(harness).toContain(functionIdentity);
    }
    expect(harness).toContain('STAGE_B_SEVEN_SETTLEMENT_TRIGGER_POSTIMAGE_CHANGED');
    for (const retainedTriggerDefinitionMd5 of [
      '2d79c256ecf4e44b0bb51686b824807e',
      'c9aebd8de7e6e5fef9b0c9fd3da7dc81',
      '5781f6fe63ae275fa12c4dcda74ffc6b',
    ]) {
      expect(contraction).toContain(retainedTriggerDefinitionMd5);
      expect(harness).toContain(retainedTriggerDefinitionMd5);
    }
    for (const triggerWhenMd5 of [
      'cc90af9b34abd78a5892ac074e6d1057',
      '50d33071dd4fa3af7b6afd7b598949a6',
    ]) {
      expect(contraction).toContain(triggerWhenMd5);
      expect(harness).toContain(triggerWhenMd5);
    }
    for (const retainedFunctionSourceMd5 of [
      '80362aed787137219432f6039bf03158',
      'd338c5278ef1247ff0f4a7c4ba774cc5',
      'ddc5e3121ed9cc73d41525e6c1ba6c34',
    ]) {
      expect(contraction).toContain(retainedFunctionSourceMd5);
      expect(harness).toContain(retainedFunctionSourceMd5);
    }
  });

  it('keeps every migration transactional and under the stopped-engine authority', () => {
    for (const source of sources) {
      expect(source.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(source.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(source.indexOf('BEGIN;')).toBeLessThan(source.indexOf('COMMIT;'));
      expect(source).toMatch(/pg_(?:try_)?advisory_xact_lock_shared\s*\(\s*530090\s*,\s*1\s*\)/);
      expect(source).toContain('engine_maintenance_break');
    }
    expect(atomicFinish).toContain('stage_b_atomic_finish_precertification');
  });

  it('runs the final behavioral scenarios and bounded postimage checks by default', () => {
    const defaultRunStart = harness.indexOf("create_scenario_database 'terminal_residue'");
    expect(defaultRunStart).toBeGreaterThanOrEqual(0);
    const defaultRun = harness.slice(defaultRunStart);
    for (const call of [
      'run_terminal_residue_success',
      'run_terminal_candidate_behavior',
      'run_late_missing_finish_claim_rollback',
      'prepare_current_postimage_template',
      'run_keyshare_unknown_preimage_rollback',
      'run_chain_prefix 6 true',
      'assert_stage_b_bounded_postimage',
    ]) {
      expect(defaultRun).toContain(call);
    }
    expect(harness).toContain('STAGE_B_DIAMOND_ACCEPTED_HAND_SUCCESS_REPLAY_ROLLBACK_OK');
    expect(harness).toContain('STAGE_B_DIAMOND_ACCEPTED_HAND_CURRENT_SCHEMA_OK');
    expect(harness).toContain('STAGE_B_080728_CONTROL_POSTIMAGE_OK');
    expect(harness).toContain('STAGE_B_LEASE_KEYSHARE_UNKNOWN_PREIMAGE_ROLLBACK_OK');
  });

  it('pins all six key-share functions and refuses an unknown ownership preimage', () => {
    for (const identity of [
      'fn_ca_commit_hand_settlement_exact_before_obligations',
      'fn_ca_resolve_unbound_pending_addons',
      'fn_close_empty_tournament_table',
      'fn_smarter_data_api_pre_request',
      'claim_tournament_lease_v2',
      'heartbeat_tournament_leases_v4',
    ]) {
      expect(harness).toContain(identity);
    }
    expect(harness).toContain('count(*) FROM function_rows WHERE oid IS NOT NULL)<>6');
    expect(keyshare).toContain('LEASE_KEYSHARE_UNKNOWN_PREIMAGE');
  });

  it('normalizes only the authenticated terminal-break cohort, then installs the invariant', () => {
    const normalize = dollarBlock(repair, 'normalize_terminal_break_residue');
    expect(normalize).toContain('app.stage_b_terminal_break_normalization');
    expect(normalize).toContain('UPDATE public.tournaments t');
    expect(normalize).toContain('on_break=false');
    expect(normalize).toContain('break_started_at=NULL');
    expect(normalize).toContain('break_ends_at=NULL');
    expect(invariant).toContain('DO $require_repaired_terminal_break_postimage$');
    expect(invariant).toContain('tournaments_terminal_break_state_is_clear');
    expect(invariant).toContain('aaa_guard_terminal_tournament_break_state');
    expect(invariant).not.toMatch(/UPDATE\s+public\.tournaments\s+(?:t\s+)?SET/i);
  });

  it('preserves the exact 034411 functions and policy/index postimage', () => {
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
    const forwardBoundaries = expansion + '\n' + invariant;
    expect(forwardBoundaries).not.toMatch(
      /(?:CREATE(?: OR REPLACE)?|DROP) FUNCTION public\.(?:trg_lock_and_validate_tournament_live_seat|fn_active_maintenance_release_boundary)\(/
    );
    expect(forwardBoundaries).not.toMatch(/(?:ALTER|DROP) POLICY poker_arena_tournament_access/);
  });
});

describe('the Stage-B rehearsal emits literal psql meta-commands', () => {
  it('uses data-safe printf calls for every generated psql command', () => {
    expect(harness).not.toContain('printf "\\\\echo');
    expect(harness).not.toContain('printf "\\\\ir');
    expect(harness).not.toContain('\u001b');
    expect(harness).toContain("printf '%s\\n' \"\\\\echo APPLYING");
    expect(harness).toContain("printf '%s\\n' \"\\\\ir '");
  });
});
