import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SOLVER_POLICY_CONTRACT_VERSION,
  SOLVER_POLICY_SCHEMA_SHA256,
  SOLVER_POLICY_VERSION,
  solverPolicyKeyMissingDimensions,
  stableSolverPolicyJson,
  validateSolverPolicyAnswer,
  type SolverPolicyArtifactBundle,
} from './SolverPolicyContract.js';
import {
  _clearSolverPolicyArtifactsForTests,
  createChartSolverPolicy,
  hydrateChartPolicyArtifact,
  loadConfiguredSolverPolicyArtifact,
  loadSolverPolicyArtifactFile,
  lookupChartPolicy,
  lookupChartPolicyAdvice,
  replaceSolverPolicyArtifact,
  solverPolicyArtifactStatus,
} from './SolverPolicyArtifactLoader.js';

const chartRow = {
  chart_id: 'chart-fixture-1',
  game_type: 'Tournament',
  stack_depth: 10,
  hero_position: 'BTN',
  villain_action: 'fold_to_hero',
  created_at: '2026-09-06T12:00:00.000Z',
  hand_matrix: {
    AA: { push: 1, fold: 0 },
    AKs: { push: 0.75, fold: 0.25 },
    QJs: { push: null, fold: 0.2 },
    '72o': { push: 0, fold: 1 },
  },
};

function bundle(policy = createChartSolverPolicy(chartRow)): SolverPolicyArtifactBundle {
  return {
    contractVersion: SOLVER_POLICY_CONTRACT_VERSION,
    schemaSha256: SOLVER_POLICY_SCHEMA_SHA256,
    policyVersion: SOLVER_POLICY_VERSION,
    generatedAt: '2026-09-06T12:00:00.000Z',
    sourceArtifact: 'contract-test',
    policies: [policy],
  };
}

beforeEach(() => _clearSolverPolicyArtifactsForTests());
afterEach(() => _clearSolverPolicyArtifactsForTests());

