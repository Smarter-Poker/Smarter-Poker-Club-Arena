import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';
import type { Card, CardRank, CardSuit } from '../types.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { HorseLogic } from './HorseLogic.js';
import {
  _clearGtoPostflopV31,
  boardFlushSuit,
  gtoPostflopV31Count,
  gtoPostflopV31Dataset,
  gtoPostflopV31EvaluationCount,
  gtoStreetAdviceV31,
  replaceGtoPostflopV31,
  replaceGtoPostflopV31Evaluation,
  v31HandKey,
  type GtoPostflopV31Row,
} from './GtoPostflopV31.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(value: string): Card[] {
  const result: Card[] = [];
  for (let index = 0; index + 1 < value.length; index += 2) {
    result.push({ rank: value[index] as CardRank, suit: SUITS[value[index + 1]] });
  }
  return result;
}

const H64 = 'a'.repeat(64);
const CELL: GtoPostflopV31Row = {
  dataset_id: '11111111-1111-4111-8111-111111111111',
  dataset_key: 'phase4-canary',
  dataset_checksum: H64,
  solver_version: 'PioSOLVER-3.0',
  solver_binary_checksum: 'b'.repeat(64),
  pipeline_commit: 'c'.repeat(40),
  pipeline_bundle_checksum: 'b'.repeat(64),
  manifest_version: '5',
  manifest_checksum: 'd'.repeat(64),
  source_artifact_checksum: 'e'.repeat(64),
  source_combo_order_checksum: 'f'.repeat(64),
  range_bundle_checksum: '1'.repeat(64),
  icm_model_checksum: '5'.repeat(64),
  input_bundle_checksum: '6'.repeat(64),
  cell_key_checksum: '3'.repeat(64),
  cell_payload_checksum: '4'.repeat(64),
  lineage_checksum: '2'.repeat(64),
  quality_status: 'validated',
  dataset_state: 'active',
  dataset_cells: 1,
  source_rows: 20,
  train_source_rows: 18,
  holdout_source_rows: 2,
  invalid_rows: 0,
  audited_at: '2026-09-08T12:00:00.000Z',
  street: 'turn',
  game_family: 'cash',
  objective: 'cash_ev',
  utility_context: 'cash_ev',
  table_size: 2,
  pot_type: 'limped',
  hero_position: 'SB',
  opponent_position: 'BB',
  depth_bucket: 80,
  texture_class: 'Brud',
  node_role: 'barrel',
  facing_kind: 'none',
  facing_size_bucket: 'none',
  hand_matrix: {
    'AKs:2': { check: 0, overbet: 1 },
    'AKs:0': { check: 1, overbet: 0 },
  },
  action_specs: {
    check: { family: 'check', size_unit: 'none', size_value: null, all_in: false },
    overbet: { family: 'bet', size_unit: 'pot_fraction', size_value: 2.62, all_in: false },
  },
  policy_ev_matrix: { 'AKs:2': 8.4, 'AKs:0': 7.9 },
  action_ev_matrix: {
    'AKs:2': { check: 7.9, overbet: 8.4 },
    'AKs:0': { check: 7.9, overbet: 8.4 },
  },
};

const BOARD = cards('Ks9d7c2h');

beforeEach(() => _clearGtoPostflopV31());

function lookup(over: Partial<Parameters<typeof gtoStreetAdviceV31>[0]> = {}) {
  return gtoStreetAdviceV31({
    street: 'turn',
    family: 'cash',
    objective: 'cash_ev',
    utilityContext: 'cash_ev',
    tableSize: 2,
    potType: 'limped',
    heroPosition: 'SB',
    opponentPosition: 'BB',
    stackBB: 80,
    board: BOARD,
    hand: 'AKs',
    holeCards: cards('AsKs'),
    nodeRole: 'barrel',
    facingKind: 'none',
    facingSizeBucket: 'none',
    ...over,
  });
}

describe('V31 board-relative suit identity', () => {
  it('mirrors the production suit tie-break', () => {
    expect(boardFlushSuit(cards('2c3c4s5s'))).toBe(0);
    expect(boardFlushSuit(cards('2d3d4h5h'))).toBe(1);
    expect(boardFlushSuit(cards('2c3d4h'))).toBe(-1);
  });

  it('keeps equal 169 classes in different flush-suit buckets', () => {
    expect(v31HandKey('AKs', cards('AsKs'), cards('Ks9s7c2h'))).toBe('AKs:2');
    expect(v31HandKey('AKs', cards('AhKh'), cards('Ks9s7c2h'))).toBe('AKs:0');
  });
});

