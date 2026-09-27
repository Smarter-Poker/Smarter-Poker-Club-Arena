/**
 * Phase 6B real-consumer and mismatch-refusal checks.
 *
 * Real consumers: the receipt validator in `HorsePhase6Attribution.ts` and the
 * worker admission in `horseDecision/workerRuntime.ts` read the atlas domain
 * (`TOURNAMENT_CONTEXT_STATUSES`, `TOURNAMENT_ANTE_TYPES`,
 * `TOURNAMENT_GAME_FAMILIES`, `TOURNAMENT_FALLBACK_PRECEDENCE`) and rebuild the
 * cell through the atlas's own `tournamentPreflopCell`; they keep no second
 * table. HorseLogic and HorsePreflop ask the atlas's one next-level projection
 * gate (`tournamentNextLevelProjectionApplies`) instead of carrying its
 * thresholds as literals. This file pins that by source text and by behaviour:
 * the validator admits exactly the domain's values and refuses one value
 * outside each axis, and the gate fires exactly inside its stated thresholds.
 *
 * Mismatch refusal: a receipt whose declared coordinate disagrees with the
 * coordinate recomputed from the public snapshot is refused with a named
 * reason from `horsePhase6AttributionMismatch`, at the pure matcher and at the
 * live worker client. The alternative receipts are produced by the real lookup
 * for a genuinely different coordinate, so each refusal is of a self-consistent
 * receipt from the wrong seat, size, depth, branch, family, ante or context.
 *
 * Nothing here validates strategy or natural reachability.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  TOURNAMENT_ANTE_TYPES,
  TOURNAMENT_CONTEXT_STATUSES,
  TOURNAMENT_FALLBACK_PRECEDENCE,
  TOURNAMENT_GAME_FAMILIES,
  TOURNAMENT_NEXT_LEVEL_PROJECTION_GATE,
  TOURNAMENT_PREFLOP_ATLAS_DOMAIN,
  interpolateTournamentDepth,
  tournamentCoordinateIsValid,
  tournamentNextLevelProjectionApplies,
  tournamentPreflopCell,
  tournamentPreflopPolicy,
  tournamentVelocityUrgency,
  type TournamentPreflopPolicyInput,
} from './HorseTournamentPreflop.js';
import {
  horsePhase6AttributionIsValid,
  horsePhase6AttributionMatchesSnapshot,
  horsePhase6AttributionMismatch,
  observePhase6Lookup,
  type HorsePhase6Attribution,
  type Phase6AttributionMismatch,
} from './HorsePhase6Attribution.js';
import { HorseLogic } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { LiveHorseDecisionWorkerClient } from './horseDecision/client.js';
import { horsePlanBatchBindingFromRequest } from './HorsePlanHandIdentity.js';
import {
  fixture,
  request,
  withPhase6Provenance,
} from '../testing/horseRegression/merged/fixture.js';
import type { HorseDecision } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const DOMAIN = TOURNAMENT_PREFLOP_ATLAS_DOMAIN;

function baseInput(
  overrides: Partial<TournamentPreflopPolicyInput> = {}
): TournamentPreflopPolicyInput {
  return {
    gameFamily: 'nlh',
    contextStatus: 'complete',
    tableSize: 6,
    heroPosition: 'BTN',
    raiserPosition: 'HJ',
    anteType: 'per_player',
    branch: 'cold_call',
    stackBB: 22,
    ...overrides,
  };
}

/** A v1 receipt around one real lookup on an intent-engine route. */
function receiptFor(input: TournamentPreflopPolicyInput): HorsePhase6Attribution {
  const policy = tournamentPreflopPolicy(input);
  return {
    version: 'horse-phase6-attribution-v1',
    status: policy.source === 'deterministic_baseline' ? 'atlas_evaluated' : 'unavailable',
    route: 'intent_engine',
    reason: policy.fallbackReason ?? 'atlas_forwarded',
    inputSource: {
      basis: 'provided_decision_snapshot',
      stateSchemaVersion: 1,
      tournamentSchemaVersion: 1,
      tournamentMode: true,
    },
    atlasEvaluated: true,
    forwardedToIntentEngine: true,
    lookup: observePhase6Lookup(input, policy),
    referenceProposal: { action: 'fold', amount: null },
    causalInfluence: 'not_established',
    gtoOptimality: 'not_established',
  };
}