describe('cross-repository solver policy contract', () => {
  it('pins the deployed schema bytes and policy version', () => {
    const filename = fileURLToPath(
      new URL('./contracts/solver-policy.v1.schema.json', import.meta.url)
    );
    const checksum = createHash('sha256').update(readFileSync(filename)).digest('hex');
    expect(checksum).toBe(SOLVER_POLICY_SCHEMA_SHA256);
    expect(SOLVER_POLICY_CONTRACT_VERSION).toBe('smarter-poker.solver-policy.v1');
    expect(SOLVER_POLICY_VERSION).toBe('solver-policy-service.1.0.1');
  });

  it('requires an explicit complete cash utility model before a key can be exact', () => {
    const key = structuredClone(createChartSolverPolicy({ ...chartRow, game_type: 'Cash' }).key);
    expect(solverPolicyKeyMissingDimensions(key)).toContain('tournamentUtility');
    key.tournamentUtility.complete = true;
    expect(solverPolicyKeyMissingDimensions(key)).not.toContain('tournamentUtility');
  });

  it('matches the World Hub chart fixture byte for byte, including sparse-fold semantics', () => {
    const filename = fileURLToPath(
      new URL('./contracts/fixtures/chart-policy.v1.json', import.meta.url)
    );
    const expected = JSON.parse(readFileSync(filename, 'utf8'));
    const actual = createChartSolverPolicy(chartRow);
    expect(stableSolverPolicyJson(actual)).toBe(stableSolverPolicyJson(expected));
    expect(actual.rangeDistribution?.J4o).toEqual({ all_in: 0, fold: 1 });
    expect(actual.rangeDistribution?.QJs).toEqual({ all_in: 0.8, fold: 0.2 });
    expect(validateSolverPolicyAnswer(actual)).toEqual({ valid: true, errors: [] });
  });

  it('never accepts a legacy V1 source as exact', () => {
    const forged = structuredClone(createChartSolverPolicy(chartRow));
    forged.kind = 'exact';
    forged.qualitySeal = 'SOLVER_EXACT';
    forged.sourceArtifact.system = 'solved_spots_gold_v1';
    forged.sourceArtifact.provenanceComplete = true;
    const validation = validateSolverPolicyAnswer(forged);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('exact.legacyV1');

    const exactFilename = fileURLToPath(
      new URL('./contracts/fixtures/exact-policy.v1.json', import.meta.url)
    );
    const exact = JSON.parse(readFileSync(exactFilename, 'utf8'));
    for (const system of ['V1', 'PioSOLVER-v1', 'solved_spots_gold_v1']) {
      const candidate = structuredClone(exact);
      candidate.sourceArtifact.system = system;
      expect(validateSolverPolicyAnswer(candidate).valid, system).toBe(false);
    }
    const laterVersion = structuredClone(exact);
    laterVersion.sourceArtifact.system = 'solved_spots_gold_v10';
    expect(validateSolverPolicyAnswer(laterVersion).valid).toBe(true);
  });

  it('rejects per-action EV unless the complete action set is marked measured', () => {
    const policy = structuredClone(createChartSolverPolicy(chartRow));
    policy.actions[0].chipEvBb = 12;
    policy.chipEv.byAction.all_in = 12;
    expect(validateSolverPolicyAnswer(policy).errors).toContain('chipEv');

    policy.chipEv.measuredByAction = true;
    expect(validateSolverPolicyAnswer(policy).errors).toContain('chipEv');
  });

  it('accepts the World Hub exact fixture and rejects any forged exact qualifier', () => {
    const filename = fileURLToPath(
      new URL('./contracts/fixtures/exact-policy.v1.json', import.meta.url)
    );
    const exact = JSON.parse(readFileSync(filename, 'utf8'));
    expect(validateSolverPolicyAnswer(exact)).toEqual({ valid: true, errors: [] });

    const legacy = structuredClone(exact);
    legacy.sourceArtifact.system = 'solved_spots_gold_v1';
    expect(validateSolverPolicyAnswer(legacy).errors).toContain('exact.legacyV1');

    const approximated = structuredClone(exact);
    approximated.validDomain.approximatedDimensions = ['stackDepth'];
    expect(validateSolverPolicyAnswer(approximated).errors).toContain('exact.approximation');

    const fallback = structuredClone(exact);
    fallback.fallbackReason = 'nearest_stack_policy_node';
    expect(validateSolverPolicyAnswer(fallback).errors).toContain('exact.fallback');

    const unsealed = structuredClone(exact);
    unsealed.sourceArtifact.manifestChecksum = null;
    expect(validateSolverPolicyAnswer(unsealed).errors).toContain('exact.provenance');

    const missingSize = structuredClone(exact);
    delete missingSize.actions[0].size;
    expect(() => validateSolverPolicyAnswer(missingSize)).not.toThrow();
    expect(validateSolverPolicyAnswer(missingSize).valid).toBe(false);

    const ambiguousSize = structuredClone(exact);
    ambiguousSize.actions[1].size = {
      unit: 'unknown',
      chips: null,
      bigBlinds: null,
      potFraction: null,
      exact: false,
    };
    ambiguousSize.legalSizes[0] = {
      actionId: ambiguousSize.actions[1].id,
      ...ambiguousSize.actions[1].size,
    };
    expect(validateSolverPolicyAnswer(ambiguousSize).errors).toContain('exact.actionSizes');

    const illegalFamily = structuredClone(exact);
    illegalFamily.actions[1].family = 'raise';
    expect(validateSolverPolicyAnswer(illegalFamily).errors).toContain('exact.legalActions');

    const negativeSeat = structuredClone(exact);
    negativeSeat.key.stackVector[0].seat = -1;
    expect(validateSolverPolicyAnswer(negativeSeat).valid).toBe(false);

    const negativeStraddleSeat = structuredClone(exact);
    negativeStraddleSeat.key.blinds.straddles = [{ seat: -1, amount: 4 }];
    expect(validateSolverPolicyAnswer(negativeStraddleSeat).valid).toBe(false);

    const uncheckableUnit = structuredClone(exact);
    uncheckableUnit.actions[1].size.chips = null;
    uncheckableUnit.legalSizes[0].chips = null;
    expect(validateSolverPolicyAnswer(uncheckableUnit).errors).toContain('exact.actionSizes');

    for (const mutate of [
      (candidate: any) => {
        candidate.actions[1].size.bigBlinds = 6;
      },
      (candidate: any) => {
        candidate.actions[1].size.potFraction = 1.75;
      },
    ]) {
      const inconsistent = structuredClone(exact);
      mutate(inconsistent);
      inconsistent.legalSizes[0] = {
        actionId: inconsistent.actions[1].id,
        ...inconsistent.actions[1].size,
      };
      expect(validateSolverPolicyAnswer(inconsistent).errors).toContain('exact.actionUnits');
    }

    const consistentOverbet = structuredClone(exact);
    consistentOverbet.actions[1].size = {
      unit: 'pot_fraction',
      chips: 1225,
      bigBlinds: 12.25,
      potFraction: 1.75,
      exact: true,
    };
    consistentOverbet.legalSizes[0] = {
      actionId: consistentOverbet.actions[1].id,
      ...consistentOverbet.actions[1].size,
    };
    consistentOverbet.key.legalActions[0].exactChips = 1225;
    expect(validateSolverPolicyAnswer(consistentOverbet)).toEqual({ valid: true, errors: [] });

    const exactAllIn = structuredClone(exact);
    exactAllIn.actions[1].family = 'all_in';
    exactAllIn.actions[1].size.unit = 'all_in';
    exactAllIn.legalSizes[0] = {
      actionId: exactAllIn.actions[1].id,
      ...exactAllIn.actions[1].size,
    };
    exactAllIn.key.legalActions[0].action = 'all_in';
    exactAllIn.key.legalActions[0].allIn = true;
    expect(validateSolverPolicyAnswer(exactAllIn)).toEqual({ valid: true, errors: [] });
    exactAllIn.actions[1].size.chips = null;
    exactAllIn.legalSizes[0].chips = null;
    expect(validateSolverPolicyAnswer(exactAllIn).errors).toContain('exact.actionSizes');

    const unknownFamily = structuredClone(exact);
    unknownFamily.actions[1].family = 'teleport';
    unknownFamily.key.legalActions[0].action = 'teleport';
    expect(validateSolverPolicyAnswer(unknownFamily).errors).toContain('exact.actionSizes');

    const impossibleKeyMutations = [
      (candidate: any) => {
        candidate.key.stackVector[0].committedChips = -1;
      },
      (candidate: any) => {
        candidate.key.blinds.ante = -1;
      },
      (candidate: any) => {
        candidate.key.rake.capBb = -1;
      },
      (candidate: any) => {
        candidate.key.publicActionHistory.actions[1].sequence = 0;
      },
      (candidate: any) => {
        candidate.key.legalActions[0].exactChips = -1;
      },
      (candidate: any) => {
        candidate.key.legalActions[0].minChips = 600;
        candidate.key.legalActions[0].maxChips = 500;
      },
      (candidate: any) => {
        candidate.node.potBb = -1;
      },
      (candidate: any) => {
        candidate.key.publicActionHistory.actions = [];
      },
      (candidate: any) => {
        candidate.key.stackVector[0].position = 'CO';
      },
      (candidate: any) => {
        candidate.key.positions.hero = 'CO';
      },
      (candidate: any) => {
        candidate.key.positions.villains = ['SB'];
      },
      (candidate: any) => {
        candidate.key.blinds.straddles = [{ seat: 2, amount: 200 }];
      },
      (candidate: any) => {
        candidate.key.sidePotEligibility.pots[0].eligibleSeats = [0, 2];
      },
      (candidate: any) => {
        candidate.key.sidePotEligibility.pots[0].eligibleSeats = [0, 0];
      },
      (candidate: any) => {
        candidate.key.sidePotEligibility.pots.push(
          structuredClone(candidate.key.sidePotEligibility.pots[0])
        );
      },
      (candidate: any) => {
        candidate.key.publicActionHistory.actions[0].amountBb = 9;
      },
      (candidate: any) => {
        candidate.key.stackVector[0].stackChips = 9_900;
      },
      (candidate: any) => {
        candidate.key.rake.capChips = 300;
      },
      (candidate: any) => {
        candidate.key.publicActionHistory.actions[0].street = 'turn';
      },
      (candidate: any) => {
        candidate.key.publicActionHistory.actions[2].street = 'flop';
      },
    ];
    for (const mutate of impossibleKeyMutations) {
      const candidate = structuredClone(exact);
      mutate(candidate);
      expect(validateSolverPolicyAnswer(candidate).valid).toBe(false);
    }

    for (const [error, mutate] of [
      ['exact.node', (candidate: any) => (candidate.node.actor = 'BTN')],
      ['exact.node', (candidate: any) => (candidate.node.semantics = 'unknown')],
      ['exact.node', (candidate: any) => (candidate.node.facingBetBb = null)],
      ['exact.domain', (candidate: any) => (candidate.validDomain.exactMatchDimensions = [])],
      [
        'exact.domain',
        (candidate: any) => (candidate.validDomain.exactMatchDimensions = ['board']),
      ],
      ['exact.domain', (candidate: any) => (candidate.validDomain.exclusions = ['unsupported'])],
    ] as const) {
      const candidate = structuredClone(exact);
      mutate(candidate);
      expect(validateSolverPolicyAnswer(candidate).errors).toContain(error);
    }
  });

  it('rejects dishonest kind, size, confidence, and empty-artifact relationships', () => {
    const policy = structuredClone(createChartSolverPolicy(chartRow));
    policy.qualitySeal = 'SOLVER_EXACT';
    expect(validateSolverPolicyAnswer(policy).errors).toContain('kindQualitySeal');

    const wrongSizes = structuredClone(createChartSolverPolicy(chartRow));
    wrongSizes.legalSizes = [];
    expect(validateSolverPolicyAnswer(wrongSizes).errors).toContain('legalSizes.mismatch');

    const wrongConfidence = structuredClone(createChartSolverPolicy(chartRow));
    wrongConfidence.confidence = { score: 0.2, level: 'high' };
    expect(validateSolverPolicyAnswer(wrongConfidence).errors).toContain('confidence.level');

    expect(() => replaceSolverPolicyArtifact({ ...bundle(), policies: [] })).toThrow(
      /artifact\.policies\.empty/
    );
  });
});