describe('V31 certification and lookup', () => {
  it('loads one sealed active dataset and surfaces EV lineage', () => {
    expect(replaceGtoPostflopV31([CELL])).toBe(1);
    expect(gtoPostflopV31Count()).toBe(1);
    expect(gtoPostflopV31Dataset()).toEqual({
      id: CELL.dataset_id,
      checksum: CELL.dataset_checksum,
    });
    const result = lookup();
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.actions.overbet.size_value).toBe(2.62);
      expect(result.policyEvBb).toBe(7.9);
      expect(result.actionEvsBb?.check).toBe(7.9);
      expect(result.sourceSeal.lineage_checksum).toBe(CELL.lineage_checksum);
      expect(result.sourceSeal.pipeline_bundle_checksum).toBe(CELL.pipeline_bundle_checksum);
    }
  });

  it('accepts independently reach-weighted compact EV aggregates but still requires complete finite EVs', () => {
    const covarianceCell: GtoPostflopV31Row = {
      ...CELL,
      hand_matrix: {
        'AKs:2': { check: 0.5, overbet: 0.5 },
        'AKs:0': { check: 0.5, overbet: 0.5 },
      },
      // Source-combo policy identities were validated before compaction. The
      // independent class averages need not satisfy 0.5 * 2 + 0.5 * 8 = 5.
      policy_ev_matrix: { 'AKs:2': 6.25, 'AKs:0': 6.25 },
      action_ev_matrix: {
        'AKs:2': { check: 2, overbet: 8 },
        'AKs:0': { check: 2, overbet: 8 },
      },
    };
    expect(replaceGtoPostflopV31([covarianceCell])).toBe(1);
    expect(lookup().hit).toBe(true);
    expect(() =>
      replaceGtoPostflopV31([
        {
          ...covarianceCell,
          policy_ev_matrix: { 'AKs:2': Number.NaN, 'AKs:0': 6.25 },
        },
      ])
    ).toThrow(/uncertified_or_malformed/);
    expect(() =>
      replaceGtoPostflopV31([
        {
          ...covarianceCell,
          action_ev_matrix: {
            'AKs:2': { check: 2 },
            'AKs:0': { check: 2, overbet: 8 },
          },
        },
      ])
    ).toThrow(/uncertified_or_malformed/);
  });

  it('keeps a sealed candidate isolated behind its exact checksum', () => {
    replaceGtoPostflopV31([CELL]);
    const candidate: GtoPostflopV31Row = {
      ...CELL,
      dataset_id: '22222222-2222-4222-8222-222222222222',
      dataset_key: 'phase4-candidate',
      dataset_checksum: '7'.repeat(64),
      dataset_state: 'evaluating',
      hand_matrix: {
        'AKs:2': { check: 0, overbet: 1 },
        'AKs:0': { check: 0, overbet: 1 },
      },
      policy_ev_matrix: { 'AKs:2': 8.4, 'AKs:0': 8.4 },
    };
    expect(replaceGtoPostflopV31Evaluation([candidate])).toBe(1);
    expect(gtoPostflopV31EvaluationCount(candidate.dataset_checksum)).toBe(1);
    const active = lookup();
    const evaluating = lookup({ datasetChecksum: candidate.dataset_checksum });
    expect(active.hit && active.mix.check).toBe(1);
    expect(evaluating.hit && evaluating.mix.overbet).toBe(1);
    expect(lookup({ datasetChecksum: '8'.repeat(64) })).toEqual({
      hit: false,
      miss: 'empty_store',
    });
    expect(gtoPostflopV31Dataset()?.id).toBe(CELL.dataset_id);
  });

  it('refuses to load active rows into the candidate store or candidates live', () => {
    expect(() => replaceGtoPostflopV31Evaluation([CELL])).toThrow(/uncertified_or_malformed/);
    expect(() => replaceGtoPostflopV31([{ ...CELL, dataset_state: 'candidate' }])).toThrow(
      /uncertified_or_malformed/
    );
  });

  it('rejects an unsealed row and preserves the previous complete snapshot', () => {
    replaceGtoPostflopV31([CELL]);
    expect(() => replaceGtoPostflopV31([{ ...CELL, dataset_checksum: '0'.repeat(64) }])).toThrow(
      /uncertified_or_malformed/
    );
    expect(gtoPostflopV31Count()).toBe(1);
    expect(lookup().hit).toBe(true);
  });

  it('rejects a short paged result and preserves the prior complete dataset', () => {
    replaceGtoPostflopV31([CELL]);
    expect(() =>
      replaceGtoPostflopV31([
        { ...CELL, dataset_id: '22222222-2222-4222-8222-222222222222', dataset_cells: 2 },
      ])
    ).toThrow(/incomplete_dataset/);
    expect(gtoPostflopV31Dataset()?.id).toBe(CELL.dataset_id);
  });

  it('rejects open/response semantic relabeling', () => {
    expect(() =>
      replaceGtoPostflopV31([
        { ...CELL, node_role: 'facing_bet', facing_kind: 'none', facing_size_bucket: 'none' },
      ])
    ).toThrow(/uncertified_or_malformed/);
    expect(() =>
      replaceGtoPostflopV31([
        {
          ...CELL,
          action_specs: {
            fold: { family: 'fold', size_unit: 'none', size_value: null, all_in: false },
            call: { family: 'call', size_unit: 'none', size_value: null, all_in: false },
          },
          hand_matrix: { 'AKs:2': { fold: 0.5, call: 0.5 } },
        },
      ])
    ).toThrow(/uncertified_or_malformed/);
  });

  it('requires the exact node role, both seats, and objective', () => {
    replaceGtoPostflopV31([CELL]);
    expect(lookup({ nodeRole: 'open' }).hit).toBe(false);
    expect(lookup({ opponentPosition: 'SB' }).hit).toBe(false);
    expect(lookup({ tableSize: 6 }).hit).toBe(false);
    expect(lookup({ potType: '3bet' }).hit).toBe(false);
    expect(lookup({ family: 'tourney_icm', objective: 'icm' }).hit).toBe(false);
  });

  it('never falls back from tournament ICM to chip EV', () => {
    replaceGtoPostflopV31([
      {
        ...CELL,
        game_family: 'tourney_ev',
        objective: 'chip_ev',
        utility_context: 'chip_ev',
      },
    ]);
    const result = lookup({
      family: 'tourney_icm',
      objective: 'icm',
      utilityContext: 'bubble',
    });
    expect(result.hit).toBe(false);
    if (!result.hit) expect(result.miss).toBe('no_cell');
  });

  it('reports an absent holding rather than trying a different context', () => {
    replaceGtoPostflopV31([CELL]);
    const result = lookup({ hand: '72o', holeCards: cards('7h2d') });
    expect(result.hit).toBe(false);
    if (!result.hit) expect(result.miss).toBe('hand_not_in_cell');
  });
});