describe('Phase 6B real consumers read the one atlas domain', () => {
  const attributionSource = readFileSync(join(here, 'HorsePhase6Attribution.ts'), 'utf8');
  const workerSource = readFileSync(join(here, 'horseDecision', 'workerRuntime.ts'), 'utf8');
  const literalTables = [
    "['complete', 'incomplete', 'warming', 'stale']",
    "['none', 'per_player', 'big_blind']",
    "['nlh', 'omaha', 'other']",
    "'unsupported_variant', 'incomplete_context', 'invalid_coordinate'",
    "'phase6-v1'",
  ];

  it('the receipt validator imports the domain arrays and the cell builder instead of copying them', () => {
    for (const symbol of [
      'TOURNAMENT_ANTE_TYPES',
      'TOURNAMENT_CONTEXT_STATUSES',
      'TOURNAMENT_FALLBACK_PRECEDENCE',
      'TOURNAMENT_GAME_FAMILIES',
      'tournamentCoordinateIsValid',
      'tournamentPreflopCell',
      'tournamentVelocityUrgency',
    ])
      expect(attributionSource).toContain(symbol);
    for (const literal of literalTables) expect(attributionSource).not.toContain(literal);
    expect(attributionSource).not.toContain('c.tableSize >= 2');
    expect(attributionSource).not.toContain('* 1000) / 1000');
  });

  it('the worker admission imports the domain status and ante arrays instead of copying them', () => {
    expect(workerSource).toContain('TOURNAMENT_CONTEXT_STATUSES');
    expect(workerSource).toContain('TOURNAMENT_ANTE_TYPES');
    for (const literal of literalTables.slice(0, 2)) expect(workerSource).not.toContain(literal);
  });

  it('HorseLogic, HorsePreflop and the receipt matcher ask the one next-level projection gate instead of copying it', () => {
    const logicSource = readFileSync(join(here, 'HorseLogic.ts'), 'utf8');
    const preflopSource = readFileSync(join(here, 'HorsePreflop.ts'), 'utf8');
    for (const source of [logicSource, preflopSource, attributionSource]) {
      expect(source).toContain('tournamentNextLevelProjectionApplies(');
      // The gate literals that each consumer used to carry beside its clock read.
      expect(source).not.toMatch(/nextBlindInMin\s*<=\s*3\b/);
      expect(source).not.toMatch(/nextBlindMult\s*\?\?\s*1\)\s*>\s*1\.15/);
    }
    expect(DOMAIN.m.projection).toBe(TOURNAMENT_NEXT_LEVEL_PROJECTION_GATE);
  });

  it('the projection gate fires exactly inside the domain thresholds, at both edges', () => {
    const { maxMinutes, minMultiplierExclusive } = DOMAIN.m.projection;
    expect([maxMinutes, minMultiplierExclusive]).toEqual([3, 1.15]);
    const rows: Array<[number | null | undefined, number | null | undefined, boolean]> = [
      [3, 1.16, true],
      [0, 2, true],
      [2.99, 1.1500001, true],
      [3, 1.15, false],
      [3.01, 1.16, false],
      [3, 1, false],
      [3, undefined, false],
      [3, null, false],
      [null, 2, false],
      [undefined, 2, false],
      [Number.NaN, 2, false],
    ];
    for (const [minutes, mult, fires] of rows)
      expect(tournamentNextLevelProjectionApplies(minutes, mult)).toBe(fires);
  });

  it('the validator admits exactly the domain statuses, families and ante types on a real lookup', () => {
    const families = [...DOMAIN.gameFamilies.supported, ...DOMAIN.gameFamilies.labeled];
    const statuses = [...DOMAIN.contextStatuses.baseline, ...DOMAIN.contextStatuses.fallback];
    let admitted = 0;
    for (const gameFamily of families)
      for (const contextStatus of statuses)
        for (const anteType of DOMAIN.anteTypes) {
          const receipt = receiptFor(baseInput({ gameFamily, contextStatus, anteType }));
          expect(horsePhase6AttributionIsValid(receipt)).toBe(true);
          admitted++;
        }
    expect(admitted).toBe(families.length * statuses.length * DOMAIN.anteTypes.length);
    expect(admitted).toBe(36);
    const valid = receiptFor(baseInput());
    const outside = (mutate: (receipt: HorsePhase6Attribution) => void) => {
      const copy = structuredClone(valid);
      mutate(copy);
      return horsePhase6AttributionIsValid(copy);
    };
    expect(
      outside(
        (r) => ((r.lookup!.coordinate as { contextStatus: string }).contextStatus = 'pending')
      )
    ).toBe(false);
    expect(
      outside((r) => ((r.lookup!.coordinate as { gameFamily: string }).gameFamily = 'stud'))
    ).toBe(false);
    expect(
      outside((r) => ((r.lookup!.coordinate as { anteType: string }).anteType = 'button'))
    ).toBe(false);
    expect(
      outside(
        (r) => ((r.lookup!.policy as { fallbackReason: string }).fallbackReason = 'unknown_reason')
      )
    ).toBe(false);
    expect(outside((r) => ((r.lookup!.policy as { source: string }).source = 'solver'))).toBe(
      false
    );
  });

  it('the validator refuses a receipt whose cell was not built from its own coordinate', () => {
    const valid = receiptFor(baseInput());
    expect(horsePhase6AttributionIsValid(valid)).toBe(true);
    const c = valid.lookup!.coordinate,
      p = valid.lookup!.policy;
    expect(p.cell).toBe(
      tournamentPreflopCell({
        gameFamily: c.gameFamily,
        source: p.source,
        tableSize: c.tableSize,
        validCoordinate: tournamentCoordinateIsValid(c.tableSize, c.heroPosition, c.raiserPosition),
        heroPosition: c.heroPosition,
        raiserPosition: c.raiserPosition,
        anteType: c.anteType,
        branch: c.branch,
        depth: interpolateTournamentDepth(c.stackBB),
        velocityUrgency: tournamentVelocityUrgency(c.mVelocityMPerMinute),
      })
    );
    const mutated = (mutate: (receipt: HorsePhase6Attribution) => void) => {
      const copy = structuredClone(valid);
      mutate(copy);
      return horsePhase6AttributionIsValid(copy);
    };
    // Each coordinate axis moved while the cell stays: refused, because the rebuilt cell
    // no longer equals the declared one.
    expect(mutated((r) => (r.lookup!.coordinate.heroPosition = 'CO'))).toBe(false);
    expect(mutated((r) => (r.lookup!.coordinate.raiserPosition = 'UTG'))).toBe(false);
    expect(mutated((r) => (r.lookup!.coordinate.anteType = 'none'))).toBe(false);
    expect(mutated((r) => (r.lookup!.coordinate.stackBB = 23))).toBe(false);
    expect(mutated((r) => (r.lookup!.coordinate.mVelocityMPerMinute = 0.5))).toBe(false);
    expect(mutated((r) => (r.lookup!.coordinate.tableSize = 7))).toBe(false);
    expect(
      mutated(
        (r) => (r.lookup!.policy.cell = r.lookup!.policy.cell.replace('cold_call', 'squeeze'))
      )
    ).toBe(false);
    // A fallback receipt with nonzero shifts is refused; a baseline receipt whose fallback
    // reason is out of precedence order is refused.
    expect(
      mutated((r) => {
        r.lookup!.coordinate.contextStatus = 'stale';
        r.lookup!.policy.source = 'labeled_fallback';
        r.lookup!.policy.fallbackReason = 'incomplete_context';
        r.status = 'unavailable';
        r.reason = 'incomplete_context';
      })
    ).toBe(false);
    expect(
      mutated((r) => (r.lookup!.policy.fallbackReason = TOURNAMENT_FALLBACK_PRECEDENCE[1]))
    ).toBe(false);
  });

  it('keeps the exported domain arrays identical to the descriptor fields the consumers read', () => {
    expect(DOMAIN.anteTypes).toBe(TOURNAMENT_ANTE_TYPES);
    expect(DOMAIN.gameFamilies).toBe(TOURNAMENT_GAME_FAMILIES);
    expect(DOMAIN.fallbackPrecedence).toBe(TOURNAMENT_FALLBACK_PRECEDENCE);
    expect([...DOMAIN.contextStatuses.baseline, ...DOMAIN.contextStatuses.fallback].sort()).toEqual(
      [...TOURNAMENT_CONTEXT_STATUSES].sort()
    );
  });
});

