import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';
import type { Card, CardRank, CardSuit } from '../types.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import { gtoV31ExecutionMatches, HorseLogic } from './HorseLogic.js';
import {
  _clearGtoPostflopV31,
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
    'AKs:22': { c: 0, b262: 1 },
    'AKs:00': { c: 1, b262: 0 },
  },
  action_specs: {
    c: { family: 'check', size_unit: 'none', size_value: null, all_in: false },
    b262: { family: 'bet', size_unit: 'pot_fraction', size_value: 2.62, all_in: false },
  },
  policy_ev_matrix: { 'AKs:22': 8.4, 'AKs:00': 7.9 },
  action_ev_matrix: {
    'AKs:22': { c: 7.9, b262: 8.4 },
    'AKs:00': { c: 7.9, b262: 8.4 },
  },
};

const BOARD = cards('Qh9d7c2h');

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
  it('separates a real rainbow backdoor from a suit absent from the board', () => {
    const rainbow = cards('As7d2c');
    expect(v31HandKey('KQs', cards('KsQs'), rainbow)).toBe('KQs:11');
    expect(v31HandKey('KQs', cards('KhQh'), rainbow)).toBe('KQs:00');
  });

  it('binds front-door suit pressure to the exact hole-card rank', () => {
    const twoTone = cards('Qs7s2c');
    expect(v31HandKey('AKs', cards('AcKc'), twoTone)).toBe('AKs:11');
    expect(v31HandKey('AKs', cards('AhKh'), twoTone)).toBe('AKs:00');
    expect(v31HandKey('AKo', cards('AsKh'), twoTone)).toBe('AKo:20');
    expect(v31HandKey('AKo', cards('AhKs'), twoTone)).toBe('AKo:02');
  });

  it('preserves both live flush suits on a two-two turn and canonicalizes pairs', () => {
    const twoTwo = cards('Qs7s2c3c');
    expect(v31HandKey('AKs', cards('AsKs'), twoTwo)).toBe('AKs:22');
    expect(v31HandKey('AKs', cards('AcKc'), twoTwo)).toBe('AKs:22');
    expect(v31HandKey('AKs', cards('AhKh'), twoTwo)).toBe('AKs:00');
    expect(v31HandKey('AKo', cards('AsKc'), twoTwo)).toBe('AKo:22');
    expect(v31HandKey('AA', cards('AcAd'), twoTwo)).toBe('AA:20');
    expect(v31HandKey('AA', cards('AdAc'), twoTwo)).toBe('AA:20');
  });

  it('fails closed on a mismatched class, invalid deck, or incomplete board', () => {
    expect(v31HandKey('AKo', cards('AsKs'), cards('Qh9d7c'))).toBeNull();
    expect(v31HandKey('AKs', cards('AsKs'), cards('As9d7c'))).toBeNull();
    expect(v31HandKey('AKs', cards('AsKs'), cards('QhQh7c'))).toBeNull();
    expect(v31HandKey('AKs', cards('AsKs'), cards('Qh9d'))).toBeNull();
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
      expect(result.actions.b262.size_value).toBe(2.62);
      expect(result.policyEvBb).toBe(7.9);
      expect(result.actionEvsBb?.c).toBe(7.9);
      expect(result.sourceSeal.lineage_checksum).toBe(CELL.lineage_checksum);
      expect(result.sourceSeal.pipeline_bundle_checksum).toBe(CELL.pipeline_bundle_checksum);
    }
  });

  it('rejects a non-canonical dataset identity before it enters the live store', () => {
    expect(() =>
      replaceGtoPostflopV31([{ ...CELL, dataset_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }])
    ).toThrow(/uncertified_or_malformed/);
    expect(gtoPostflopV31Count()).toBe(0);
  });

  it('accepts independently reach-weighted compact EV aggregates but still requires complete finite EVs', () => {
    const covarianceCell: GtoPostflopV31Row = {
      ...CELL,
      hand_matrix: {
        'AKs:22': { c: 0.5, b262: 0.5 },
        'AKs:00': { c: 0.5, b262: 0.5 },
      },
      // Source-combo policy identities were validated before compaction. The
      // independent class averages need not satisfy 0.5 * 2 + 0.5 * 8 = 5.
      policy_ev_matrix: { 'AKs:22': 6.25, 'AKs:00': 6.25 },
      action_ev_matrix: {
        'AKs:22': { c: 2, b262: 8 },
        'AKs:00': { c: 2, b262: 8 },
      },
    };
    expect(replaceGtoPostflopV31([covarianceCell])).toBe(1);
    expect(lookup().hit).toBe(true);
    expect(() =>
      replaceGtoPostflopV31([
        {
          ...covarianceCell,
          policy_ev_matrix: { 'AKs:22': Number.NaN, 'AKs:00': 6.25 },
        },
      ])
    ).toThrow(/uncertified_or_malformed/);
    expect(() =>
      replaceGtoPostflopV31([
        {
          ...covarianceCell,
          action_ev_matrix: {
            'AKs:22': { c: 2 },
            'AKs:00': { c: 2, b262: 8 },
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
        'AKs:22': { c: 0, b262: 1 },
        'AKs:00': { c: 0, b262: 1 },
      },
      policy_ev_matrix: { 'AKs:22': 8.4, 'AKs:00': 8.4 },
    };
    expect(replaceGtoPostflopV31Evaluation([candidate])).toBe(1);
    expect(gtoPostflopV31EvaluationCount(candidate.dataset_checksum)).toBe(1);
    const active = lookup();
    const evaluating = lookup({ datasetChecksum: candidate.dataset_checksum });
    expect(active.hit && active.mix.c).toBe(1);
    expect(evaluating.hit && evaluating.mix.b262).toBe(1);
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
    for (const invalid of [
      { ...CELL, dataset_checksum: '0'.repeat(64) },
      { ...CELL, source_rows: CELL.source_rows + 1 },
      { ...CELL, dataset_cells: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...CELL,
        action_specs: {
          ...CELL.action_specs,
          b262: { ...CELL.action_specs.b262, size_value: 20.01 },
        },
      },
    ]) {
      expect(() => replaceGtoPostflopV31([invalid])).toThrow(/uncertified_or_malformed/);
    }
    expect(gtoPostflopV31Count()).toBe(1);
    expect(lookup().hit).toBe(true);
  });

  it('rejects string frequencies and noncanonical hand classes without replacing the snapshot', () => {
    replaceGtoPostflopV31([CELL]);
    expect(() =>
      replaceGtoPostflopV31([
        {
          ...CELL,
          hand_matrix: {
            'AKs:22': { c: '0', b262: '1' },
            'AKs:00': { c: 1, b262: 0 },
          },
        } as never,
      ])
    ).toThrow(/uncertified_or_malformed/);
    for (const invalidHand of [
      'KAo:20',
      'AAs:00',
      'AK:00',
      'AKs:20',
      'AA:02',
      'AKs:2',
      'AKo:32',
      'AA:32',
      'AKs:55',
    ]) {
      expect(() =>
        replaceGtoPostflopV31([
          {
            ...CELL,
            hand_matrix: { [invalidHand]: { c: 1, b262: 0 } },
            policy_ev_matrix: { [invalidHand]: 0 },
            action_ev_matrix: { [invalidHand]: { c: 0, b262: 0 } },
          },
        ])
      ).toThrow(/uncertified_or_malformed/);
    }
    expect(() =>
      replaceGtoPostflopV31([
        {
          ...CELL,
          street: 'flop',
          hand_matrix: { 'AKo:31': { c: 1, b262: 0 } },
          policy_ev_matrix: { 'AKo:31': 0 },
          action_ev_matrix: { 'AKo:31': { c: 0, b262: 0 } },
        },
      ])
    ).toThrow(/uncertified_or_malformed/);
    expect(gtoPostflopV31Dataset()?.id).toBe(CELL.dataset_id);
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
            f: { family: 'fold', size_unit: 'none', size_value: null, all_in: false },
            c: { family: 'call', size_unit: 'none', size_value: null, all_in: false },
          },
          hand_matrix: { 'AKs:22': { f: 0.5, c: 0.5 } },
        },
      ])
    ).toThrow(/uncertified_or_malformed/);
    expect(() =>
      replaceGtoPostflopV31([
        {
          ...CELL,
          action_specs: {
            c: CELL.action_specs.b262,
            b262: CELL.action_specs.c,
          },
        },
      ])
    ).toThrow(/uncertified_or_malformed/);
    expect(() =>
      replaceGtoPostflopV31([
        {
          ...CELL,
          action_specs: {
            c: CELL.action_specs.c,
            overbet: CELL.action_specs.b262,
          },
          hand_matrix: {
            'AKs:22': { c: 0, overbet: 1 },
            'AKs:00': { c: 1, overbet: 0 },
          },
          action_ev_matrix: {
            'AKs:22': { c: 7.9, overbet: 8.4 },
            'AKs:00': { c: 7.9, overbet: 8.4 },
          },
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

  it('refuses a certified lookup when the public board length contradicts the street', () => {
    replaceGtoPostflopV31([CELL]);
    expect(lookup({ board: BOARD.slice(0, 3) })).toEqual({
      hit: false,
      miss: 'no_texture',
    });
    expect(lookup({ board: [...BOARD, ...cards('5s')] })).toEqual({
      hit: false,
      miss: 'no_texture',
    });
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
  it('requires the final wager family and size while preserving a semantic call-off', () => {
    expect(
      gtoV31ExecutionMatches({
        sampledFamily: 'raise',
        sampledAmount: 62.2,
        finalAction: 'raise',
        finalAmount: 62,
        bigBlind: 100,
      })
    ).toBe(true);
    expect(
      gtoV31ExecutionMatches({
        sampledFamily: 'raise',
        sampledAmount: 62.2,
        finalAction: 'raise',
        finalAmount: 120,
        bigBlind: 100,
      })
    ).toBe(false);
    expect(
      gtoV31ExecutionMatches({
        sampledFamily: 'raise',
        sampledAmount: 62.2,
        finalAction: 'all_in',
        finalAmount: null,
        bigBlind: 100,
      })
    ).toBe(false);
    expect(
      gtoV31ExecutionMatches({
        sampledFamily: 'call',
        sampledAmount: 4_000,
        finalAction: 'all_in',
        finalAmount: null,
        bigBlind: 100,
      })
    ).toBe(true);
  });

  it('uses the all-in response cell for a covering stack but never in a straddled pot', () => {
    const responseBase: GtoPostflopV31Row = {
      ...CELL,
      dataset_cells: 2,
      street: 'flop',
      hero_position: 'BB',
      opponent_position: 'SB',
      node_role: 'all_in',
      facing_kind: 'all_in',
      facing_size_bucket: 'all_in',
      hand_matrix: { '43o:11': { f: 0, c: 1 } },
      action_specs: {
        f: { family: 'fold', size_unit: 'none', size_value: null, all_in: false },
        c: { family: 'call', size_unit: 'none', size_value: null, all_in: false },
      },
      policy_ev_matrix: { '43o:11': 1 },
      action_ev_matrix: { '43o:11': { f: 0, c: 1 } },
    };
    replaceGtoPostflopV31([
      responseBase,
      {
        ...responseBase,
        node_role: 'facing_bet',
        facing_kind: 'bet',
        facing_size_bucket: 'big',
        cell_key_checksum: '7'.repeat(64),
        cell_payload_checksum: '8'.repeat(64),
        lineage_checksum: '9'.repeat(64),
        hand_matrix: { '43o:11': { f: 1, c: 0 } },
        policy_ev_matrix: { '43o:11': 0 },
      },
    ]);
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
      stack: 8_000,
      bet: 8_000,
      totalInvested: 8_000,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      cards: [],
    };
    const state = {
      players: [hero, villain],
      communityCards: BOARD.slice(0, 3),
      pot: 8_100,
      currentBet: 8_000,
      minRaise: 8_000,
      stage: 'flop',
      gameVariant: 'nlh',
      gameMode: 'cash',
      format: 'cash',
      bigBlind: 100,
      smallBlind: 50,
      dealerSeat: 2,
      actionHistory: [
        { stage: 'flop', seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 0 },
        {
          stage: 'flop',
          seat: 2,
          userId: 'villain',
          action: 'bet',
          amount: 8_000,
          timestamp: 1,
        },
      ],
    };
    const decision = HorseLogic.decide(
      hero as never,
      state as never,
      'balanced',
      {},
      { mind: false, telemetry: false }
    );
    expect(decision.action).toBe('all_in');

    const straddleReceipts: Array<{ actionId: string }> = [];
    HorseLogic.decide(
      hero as never,
      { ...state, straddleActive: true } as never,
      'balanced',
      {},
      {
        mind: false,
        telemetry: false,
        gtoV31DatasetChecksum: H64,
        onGtoV31Decision: (receipt) => straddleReceipts.push(receipt),
      }
    );
    expect(straddleReceipts).toEqual([]);
  });

  it('selects turn and river cells by the flop-root effective stack', () => {
    const response: GtoPostflopV31Row = {
      ...CELL,
      dataset_cells: 2,
      hero_position: 'BB',
      opponent_position: 'SB',
      node_role: 'facing_bet',
      facing_kind: 'bet',
      facing_size_bucket: 'small',
      hand_matrix: { '43o:11': { f: 1, c: 0 } },
      action_specs: {
        f: { family: 'fold', size_unit: 'none', size_value: null, all_in: false },
        c: { family: 'call', size_unit: 'none', size_value: null, all_in: false },
      },
      policy_ev_matrix: { '43o:11': 0 },
      action_ev_matrix: { '43o:11': { f: 0, c: -1 } },
    };
    replaceGtoPostflopV31([
      response,
      {
        ...response,
        depth_bucket: 20,
        cell_key_checksum: '7'.repeat(64),
        cell_payload_checksum: '8'.repeat(64),
        lineage_checksum: '9'.repeat(64),
        hand_matrix: { '43o:11': { f: 0, c: 1 } },
        policy_ev_matrix: { '43o:11': -1 },
      },
    ]);
    const hero = {
      seat: 1,
      user_id: 'hero',
      username: 'Hero',
      stack: 2_000,
      bet: 0,
      totalInvested: 6_000,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      cards: cards('3c4d'),
    };
    const villain = {
      seat: 2,
      user_id: 'villain',
      username: 'Villain',
      stack: 1_900,
      bet: 100,
      totalInvested: 6_100,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      cards: [],
    };
    const state = {
      players: [hero, villain],
      communityCards: BOARD,
      pot: 12_300,
      currentBet: 100,
      minRaise: 100,
      stage: 'turn',
      gameVariant: 'nlh',
      gameMode: 'cash',
      format: 'cash',
      bigBlind: 100,
      smallBlind: 50,
      dealerSeat: 2,
      actionHistory: [
        { stage: 'flop', seat: 1, userId: 'hero', action: 'bet', amount: 6_000, timestamp: 0 },
        {
          stage: 'flop',
          seat: 2,
          userId: 'villain',
          action: 'call',
          amount: 6_000,
          timestamp: 1,
        },
        { stage: 'turn', seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 2 },
        {
          stage: 'turn',
          seat: 2,
          userId: 'villain',
          action: 'bet',
          amount: 100,
          timestamp: 3,
        },
      ],
    };

    const decision = HorseLogic.decide(
      hero as never,
      state as never,
      'balanced',
      {},
      { mind: false, telemetry: false }
    );
    expect(decision.action).toBe('fold');
  });

  it('executes a genuine facing-bet fold and stamps that exact node', () => {
    const response: GtoPostflopV31Row = {
      ...CELL,
      hero_position: 'BB',
      opponent_position: 'SB',
      node_role: 'facing_bet',
      facing_kind: 'bet',
      facing_size_bucket: 'mid',
      hand_matrix: { '43o:11': { f: 1, c: 0, b75: 0 } },
      action_specs: {
        f: { family: 'fold', size_unit: 'none', size_value: null, all_in: false },
        c: { family: 'call', size_unit: 'none', size_value: null, all_in: false },
        b75: {
          family: 'raise',
          size_unit: 'pot_after_call_fraction',
          size_value: 0.75,
          all_in: false,
        },
      },
      policy_ev_matrix: { '43o:11': 0 },
      action_ev_matrix: {
        '43o:11': { f: 0, c: -0.2, b75: -0.8 },
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
          stage: 'flop',
          seat: 1,
          userId: 'hero',
          action: 'check',
          amount: 0,
          timestamp: 0,
        },
        {
          stage: 'flop',
          seat: 2,
          userId: 'villain',
          action: 'check',
          amount: 0,
          timestamp: 1,
        },
        {
          stage: 'turn',
          seat: 1,
          userId: 'hero',
          action: 'check',
          amount: 0,
          timestamp: 2,
        },
        {
          stage: 'turn',
          seat: 2,
          userId: 'villain',
          action: 'bet',
          amount: 60,
          timestamp: 3,
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
      hand_matrix: { '43o:11': { f: 0, c: 1, b75: 0 } },
      action_specs: {
        f: { family: 'fold', size_unit: 'none', size_value: null, all_in: false },
        c: { family: 'call', size_unit: 'none', size_value: null, all_in: false },
        b75: {
          family: 'raise',
          size_unit: 'pot_after_call_fraction',
          size_value: 0.75,
          all_in: false,
        },
      },
      policy_ev_matrix: { '43o:11': -0.2 },
      action_ev_matrix: { '43o:11': { f: 0, c: -0.2, b75: -1 } },
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
          stage: 'flop',
          seat: 1,
          userId: 'hero',
          action: 'check',
          amount: 0,
          timestamp: 2,
        },
        {
          stage: 'flop',
          seat: 2,
          userId: 'villain',
          action: 'check',
          amount: 0,
          timestamp: 3,
        },
        {
          stage: 'turn',
          seat: 1,
          userId: 'hero',
          action: 'check',
          amount: 0,
          timestamp: 4,
        },
        {
          stage: 'turn',
          seat: 2,
          userId: 'villain',
          action: 'bet',
          amount: 4_000,
          timestamp: 5,
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
    const receipts: Array<{
      datasetChecksum: string;
      nodeRole: string;
      actionId: string;
      sampledActionFamily: string;
      sampledAmount: number | null;
      finalAction: string;
      finalAmount: number | null;
      executedAsIntended: boolean;
    }> = [];
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
        actionId: 'c',
        sampledActionFamily: 'call',
        sampledAmount: 4_000,
        finalAction: 'call',
        finalAmount: 4_000,
        executedAsIntended: true,
      }),
    ]);
  });

  it('records a sampled raise that legalization downgraded to a call as an execution mismatch', () => {
    const checksum = '7'.repeat(64);
    const candidate: GtoPostflopV31Row = {
      ...CELL,
      dataset_id: '22222222-2222-4222-8222-222222222222',
      dataset_key: 'phase4-illegal-raise-candidate',
      dataset_checksum: checksum,
      dataset_state: 'evaluating',
      hero_position: 'BB',
      opponent_position: 'SB',
      node_role: 'facing_bet',
      facing_kind: 'bet',
      facing_size_bucket: 'mid',
      hand_matrix: { '43o:11': { f: 0, c: 0, b1: 1 } },
      action_specs: {
        f: { family: 'fold', size_unit: 'none', size_value: null, all_in: false },
        c: { family: 'call', size_unit: 'none', size_value: null, all_in: false },
        b1: {
          family: 'raise',
          size_unit: 'pot_after_call_fraction',
          size_value: 0.01,
          all_in: false,
        },
      },
      policy_ev_matrix: { '43o:11': 0 },
      action_ev_matrix: { '43o:11': { f: 0, c: 0, b1: 0 } },
    };
    replaceGtoPostflopV31Evaluation([candidate]);
    const hero = {
      seat: 1,
      user_id: 'hero',
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
      stack: 7_940,
      bet: 60,
      totalInvested: 60,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      cards: [],
    };
    type Receipt = Parameters<
      NonNullable<NonNullable<Parameters<typeof HorseLogic.decide>[4]>['onGtoV31Decision']>
    >[0];
    const receipts: Receipt[] = [];
    const decision = HorseLogic.decide(
      hero as never,
      {
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
          { stage: 'flop', seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 0 },
          { stage: 'flop', seat: 2, userId: 'villain', action: 'check', amount: 0, timestamp: 1 },
          { stage: 'turn', seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 2 },
          { stage: 'turn', seat: 2, userId: 'villain', action: 'bet', amount: 60, timestamp: 3 },
        ],
      } as never,
      'balanced',
      {},
      {
        mind: false,
        telemetry: false,
        gtoV31DatasetChecksum: checksum,
        onGtoV31Decision: (receipt) => receipts.push(receipt),
      }
    );
    expect(decision).toMatchObject({ action: 'call', amount: 60 });
    expect(receipts).toEqual([
      expect.objectContaining({
        actionId: 'b1',
        sampledActionFamily: 'raise',
        sampledAmount: 62.2,
        finalAction: 'call',
        finalAmount: 60,
        executedAsIntended: false,
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