describe('V31 reaches the full horse decision path', () => {
  it('executes a genuine facing-bet fold and stamps that exact node', () => {
    const response: GtoPostflopV31Row = {
      ...CELL,
      hero_position: 'BB',
      opponent_position: 'SB',
      node_role: 'facing_bet',
      facing_kind: 'bet',
      facing_size_bucket: 'mid',
      hand_matrix: { '43o:0': { fold: 1, call: 0, raise: 0 } },
      action_specs: {
        fold: { family: 'fold', size_unit: 'none', size_value: null, all_in: false },
        call: { family: 'call', size_unit: 'none', size_value: null, all_in: false },
        raise: {
          family: 'raise',
          size_unit: 'pot_after_call_fraction',
          size_value: 0.75,
          all_in: false,
        },
      },
      policy_ev_matrix: { '43o:0': 0 },
      action_ev_matrix: {
        '43o:0': { fold: 0, call: -0.2, raise: -0.8 },
      },
    };
    replaceGtoPostflopV31([response]);
    const hero = {
      seat: 1,
      user_id: 'hero',
      username: 'Hero',
      stack: 8_000,
      bet: 0,
      totalInvested: 0,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      cards: cards('3c4d'),
    };
    const villain = {
      seat: 2,
      user_id: 'villain',
      username: 'Villain',
      stack: 7_940,
      bet: 60,
      totalInvested: 60,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      cards: [],
    };
    const state = {
      players: [hero, villain],
      communityCards: BOARD,
      pot: 160,
      currentBet: 60,
      minRaise: 60,
      stage: 'turn',
      gameVariant: 'nlh',
      gameMode: 'cash',
      format: 'cash',
      bigBlind: 100,
      smallBlind: 50,
      dealerSeat: 2,
      actionHistory: [
        {
          stage: 'turn',
          seat: 2,
          userId: 'villain',
          action: 'bet',
          amount: 60,
          timestamp: 0,
        },
      ],
    };
    enableBrainTelemetry();
    drainFires();
    const decision = HorseLogic.decide(
      hero as never,
      state as never,
      'balanced',
      {},
      {
        telemetry: true,
      }
    );
    expect(decision.action).toBe('fold');
    const fires = Object.fromEntries(drainFires().map((row) => [row.feature, row.fires]));
    expect(fires.v31_certified_facing_bet).toBe(1);
    expect(fires.v32_defend_fold ?? 0).toBe(0);
  });

  it('lets an exact satellite ICM candidate execute before the locked-seat fallback', () => {
    const checksum = '7'.repeat(64);
    const candidate: GtoPostflopV31Row = {
      ...CELL,
      dataset_id: '22222222-2222-4222-8222-222222222222',
      dataset_key: 'phase4-satellite-candidate',
      dataset_checksum: checksum,
      dataset_state: 'evaluating',
      game_family: 'tourney_icm',
      objective: 'icm',
      utility_context: 'satellite',
      table_size: 2,
      pot_type: 'srp',
      hero_position: 'BB',
      opponent_position: 'SB',
      node_role: 'facing_bet',
      facing_kind: 'bet',
      facing_size_bucket: 'big',
      hand_matrix: { '43o:0': { fold: 0, call: 1, raise: 0 } },
      action_specs: {
        fold: { family: 'fold', size_unit: 'none', size_value: null, all_in: false },
        call: { family: 'call', size_unit: 'none', size_value: null, all_in: false },
        raise: {
          family: 'raise',
          size_unit: 'pot_after_call_fraction',
          size_value: 0.75,
          all_in: false,
        },
      },
      policy_ev_matrix: { '43o:0': -0.2 },
      action_ev_matrix: { '43o:0': { fold: 0, call: -0.2, raise: -1 } },
    };
    const hero = {
      seat: 1,
      user_id: 'hero',
      username: 'Hero',
      stack: 8_000,
      bet: 0,
      totalInvested: 300,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      cards: cards('3c4d'),
    };
    const villain = {
      seat: 2,
      user_id: 'villain',
      username: 'Villain',
      stack: 4_000,
      bet: 4_000,
      totalInvested: 4_300,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      cards: [],
    };
    const state = {
      players: [hero, villain],
      communityCards: BOARD,
      pot: 5_000,
      currentBet: 4_000,
      minRaise: 4_000,
      stage: 'turn',
      gameVariant: 'nlh',
      gameMode: 'tournament',
      format: 'mtt',
      bigBlind: 100,
      smallBlind: 50,
      dealerSeat: 2,
      actionHistory: [
        {
          stage: 'preflop',
          seat: 2,
          userId: 'villain',
          action: 'raise',
          amount: 300,
          timestamp: 0,
        },
        {
          stage: 'preflop',
          seat: 1,
          userId: 'hero',
          action: 'call',
          amount: 200,
          timestamp: 1,
        },
        {
          stage: 'turn',
          seat: 2,
          userId: 'villain',
          action: 'bet',
          amount: 4_000,
          timestamp: 2,
        },
      ],
      tournament: {
        playersLeft: 5,
        spotsPaid: 4,
        satellite: true,
        satelliteSeats: 4,
        stacks: [8_000, 2_000, 1_800, 1_600, 1_400],
        payoutPct: [0.25, 0.25, 0.25, 0.25],
        avgStackChips: 2_960,
      },
    };

    const fallback = HorseLogic.decide(
      hero as never,
      state as never,
      'balanced',
      {},
      { mind: false }
    );
    expect(fallback.action).toBe('fold');

    replaceGtoPostflopV31Evaluation([candidate]);
    const receipts: Array<{ datasetChecksum: string; nodeRole: string; actionId: string }> = [];
    const decision = HorseLogic.decide(
      hero as never,
      state as never,
      'balanced',
      {},
      {
        mind: false,
        gtoV31DatasetChecksum: checksum,
        onGtoV31Decision: (receipt) => receipts.push(receipt),
      }
    );
    expect(decision).toMatchObject({ action: 'call', amount: 4_000 });
    expect(receipts).toEqual([
      expect.objectContaining({
        datasetChecksum: checksum,
        nodeRole: 'facing_bet',
        actionId: 'call',
      }),
    ]);
  });

  it('the worker owns the loader and the loader reads only the certified RPC', () => {
    const worker = readFileSync(
      new URL('./horseDecision/workerRuntime.ts', import.meta.url).pathname,
      'utf8'
    );
    const loader = readFileSync(
      new URL('../services/GtoPostflopV31Loader.ts', import.meta.url).pathname,
      'utf8'
    );
    expect(worker).toContain('startGtoPostflopV31Loader()');
    expect(loader).toContain("supabase.rpc('fn_gto_v31_active_cells'");
    expect(loader).not.toContain(".from('gto_postflop_v31')");
  });
});