describe('atomic artifact hydration', () => {
  it('loads the exact artifact envelope published by World Hub from disk', () => {
    const filename = fileURLToPath(
      new URL('./contracts/fixtures/chart-policy-artifact.v1.json', import.meta.url)
    );
    expect(loadSolverPolicyArtifactFile(filename)).toBe(1);
    expect(
      lookupChartPolicy({
        gameType: 'Tournament',
        villainAction: 'fold_to_hero',
        position: 'BTN',
        depth: 10,
      })
    ).toEqual(createChartSolverPolicy(chartRow));
    expect(solverPolicyArtifactStatus().external).toMatchObject({
      count: 1,
      lastError: null,
      sourceArtifact: 'world-hub-chart-fixture',
    });
  });

  it('retains the last good external artifact when a replacement is invalid', () => {
    const policy = createChartSolverPolicy(chartRow);
    expect(replaceSolverPolicyArtifact(bundle(policy))).toBe(1);
    expect(
      lookupChartPolicy({
        gameType: 'Tournament',
        villainAction: 'fold_to_hero',
        position: 'BTN',
        depth: 10,
      })
    ).toEqual(policy);

    const invalid = { ...bundle(policy), schemaSha256: 'wrong' };
    expect(() => replaceSolverPolicyArtifact(invalid)).toThrow(/artifact\.schemaSha256/);
    expect(
      lookupChartPolicy({
        gameType: 'Tournament',
        villainAction: 'fold_to_hero',
        position: 'BTN',
        depth: 10,
      })
    ).toEqual(policy);
    expect(solverPolicyArtifactStatus().external.count).toBe(1);
    expect(solverPolicyArtifactStatus().external.lastError).toMatch(/artifact\.schemaSha256/);
  });

  it('rejects chart artifacts whose lookup identity or canonical range semantics drift', () => {
    const baseline = createChartSolverPolicy(chartRow);
    expect(replaceSolverPolicyArtifact(bundle(baseline))).toBe(1);

    const wrongIdentity = structuredClone(baseline);
    wrongIdentity.key.positions.hero = 'CO';
    wrongIdentity.key.stackVector[0].position = 'CO';
    wrongIdentity.node.actor = 'CO';

    const incompleteRange = structuredClone(baseline);
    delete incompleteRange.rangeDistribution!.AA;

    const contradictoryAggregate = structuredClone(baseline);
    contradictoryAggregate.actions[0].frequency = 0.25;
    contradictoryAggregate.actions[1].frequency = 0.75;
    contradictoryAggregate.distribution = { all_in: 0.25, fold: 0.75 };

    for (const policy of [wrongIdentity, incompleteRange, contradictoryAggregate]) {
      expect(validateSolverPolicyAnswer(policy)).toEqual({ valid: true, errors: [] });
      expect(() => replaceSolverPolicyArtifact(bundle(policy))).toThrow(/chart_artifact_identity/);
    }
    expect(solverPolicyArtifactStatus().external.count).toBe(1);
    expect(
      lookupChartPolicy({
        gameType: 'Tournament',
        villainAction: 'fold_to_hero',
        position: 'BTN',
        depth: 10,
      })
    ).toEqual(baseline);
  });

  it('clears a stale external map when no deployment artifact is configured', () => {
    const prior = process.env.SOLVER_POLICY_ARTIFACT_PATH;
    try {
      delete process.env.SOLVER_POLICY_ARTIFACT_PATH;
      const policy = createChartSolverPolicy(chartRow);
      replaceSolverPolicyArtifact(bundle(policy));
      expect(loadConfiguredSolverPolicyArtifact()).toBe(0);
      expect(
        lookupChartPolicy({
          gameType: 'Tournament',
          villainAction: 'fold_to_hero',
          position: 'BTN',
          depth: 10,
        })
      ).toBeNull();
      expect(solverPolicyArtifactStatus().external.configured).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.SOLVER_POLICY_ARTIFACT_PATH;
      else process.env.SOLVER_POLICY_ARTIFACT_PATH = prior;
    }
  });

  it('rejects duplicate identities atomically instead of choosing an arbitrary policy', () => {
    const policy = createChartSolverPolicy(chartRow);
    replaceSolverPolicyArtifact(bundle(policy));
    const conflicting = structuredClone(policy);
    conflicting.confidence.score = 0.91;
    const duplicate = { ...bundle(policy), policies: [policy, conflicting] };
    expect(() => replaceSolverPolicyArtifact(duplicate)).toThrow(/duplicate_scenario_hash/);
    expect(
      lookupChartPolicy({
        gameType: 'Tournament',
        villainAction: 'fold_to_hero',
        position: 'BTN',
        depth: 10,
      })?.confidence.score
    ).toBe(0.92);
    expect(solverPolicyArtifactStatus().external.count).toBe(1);
  });

  it('retains the last good chart map when any refresh row is malformed', () => {
    expect(hydrateChartPolicyArtifact([chartRow])).toBe(1);
    const before = lookupChartPolicyAdvice({
      gameType: 'Tournament',
      villainAction: 'fold_to_hero',
      position: 'BTN',
      depth: 10,
      hand: 'AA',
    });
    expect(before?.action).toBe('push');
    expect(() =>
      hydrateChartPolicyArtifact([
        chartRow,
        { ...chartRow, chart_id: 'bad', stack_depth: Number.NaN },
      ])
    ).toThrow(/invalid_chart_policy_row/);
    expect(
      lookupChartPolicyAdvice({
        gameType: 'Tournament',
        villainAction: 'fold_to_hero',
        position: 'BTN',
        depth: 10,
        hand: 'AA',
      })?.action
    ).toBe('push');
    expect(solverPolicyArtifactStatus().charts.count).toBe(1);
    expect(solverPolicyArtifactStatus().charts.lastError).toMatch(/invalid_chart_policy_row/);
  });

  it('retains the last good chart map when a successful refresh is empty', () => {
    expect(hydrateChartPolicyArtifact([chartRow])).toBe(1);
    expect(() => hydrateChartPolicyArtifact([])).toThrow(/empty_chart_policy_refresh/);
    expect(
      lookupChartPolicyAdvice({
        gameType: 'Tournament',
        villainAction: 'fold_to_hero',
        position: 'BTN',
        depth: 10,
        hand: 'AA',
      })?.action
    ).toBe('push');
    expect(solverPolicyArtifactStatus().charts).toMatchObject({
      count: 1,
      lastError: 'empty_chart_policy_refresh',
    });
  });

  it('rejects malformed chart identities and cells instead of treating corruption as folds', () => {
    expect(() =>
      createChartSolverPolicy({
        ...chartRow,
        hand_matrix: { AA: { push: 1, fold: 0, call: 0 } },
      } as never)
    ).toThrow(/invalid_chart_policy_actions/);
    expect(() => createChartSolverPolicy({ ...chartRow, hand_matrix: [] } as never)).toThrow(
      /invalid_chart_policy_row/
    );
    expect(() =>
      createChartSolverPolicy({
        ...chartRow,
        hand_matrix: { AA: { push: 1.1, fold: -0.1 } },
      })
    ).toThrow(/invalid_chart_policy_frequency/);
    expect(() =>
      createChartSolverPolicy({
        ...chartRow,
        hand_matrix: { AA: { push: 0.7, fold: 0.4 } },
      })
    ).toThrow(/invalid_chart_policy_mix/);
    expect(() => createChartSolverPolicy({ ...chartRow, hero_position: 'BB' })).toThrow(
      /invalid_chart_policy_identity/
    );
    expect(() => createChartSolverPolicy({ ...chartRow, chart_id: 42 } as never)).toThrow(
      /invalid_chart_policy_row/
    );
    expect(() => createChartSolverPolicy({ ...chartRow, created_at: 'not-an-instant' })).toThrow(
      /invalid_chart_policy_row/
    );
  });

  it('serves every chart lookup from immutable memory with explicit liveness', () => {
    hydrateChartPolicyArtifact([chartRow]);
    const absent = lookupChartPolicyAdvice({
      gameType: 'Tournament',
      villainAction: 'fold_to_hero',
      position: 'BTN',
      depth: 10,
      hand: 'J4o',
    });
    expect(absent).toMatchObject({ action: 'fold', freq: 1 });
    expect(Object.isFrozen(absent?.policy)).toBe(true);
    expect(solverPolicyArtifactStatus()).toMatchObject({
      contractVersion: SOLVER_POLICY_CONTRACT_VERSION,
      schemaSha256: SOLVER_POLICY_SCHEMA_SHA256,
      actionClockSource: 'memory_only',
      charts: { count: 1, lastError: null },
      totalPolicies: 1,
    });
    const source = readFileSync(
      fileURLToPath(new URL('./SolverPolicyArtifactLoader.ts', import.meta.url)),
      'utf8'
    );
    expect(source).not.toMatch(/\bfetch\s*\(|\.from\s*\(|https?:\/\//);
  });

  it('wires boot, health, the horse action path, and nightly agreement to the memory artifact', () => {
    const source = (relative: string) =>
      readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    const worker = source('../engine/horseDecision/localServices.ts');
    const bindings = source('../engine/horseDecision/localDependencies.ts');
    expect(bindings).toContain('startPolicyLoader: startSolverPolicyArtifactLoader');
    expect(bindings).toContain('stopPolicyLoader: stopSolverPolicyArtifactLoader');
    expect(worker).toContain('services.startPolicyLoader();');
    expect(worker.indexOf('services.startPolicyLoader();')).toBeLessThan(
      worker.indexOf('services.startChartLoader();')
    );
    expect(source('../GameServer.ts')).toContain(
      'solverPolicyArtifact: liveHorseDecision.solverPolicyArtifact'
    );
    expect(source('../engine/GtoCharts.ts')).toContain('lookupChartPolicyAdvice');
    expect(source('../engine/GtoCharts.ts')).toContain('hydrateChartPolicyArtifact');
    expect(source('../benchmark/HorseSolverAgreement.ts')).toContain('lookupChartPolicyAdvice');
    expect(source('../benchmark/HorseLeague.ts')).toContain('scoreSolverAgreement()');
    expect(worker).toContain('services.stopPolicyLoader()');
    expect(worker).toContain('services.stopChartLoader()');
    expect(bindings).toContain('stopChartLoader: stopGtoChartLoader');
  });
});
