import { describe, expect, it } from 'vitest';

import {
  GTO_V31_AGREEMENT_REFERENCE,
  gtoV31AgreementDecisionFromReceipt,
  scoreGtoV31Agreement,
} from './HorseSolverAgreementV31.js';
import { runMatchup, type LeagueResult } from './HorseLeague.js';
import type { GtoV31DecisionReceipt } from '../engine/HorseLogic.js';

const DATASET = {
  id: '11111111-1111-4111-8111-111111111111',
  checksum: 'a'.repeat(64),
};

function receipt(overrides: Partial<GtoV31DecisionReceipt> = {}): GtoV31DecisionReceipt {
  const cell = 'flop|cash|cash_ev|cash_ev|2|srp|SB|BB|80|Arud|cbet|none|none';
  const sourceSeal = {
    dataset_id: DATASET.id,
    dataset_key: 'v31.test',
    dataset_checksum: DATASET.checksum,
    solver_version: 'PioSOLVER-edge-3.0',
    solver_binary_checksum: 'b'.repeat(64),
    pipeline_commit: 'c'.repeat(40),
    pipeline_bundle_checksum: 'd'.repeat(64),
    manifest_version: 'v31-test',
    manifest_checksum: 'e'.repeat(64),
    source_artifact_checksum: 'f'.repeat(64),
    source_combo_order_checksum: '1'.repeat(64),
    range_bundle_checksum: '2'.repeat(64),
    icm_model_checksum: '3'.repeat(64),
    input_bundle_checksum: '4'.repeat(64),
    cell_key_checksum: '5'.repeat(64),
    cell_payload_checksum: '6'.repeat(64),
    lineage_checksum: '7'.repeat(64),
    quality_status: 'validated' as const,
    dataset_state: 'active' as const,
    dataset_cells: 1,
    source_rows: 2,
    train_source_rows: 1,
    holdout_source_rows: 1,
    invalid_rows: 0 as const,
    audited_at: '2026-09-09T00:00:00.000Z',
  };
  return {
    datasetId: DATASET.id,
    datasetChecksum: DATASET.checksum,
    decisionState: {
      schemaVersion: 1,
      street: 'flop',
      gameVariant: 'nlh',
      gameFamily: 'cash',
      objective: 'cash_ev',
      utilityContext: 'cash_ev',
      format: 'cash',
      tableSize: 2,
      potType: 'srp',
      heroPosition: 'SB',
      opponentPosition: 'BB',
      stackBb: 80,
      depthBucket: 80,
      textureClass: 'Arud',
      nodeRole: 'cbet',
      facingKind: 'none',
      facingSizeBucket: 'none',
      hand: 'AKs',
      handKey: 'AKs:11',
      cell,
      board: [
        { rank: '2', suit: 'spades' },
        { rank: '7', suit: 'hearts' },
        { rank: '9', suit: 'diamonds' },
      ],
      holeCards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
      ],
      pot: 12,
      currentBet: 0,
      toCall: 0,
      bigBlind: 2,
    },
    nodeRole: 'cbet',
    cell,
    handKey: 'AKs:11',
    actionId: 'b50',
    sampledActionFamily: 'bet',
    sampledAmount: 6,
    finalAction: 'bet',
    finalAmount: 6,
    executedAsIntended: true,
    referenceDistribution: { c: 0.2, b50: 0.8 },
    policyEvBb: 1.16,
    actionEvsBb: { c: 1.2, b50: 1 },
    sourceSeal,
    ...overrides,
  };
}

function scenarioReceipt(matchup: Parameters<typeof runMatchup>[0]): GtoV31DecisionReceipt {
  const match =
    /(cash|spin|tourney_ev|tourney_icm)_(cash_ev|chip_ev|spin_ladder|satellite|bubble|final_table|in_money|ladder)$/.exec(
      matchup.name
    );
  if (!match) throw new Error(`unknown test scenario ${matchup.name}`);
  const gameFamily = match[1] as GtoV31DecisionReceipt['decisionState']['gameFamily'];
  const utilityContext = match[2] as GtoV31DecisionReceipt['decisionState']['utilityContext'];
  const objective =
    gameFamily === 'cash' ? 'cash_ev' : utilityContext === 'chip_ev' ? 'chip_ev' : 'icm';
  const format = gameFamily === 'cash' ? 'cash' : gameFamily === 'spin' ? 'spin' : 'mtt';
  const tableSize = matchup.seats ?? 2;
  const base = receipt();
  const cell = `flop|${gameFamily}|${objective}|${utilityContext}|${tableSize}|srp|SB|BB|80|Arud|cbet|none|none`;
  return receipt({
    cell,
    decisionState: {
      ...base.decisionState,
      gameFamily,
      objective,
      utilityContext,
      format,
      tableSize,
      cell,
    },
  });
}

const EMPTY_RESULT: LeagueResult = {
  matchup: 'agreement-probe',
  hands: 2,
  bb100: 0,
  stderr: 0,
  durationMs: 1,
  illegalActions: 0,
  truncatedStreets: 0,
  candidatePolicyHits: 0,
  candidateExecutionMismatches: 0,
  candidateNodeRoles: [],
  benchmarkComponents: [],
};

