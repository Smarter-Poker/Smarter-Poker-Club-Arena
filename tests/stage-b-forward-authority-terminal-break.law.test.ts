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
    const canonicalStart = runbook.indexOf(
      '/usr/local/lib/club-arena/engine-control/engine-up.sh'
    );
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
    expect(harness).toContain("if [[ \"$anchor_receipts\" != '53' ]]");
    expect(harness).toContain(
      "if [[ \"$audited_tail_receipts\" != '38' || \"$audited_tail_statements\" != '41' ]]"
    );
    expect(harness).toContain("if [[ \"$tail_functions_exact\" != '12' ]]");
    expect(harness).toContain('assert_zero_player_data_baseline');
    expect(harness).toContain('20260910164655');
    for (const version of unrelated) expect(harness).not.toContain(version);
    expect(harness).not.toContain('phase3_postimage');
    expect(harness).not.toContain('STAGE_B_125453_PHASE3_POSTIMAGE_OK');
  });

  it('contracts only Stage-B-owned mutable preimages and the exact bootstrap', () => {
    expect(contraction).toContain('assert_stage_b_owned_postimage');
    expect(contraction.match(/SELECT pg_temp\.assert_stage_b_owned_postimage\(\);/g)).toHaveLength(2);
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

  it('keeps every migration transactional and under the stopped-engine authority', () => {
    for (const source of sources) {
      expect(source.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(source.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(source.indexOf('BEGIN;')).toBeLessThan(source.indexOf('COMMIT;'));
      expect(source).toMatch(
        /pg_(?:try_)?advisory_xact_lock_shared\s*\(\s*530090\s*,\s*1\s*\)/
      );
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