class FakeWorker extends EventEmitter {
  sent: unknown[] = [];
  postMessage(value: unknown) {
    this.sent.push(value);
  }
  terminate() {
    return Promise.resolve(0);
  }
}
const ready = {
  type: 'READY',
  solverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
  solverPolicyArtifact: { totalPolicies: 0 },
  governor: {
    enabled: false,
    scale: 1,
    p50Ms: 0,
    p99Ms: 0,
    sampledAt: 0,
    throttledForS: 0,
    stale: true,
    timerLateMs: 0,
  },
};

function capture() {
  const f = fixture(7, 3),
    s = withPhase6Provenance(request(f));
  seedFastRandom(901_791);
  const decision = HorseLogic.decide(s.player, s.gameState, 'balanced', {}, f.opts);
  return { s, decision };
}

/** The same producer, asked about a different coordinate: a self-consistent receipt that
 * belongs to another seat, size, depth, branch, family, ante or context. */
function receiptFromCoordinate(
  decision: HorseDecision,
  overrides: Partial<TournamentPreflopPolicyInput>
): HorseDecision {
  const copy = structuredClone(decision);
  const receipt = copy.tournamentPreflopAttribution!;
  const { mVelocityMPerMinute, ...declared } = receipt.lookup!.coordinate;
  const input: TournamentPreflopPolicyInput = {
    ...declared,
    ...overrides,
    m:
      overrides.m ??
      ({ velocityMPerMinute: mVelocityMPerMinute } as TournamentPreflopPolicyInput['m']),
  };
  const policy = tournamentPreflopPolicy(input);
  receipt.lookup = observePhase6Lookup(input, policy);
  receipt.status = policy.source === 'deterministic_baseline' ? 'atlas_evaluated' : 'unavailable';
  receipt.reason = policy.fallbackReason ?? 'atlas_forwarded';
  return copy;
}