describe('certified V31 agreement receipts', () => {
  it('scores the exact sampled policy action and its per-action EV regret', () => {
    const decision = gtoV31AgreementDecisionFromReceipt({
      receipt: receipt(),
      dataset: DATASET,
      probeScenario: 'cash_ev',
      probeOrdinal: 1,
    });
    expect(decision.chosenProbability).toBe(0.8);
    expect(decision.actionRegretBb).toBeCloseTo(0.2);
    expect(decision.regretEligible).toBe(true);
    expect(decision.pureMiss).toBe(false);
    expect(decision.stateKey).toContain('|AKs:11|cash_ev|1');
    expect(decision.sourceSeal.dataset_checksum).toBe(DATASET.checksum);
  });

  it('makes a legalization mismatch visible instead of scoring the sampled action', () => {
    const bad = receipt({
      finalAction: 'check',
      finalAmount: null,
      executedAsIntended: false,
      referenceDistribution: { c: 0.05, b50: 0.95 },
    });
    const decision = gtoV31AgreementDecisionFromReceipt({
      receipt: bad,
      dataset: DATASET,
      probeScenario: 'cash_ev',
      probeOrdinal: 1,
    });
    expect(decision.chosenProbability).toBe(0);
    expect(decision.actionRegretBb).toBeNull();
    expect(decision.regretEligible).toBe(false);
    expect(decision.pureMiss).toBe(true);
  });

  it('rejects a receipt detached from the active dataset identity', () => {
    expect(() =>
      gtoV31AgreementDecisionFromReceipt({
        receipt: receipt({ datasetChecksum: '9'.repeat(64) }),
        dataset: DATASET,
        probeScenario: 'cash_ev',
        probeOrdinal: 1,
      })
    ).toThrow(/contradictory decision receipt/);
    expect(() =>
      gtoV31AgreementDecisionFromReceipt({
        receipt: receipt(),
        dataset: DATASET,
        probeScenario: 'bubble',
        probeOrdinal: 1,
      })
    ).toThrow(/contradictory decision receipt/);
  });

  it('stays silent when there is no promoted active corpus', async () => {
    await expect(
      scoreGtoV31Agreement(9, {
        dependencies: { dataset: () => null, cellCount: () => 0 },
      })
    ).resolves.toMatchObject({ reference: null, spots: 0, decisions: [] });
  });

  it('fails closed on a partial active-store identity or a sample too small for every scenario', async () => {
    await expect(
      scoreGtoV31Agreement(9, {
        dependencies: { dataset: () => DATASET, cellCount: () => 0 },
      })
    ).rejects.toThrow(/active cell count/);
    await expect(scoreGtoV31Agreement(8)).rejects.toThrow(/integer from 9/);
  });

  it('drives all nine Phase 4 family/utility scenarios through the active store without a candidate selector', async () => {
    const seen: string[] = [];
    const run = async (matchup: Parameters<typeof runMatchup>[0]) => {
      expect(matchup.a.gtoV31DatasetChecksum).toBeUndefined();
      expect(matchup.b.gtoV31DatasetChecksum).toBeUndefined();
      expect(matchup.b.onGtoV31Decision).toBeUndefined();
      matchup.a.onGtoV31Decision?.(scenarioReceipt(matchup));
      seen.push(matchup.name);
      return EMPTY_RESULT;
    };
    const result = await scoreGtoV31Agreement(9, {
      dependencies: {
        dataset: () => DATASET,
        cellCount: () => 1,
        run: run as typeof runMatchup,
      },
    });
    expect(seen).toHaveLength(9);
    expect(result.reference).toBe(GTO_V31_AGREEMENT_REFERENCE);
    expect(result.spots).toBe(9);
    expect(result.reconciledSpots).toBe(9);
    expect(result.regretEligibleSpots).toBe(9);
    expect(result.decisionChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(result.decisions.map((decision) => decision.stateKey)).size).toBe(9);
  });

  it('fails closed when any required family or utility scenario produces no decision', async () => {
    let ordinal = 0;
    const run = async (matchup: Parameters<typeof runMatchup>[0]) => {
      ordinal++;
      if (ordinal !== 4) matchup.a.onGtoV31Decision?.(scenarioReceipt(matchup));
      return EMPTY_RESULT;
    };
    await expect(
      scoreGtoV31Agreement(9, {
        dependencies: {
          dataset: () => DATASET,
          cellCount: () => 1,
          run: run as typeof runMatchup,
        },
      })
    ).rejects.toThrow(/0\/1 required agreement decisions for .+\|.+/);
  });

  it('rejects an underfilled context instead of hiding it inside the total sample', async () => {
    const run = async (matchup: Parameters<typeof runMatchup>[0]) => {
      matchup.a.onGtoV31Decision?.(scenarioReceipt(matchup));
      return EMPTY_RESULT;
    };
    await expect(
      scoreGtoV31Agreement(18, {
        dependencies: {
          dataset: () => DATASET,
          cellCount: () => 1,
          run: run as typeof runMatchup,
        },
      })
    ).rejects.toThrow(/1\/2 required agreement decisions for .+\|.+/);
  });

  it('allocates the requested sample across every scenario without starving the tail', async () => {
    const counts: number[] = [];
    const run = async (
      matchup: Parameters<typeof runMatchup>[0],
      _pairs: number,
      _seed: number,
      shouldContinue?: () => boolean
    ) => {
      let count = 0;
      while (shouldContinue?.()) {
        matchup.a.onGtoV31Decision?.(scenarioReceipt(matchup));
        count++;
      }
      counts.push(count);
      return EMPTY_RESULT;
    };
    const result = await scoreGtoV31Agreement(20, {
      dependencies: {
        dataset: () => DATASET,
        cellCount: () => 1,
        run: run as typeof runMatchup,
      },
    });
    expect(result.spots).toBe(20);
    expect(counts).toEqual([3, 3, 2, 2, 2, 2, 2, 2, 2]);
  });
});