describe('Phase 6B mismatch refusal names its reason', () => {
  const { s, decision } = capture();
  const original = decision.tournamentPreflopAttribution!;

  it('the untouched receipt matches its snapshot with no reason', () => {
    expect(original.version).toBe('horse-phase6-attribution-v2');
    expect(original.lookup!.coordinate).toMatchObject({
      tableSize: 3,
      heroPosition: 'BTN',
      raiserPosition: null,
      anteType: 'none',
      branch: 'unopened',
      stackBB: 7,
      gameFamily: 'nlh',
      contextStatus: 'complete',
    });
    expect(horsePhase6AttributionMismatch(decision, s)).toBeNull();
    expect(horsePhase6AttributionMatchesSnapshot(decision, s)).toBe(true);
  });

  const rows: ReadonlyArray<
    [
      axis: string,
      overrides: Partial<TournamentPreflopPolicyInput>,
      reason: Phase6AttributionMismatch,
    ]
  > = [
    ['tableSize', { tableSize: 4 }, 'coordinate_table_size'],
    ['heroPosition', { heroPosition: 'SB' }, 'coordinate_hero_position'],
    ['raiserPosition', { raiserPosition: 'BB' }, 'coordinate_raiser_position'],
    ['stackBB', { stackBB: 8 }, 'coordinate_stack_bb'],
    ['branch', { branch: 'limp_facing' }, 'coordinate_branch'],
    ['gameFamily', { gameFamily: 'other' }, 'coordinate_game_family'],
    ['anteType', { anteType: 'per_player' }, 'coordinate_ante_type'],
    ['contextStatus', { contextStatus: 'warming' }, 'context_status'],
    [
      'mVelocityMPerMinute',
      { m: { ...s.gameState.tournament!.m!, velocityMPerMinute: 1 } },
      'm_velocity',
    ],
  ];

  it.each(rows)(
    'a self-consistent receipt for a different %s is refused as %s',
    (_axis, overrides, reason) => {
      const other = receiptFromCoordinate(decision, overrides);
      // The receipt itself is valid: the refusal is the coordinate disagreement alone.
      expect(horsePhase6AttributionIsValid(other.tournamentPreflopAttribution)).toBe(true);
      expect(horsePhase6AttributionMismatch(other, s)).toBe(reason);
      expect(horsePhase6AttributionMatchesSnapshot(other, s)).toBe(false);
    }
  );

  it('names structural refusals distinctly from coordinate refusals', () => {
    const cell = structuredClone(decision);
    cell.tournamentPreflopAttribution!.lookup!.policy.cell += ':wrong';
    expect(horsePhase6AttributionMismatch(cell, s)).toBe('receipt_invalid');

    const transition = structuredClone(decision);
    transition.policyGraph!.transitions[0].after.action =
      transition.policyGraph!.transitions[0].after.action === 'fold' ? 'call' : 'fold';
    expect(horsePhase6AttributionMismatch(transition, s)).toBe('reference_transition');

    const fallback = structuredClone(decision);
    fallback.policyFallback = 'brain_exception';
    expect(horsePhase6AttributionMismatch(fallback, s)).toBe('fallback_lineage');

    const missing = structuredClone(decision);
    delete missing.tournamentPreflopAttribution;
    expect(horsePhase6AttributionMismatch(missing, s)).toBe('attribution_missing');

    const legacy = structuredClone(decision);
    legacy.tournamentPreflopAttribution = {
      ...legacy.tournamentPreflopAttribution!,
      version: 'horse-phase6-attribution-v1',
      inputSource: {
        basis: 'provided_decision_snapshot',
        stateSchemaVersion: 1,
        tournamentSchemaVersion: 1,
        tournamentMode: true,
      },
    };
    expect(horsePhase6AttributionMismatch(legacy, s)).toBe('version_provenance');
  });

  it.each([
    ['heroPosition', { heroPosition: 'SB' }, 'coordinate_hero_position'],
    ['stackBB', { stackBB: 8 }, 'coordinate_stack_bb'],
    ['anteType', { anteType: 'per_player' }, 'coordinate_ante_type'],
  ] as const)(
    'the live worker client refuses a returned receipt from a different %s and names the reason',
    async (_axis, overrides, reason) => {
      const worker = new FakeWorker();
      const client = new LiveHorseDecisionWorkerClient({
        workerFactory: () => worker as never,
      });
      worker.emit('message', ready);
      const pending = client.decideFast(s);
      void pending.catch(() => undefined);
      worker.emit('message', {
        type: 'FAST_RESULT',
        requestId: 1,
        planBinding: horsePlanBatchBindingFromRequest({ ...s, requestId: 1 }),
        planIssueDisposition: 'no_effects',
        generation: s.generation,
        fence: s.fence,
        decision: receiptFromCoordinate(decision, overrides),
        rngBefore: 11,
        rngAfter: 22,
        computeMs: 1,
        governorScale: 1,
        effects: [],
      });
      await expect(pending).rejects.toThrow(`invalid policy receipt: ${reason}`);
      expect(client.status().phase).toBe('failed');
      await client.stop();
    }
  );

  it('the live worker client accepts the matching receipt on the same request', async () => {
    const worker = new FakeWorker();
    const client = new LiveHorseDecisionWorkerClient({
      workerFactory: () => worker as never,
    });
    worker.emit('message', ready);
    const pending = client.decideFast(s);
    worker.emit('message', {
      type: 'FAST_RESULT',
      requestId: 1,
      planBinding: horsePlanBatchBindingFromRequest({ ...s, requestId: 1 }),
      planIssueDisposition: 'no_effects',
      generation: s.generation,
      fence: s.fence,
      decision: structuredClone(decision),
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 1,
      governorScale: 1,
      effects: [],
    });
    const result = await pending;
    expect(result.decision.executionWitness!.phase6Attribution).toEqual(original);
    const stopping = client.stop();
    worker.emit('message', { type: 'STOPPED' });
    await stopping;
  });
});
