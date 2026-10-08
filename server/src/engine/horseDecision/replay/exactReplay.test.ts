/**
 * P15-A step 4: exact historical replay in a fresh process.
 *
 * The originals here are made by the production worker runtime and HorseLogic
 * on natural journaled requests (the Phase 6C sample), journaled exactly as
 * the worker journals them, and then replayed from the record alone.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic } from '../../HorseLogic.js';
import { HorseMind } from '../../HorseMind.js';
import { equityGovernor } from '../../EquityLoadGovernor.js';
import { restoreFastRandom, saveFastRandom } from '../../HorseEval.js';
import { enableBrainTelemetry } from '../../BrainTelemetry.js';
import { liveHorsePhase8Safety } from '../../HorsePhase8Safety.js';
import { prepareTournamentFutureHandFacts } from '../../HorseTournamentFutureHand.js';
import { solverPolicyArtifactStatus } from '../../../gto/SolverPolicyArtifactLoader.js';
import {
  journalHash,
  makeHorseJournalRecord,
  type HorseJournalRecord,
} from '../../../services/horseDecisionJournal/record.js';
import type {
  FastHorseDecisionRequest,
  FastHorseDecisionResult,
  HorseDecisionWorkerResponse,
} from '../protocol.js';
import {
  HorseDecisionWorkerRuntime,
  type HorseDecisionWorkerDependencies,
} from '../workerRuntime.js';
import {
  HORSE_DECISION_REPLAY_STATE_V1,
  HORSE_DECISION_REPLAY_STATE_VERSION,
} from '../replayState.js';
import {
  HORSE_PLAN_ACCEPTANCE_VERSION,
  createHorsePlanEffectReceipt,
} from '../../HorsePlanEffectReceipt.js';
import { horsePlanContextKey, type HorsePlanBatchBinding } from '../../HorsePlanHandIdentity.js';
import { currentReplaySolverStores } from './references.js';
import {
  exactReplayHorseDecisionRecord,
  firstHorseReplayDifference,
  type HorseExactReplayVerdict,
} from './exactReplay.js';
import {
  PHASE6C_FIXTURE_IDS as IDS,
  phase6cFixtureBody,
  phase6cFixtureRecord,
  resignHorseJournalRecord,
} from './fixtures/index.js';

const SOURCE = '5'.repeat(40);
const OTHER_SOURCE = '6'.repeat(40);
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, '../../../../scripts/phase15-exact-replay.mjs');

const readiness = () => {
  const { identity, charts, postflop, postflopV31, postflopV31Dataset } =
    currentReplaySolverStores();
  return {
    solverStores: { charts, postflop, postflopV31, postflopV31Dataset },
    solverStoreIdentity: identity,
    solverPolicyArtifact: solverPolicyArtifactStatus(),
    governor: equityGovernor.snapshot(),
  };
};

const turnKey = (r: FastHorseDecisionRequest) =>
  journalHash(
    JSON.stringify([r.generation, r.fence, r.requestId, r.decisionKey, r.decisionTimeMs])
  );

/** One live FAST decision through the production runtime, journaled as the worker journals it. */
async function liveOriginal(fixtureId: string, source = SOURCE) {
  const request = phase6cFixtureBody<{ snapshot: FastHorseDecisionRequest }>(
    phase6cFixtureRecord(fixtureId)
  ).snapshot;
  const payloads: unknown[] = [];
  const decideOpts: Record<string, unknown>[] = [];
  const messages: HorseDecisionWorkerResponse[] = [];
  const deps: HorseDecisionWorkerDependencies = {
    journalEnabled: () => true,
    journalDecision: (_snapshot, payload) => {
      payloads.push(payload);
    },
    async startServices() {
      prepareTournamentFutureHandFacts();
      return readiness();
    },
    async stopServices() {},
    decide: (player, gameState, style, mods, opts) => {
      decideOpts.push({ ...opts });
      return HorseLogic.decide(player, gameState, style, mods, opts);
    },
    decideDiscard: HorseLogic.decideDiscard.bind(HorseLogic),
    captureDecisionEffects: (fn) => HorseMind.captureDecisionEffects(fn),
    applyDecisionEffects: () => {},
    saveRng: saveFastRandom,
    restoreRng: restoreFastRandom,
    governorScale: () => equityGovernor.current(),
    atGovernorScale: (fn) => equityGovernor.withDecisionScale(fn),
    workerReadiness: readiness,
    phase8SafetyDisabledReason: () => liveHorsePhase8Safety.disabledReason,
    observeCompletedHand: () => {},
    noteDecision: () => {},
    noteFeature: () => {},
    now: () => performance.now(),
  };
  enableBrainTelemetry();
  const runtime = new HorseDecisionWorkerRuntime((m) => messages.push(m), deps);
  await runtime.start();
  runtime.receive(request);
  await runtime.drain();
  const result = messages.find((m): m is FastHorseDecisionResult => m.type === 'FAST_RESULT');
  if (!result || payloads.length !== 1)
    throw new Error('the live runtime made no journaled decision');
  const record = makeHorseJournalRecord(
    {
      producerId: randomUUID(),
      sequence: 1,
      atMs: Math.trunc(request.decisionTimeMs),
      sourceRelease: source,
      kind: 'decision',
      handKey: journalHash(`hand:${request.decisionKey}`),
      turnKey: turnKey(request),
    },
    payloads[0]
  );
  // The acceptance evidence the journal holds for the same turn: the execution witness.
  const execution = makeHorseJournalRecord(
    {
      producerId: record.producerId,
      sequence: 2,
      atMs: record.atMs + 1,
      sourceRelease: source,
      kind: 'execution',
      handKey: record.handKey,
      turnKey: record.turnKey,
    },
    {
      version: 'horse-execution-witness-v4',
      identity: { decisionKey: request.decisionKey, requestId: request.requestId },
      selected: { action: result.decision.action, amount: result.decision.amount ?? null },
      executionStatus: 'intended',
      executedAction: result.decision.action,
      executedAmount: result.decision.amount ?? null,
      acceptedActions: [],
    }
  );
  return { request, record, execution, result, decideOpts };
}

function freshProcess(
  input: unknown,
  runningSource: string
): HorseExactReplayVerdict & {
  isolation: { pid: number; networkAttempts: { fetch: number; socket: number } };
} {
  const run = spawnSync(process.execPath, [SCRIPT, '--child', '--running-source', runningSource], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      TZ: 'UTC',
      SUPABASE_URL: 'https://supabase.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'phase15-exact-replay-offline-placeholder',
    },
    timeout: 120_000,
  });
  if (run.status !== 0) throw new Error(`fresh replay failed: ${run.stderr}`);
  return JSON.parse(run.stdout.trim().split('\n').pop()!);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P15-A exact historical replay', () => {
  it('journals the worker-owned state the decision read: admitted owners and the Phase 8 sentinel', async () => {
    const parked = liveHorsePhase8Safety.disabledReason;
    liveHorsePhase8Safety.disabledReason = 'eligible_but_silent';
    try {
      const { record, decideOpts } = await liveOriginal(IDS.cashNlhPreflop);
      const body = JSON.parse(record.body);
      expect(body.replayState).toEqual({
        version: HORSE_DECISION_REPLAY_STATE_VERSION,
        admission: {
          phase8Postflop: decideOpts[0].phase8Postflop,
          phase10Plo4: decideOpts[0].phase10Plo4,
          phase11Omaha: decideOpts[0].phase11Omaha,
          phase12Remaining: decideOpts[0].phase12Remaining,
          phase13Joint: decideOpts[0].phase13Joint,
        },
        phase8SafetyDisabledReason: 'eligible_but_silent',
        runtime: { node: process.version, v8: process.versions.v8, arch: process.arch },
      });
    } finally {
      liveHorsePhase8Safety.disabledReason = parked;
    }
  });

  it('replays an original exactly in a fresh process, then joins its acceptance', async () => {
    const { record, execution, result } = await liveOriginal(IDS.cashNlhPreflop);
    const verdict = freshProcess({ record, execution }, SOURCE);
    expect(verdict.outcome, verdict.firstDifference ?? '').toBe('replayed_exact');
    expect(verdict.replayVerified).toBe(true);
    expect(verdict.firstDifference).toBeNull();
    expect(verdict.recordedSource).toBe(SOURCE);
    expect(verdict.runningSource).toBe(SOURCE);
    expect(verdict.replayed).toEqual(verdict.original);
    expect(verdict.original).toMatchObject({
      action: result.decision.action,
      rngAfter: result.rngAfter,
      effects: result.effects.length,
    });
    expect(verdict.acceptance).toMatchObject({
      source: 'journal_execution_witness',
      durableEffectReceipt: 'no_effects',
      status: 'joined',
      executionStatus: 'intended',
      selectedEqualsDecision: true,
    });
    // A new process, and it never reached a database, a table or the network.
    expect(verdict.isolation.pid).not.toBe(process.pid);
    expect(verdict.isolation.networkAttempts).toEqual({ fetch: 0, socket: 0 });
  }, 180_000);

  it('replays a tournament original exactly in a fresh process whose own mind holds nothing', async () => {
    // The receipt carries the read frame digest; the replay re-encodes the
    // frame from the view it decided in, not from the child's empty HorseMind.
    const { record, execution } = await liveOriginal(IDS.tournamentAtlasEvaluated);
    expect(JSON.parse(record.body).decision.tournamentUtility?.readFrameSha256).toMatch(
      /^[0-9a-f]{64}$/
    );
    const verdict = freshProcess({ record, execution }, SOURCE);
    expect(verdict.outcome, verdict.firstDifference ?? '').toBe('replayed_exact');
    expect(verdict.isolation.networkAttempts).toEqual({ fetch: 0, socket: 0 });
  }, 180_000);

  it('refuses by name in a fresh process when the running source is not the source that decided', async () => {
    const { record, execution } = await liveOriginal(IDS.cashNlhPreflop);
    const verdict = freshProcess({ record, execution }, OTHER_SOURCE);
    expect(verdict.outcome).toBe('non_replayable:original_source');
    expect(verdict.replayVerified).toBe(false);
    expect(verdict.replayed).toBeNull();
  }, 180_000);

  it('replays a tournament original exactly in process and is deterministic', async () => {
    const { record } = await liveOriginal(IDS.tournamentAtlasEvaluated);
    const first = await exactReplayHorseDecisionRecord(record, { runningSource: SOURCE });
    expect(first.outcome, first.firstDifference ?? '').toBe('replayed_exact');
    const second = await exactReplayHorseDecisionRecord(record, { runningSource: SOURCE });
    expect(second).toEqual(first);
    expect(first.acceptance).toMatchObject({
      status: 'not_joined',
      reason: 'no_acceptance_source',
    });
  });

  it('names the first differing field when a single input is perturbed', async () => {
    const { record } = await liveOriginal(IDS.cashNlhRiver);
    const scale = JSON.parse(record.body).governorScale as number;
    const perturbed = resignHorseJournalRecord(record, (body) => {
      body.governorScale = scale === 1 ? 0.25 : 1;
    });
    const verdict = await exactReplayHorseDecisionRecord(perturbed, { runningSource: SOURCE });
    expect(verdict.outcome).toBe('replayed_mismatch');
    expect(verdict.replayVerified).toBe(false);
    expect(verdict.firstDifference).toMatch(/^(decision\.|rng_after$|effects)/);

    const rng = resignHorseJournalRecord(record, (body) => {
      body.rngAfter = ((body.rngAfter as number) ^ 0x5a5a5a5a) >>> 0;
    });
    const rngVerdict = await exactReplayHorseDecisionRecord(rng, { runningSource: SOURCE });
    expect(rngVerdict).toMatchObject({
      outcome: 'replayed_mismatch',
      firstDifference: 'rng_after',
    });

    const effects = resignHorseJournalRecord(record, (body) => {
      body.planBinding = { ...(body.planBinding as object), generation: -1 };
    });
    const bindingVerdict = await exactReplayHorseDecisionRecord(effects, { runningSource: SOURCE });
    expect(bindingVerdict).toMatchObject({
      outcome: 'replayed_mismatch',
      firstDifference: 'plan_binding.generation',
    });
  });

  it('marks a record non-replayable by the missing input and never substitutes it', async () => {
    const { record } = await liveOriginal(IDS.cashNlhPreflop);
    const without = (field: string) =>
      resignHorseJournalRecord(record, (body) => {
        delete body[field];
      });
    const outcome = async (r: HorseJournalRecord) =>
      (await exactReplayHorseDecisionRecord(r, { runningSource: SOURCE })).outcome;
    expect(await outcome(without('replayState'))).toBe('non_replayable:replay_state');
    expect(await outcome(without('readFrame'))).toBe('non_replayable:read_frame');
    expect(await outcome(without('rngBefore'))).toBe('non_replayable:rng');
    expect(await outcome(without('governorScale'))).toBe('non_replayable:governor');
    expect(await outcome(without('effects'))).toBe('non_replayable:effects');
    expect(await outcome(without('planBinding'))).toBe('non_replayable:plan_binding');
    // Authority this process cannot hold is a missing input, not a default.
    const candidate = resignHorseJournalRecord(record, (body) => {
      (body.replayState as { admission: Record<string, string> }).admission.phase10Plo4 =
        'candidate';
    });
    expect(await outcome(candidate)).toBe('non_replayable:admission:phase10Plo4');
    // Another JavaScript runtime is not the original artifact: refused by name.
    for (const runtime of [
      { node: 'v22.23.2', v8: '12.4.254.21-node.56', arch: process.arch },
      {
        node: process.version,
        v8: process.versions.v8,
        arch: process.arch === 'x64' ? 'arm64' : 'x64',
      },
    ]) {
      const other = resignHorseJournalRecord(record, (body) => {
        (body.replayState as { runtime: unknown }).runtime = runtime;
      });
      const verdict = await exactReplayHorseDecisionRecord(other, { runningSource: SOURCE });
      expect(verdict.outcome).toBe('non_replayable:original_runtime');
      expect(verdict.recordedRuntime).toEqual(runtime);
      expect(verdict.replayed).toBeNull();
    }
    // A v1 state (journaled before the runtime identity) names no runtime.
    const v1 = resignHorseJournalRecord(record, (body) => {
      const state = body.replayState as Record<string, unknown>;
      state.version = HORSE_DECISION_REPLAY_STATE_V1;
      delete state.runtime;
    });
    expect(await outcome(v1)).toBe('non_replayable:runtime_identity');
    // A record that does not name its source cannot be matched to one.
    const unnamed = makeHorseJournalRecord(
      {
        producerId: record.producerId,
        sequence: record.sequence,
        atMs: record.atMs,
        sourceRelease: null,
        kind: record.kind,
        handKey: record.handKey,
        turnKey: record.turnKey,
      },
      JSON.parse(record.body)
    );
    expect(await outcome(unnamed)).toBe('non_replayable:source_release');
    expect(await outcome({ ...record, body: `${record.body} ` })).toBe('non_replayable:record');
    // Natural records journaled before this capture existed stay non-replayable.
    const legacy = phase6cFixtureRecord(IDS.cashNlhPreflop);
    expect(
      (await exactReplayHorseDecisionRecord(legacy, { runningSource: legacy.sourceRelease! }))
        .outcome
    ).toBe('non_replayable:replay_state');
    const deep = phase6cFixtureRecord(IDS.deepSecondLook);
    expect(
      (await exactReplayHorseDecisionRecord(deep, { runningSource: deep.sourceRelease! })).outcome
    ).toBe('non_replayable:retained_fast_read_view');
    expect(
      (
        await exactReplayHorseDecisionRecord(deep, {
          runningSource: deep.sourceRelease!,
          planReceipt: null,
        })
      ).acceptance.durableEffectReceipt
    ).toBe('no_effects');
  });

  it('refuses an artifact the decision consulted when this process does not hold it', async () => {
    const { record } = await liveOriginal(IDS.tournamentChartOpenJam);
    const chartless = resignHorseJournalRecord(record, (body) => {
      const r = body.readiness as {
        solverStores: { charts: number };
        solverStoreIdentity?: unknown;
      };
      r.solverStores.charts = 240;
      delete r.solverStoreIdentity;
    });
    const verdict = await exactReplayHorseDecisionRecord(chartless, { runningSource: SOURCE });
    expect(verdict.outcome).toMatch(/^non_replayable:artifact:/);
  });

  it('leaves every live path untouched: no plan application, no network, mind and clocks restored', async () => {
    const { record, request } = await liveOriginal(IDS.cashNlhRiver);
    const apply = vi.spyOn(HorseMind, 'applyDecisionEffects');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const reads = () =>
      JSON.stringify(HorseMind.snapshotDecisionReads(request.gameState.players, null));
    const before = reads();
    const parked = liveHorsePhase8Safety.disabledReason;
    liveHorsePhase8Safety.disabledReason = 'unrelated_live_state';
    try {
      const verdict = await exactReplayHorseDecisionRecord(record, { runningSource: SOURCE });
      expect(verdict.outcome, verdict.firstDifference ?? '').toBe('replayed_exact');
      expect(liveHorsePhase8Safety.disabledReason).toBe('unrelated_live_state');
    } finally {
      liveHorsePhase8Safety.disabledReason = parked;
    }
    expect(apply).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reads()).toBe(before);
    expect(Date.now()).toBeGreaterThan(request.decisionTimeMs);
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 5));
    expect(performance.now()).toBeGreaterThan(t0);
  });

  it('joins the durable plan receipt of exactly the issued batch, and nothing else', async () => {
    // A river decision whose record issued one plan effect, with the receipt
    // the worker writes for that batch on the same journal turn.
    const { record } = await liveOriginal(IDS.cashNlhRiver);
    const body = JSON.parse(record.body) as { planBinding: HorsePlanBatchBinding };
    const binding = body.planBinding;
    const handKey = horsePlanContextKey(binding.planContext);
    expect(handKey).not.toBeNull();
    const effects = [
      { type: 'plan', handKey: handKey!, userId: binding.actorId, barrelIntent: true },
    ];
    const issued = resignHorseJournalRecord(record, (b) => {
      b.effects = effects;
    });
    const receiptRecord = (fx: typeof effects, disposition: 'applied' | 'failed') =>
      makeHorseJournalRecord(
        {
          producerId: record.producerId,
          sequence: 3,
          atMs: record.atMs + 2,
          sourceRelease: SOURCE,
          kind: 'plan_receipt',
          handKey: record.handKey,
          turnKey: record.turnKey,
        },
        createHorsePlanEffectReceipt({
          binding,
          effects: fx as never,
          issuedAction: { action: 'bet', amount: 4 },
          acceptance: {
            version: HORSE_PLAN_ACCEPTANCE_VERSION,
            action: 'bet',
            amount: 4,
            witness: { requestId: binding.fastRequestId, decisionKey: binding.decisionKey },
          },
          policy: { graph: null, candidates: [] },
          sourceRelease: SOURCE,
          workerEpoch: randomUUID(),
          disposition,
        })
      );
    const receiptOf = async (planReceipt: unknown) =>
      (await exactReplayHorseDecisionRecord(issued, { runningSource: SOURCE, planReceipt }))
        .acceptance.durableEffectReceipt;
    expect(await receiptOf(receiptRecord(effects, 'applied'))).toBe('applied');
    expect(await receiptOf(receiptRecord(effects, 'failed'))).toBe('failed');
    expect(
      await receiptOf(receiptRecord([{ ...effects[0], barrelIntent: false }], 'applied'))
    ).toBe('other_batch');
    expect(await receiptOf(null)).toBe('absent');
    expect(await receiptOf(undefined)).toBe('no_receipt_source');
    const forged = receiptRecord(effects, 'applied');
    expect(await receiptOf({ ...forged, body: forged.body.replace('applied', 'failed') })).toBe(
      'invalid'
    );
    // A receipt never makes a replay exact: the effects this record claims are
    // not the ones the decision issues, and the comparison says so first.
    const verdict = await exactReplayHorseDecisionRecord(issued, {
      runningSource: SOURCE,
      planReceipt: receiptRecord(effects, 'applied'),
    });
    expect(verdict.outcome).toBe('replayed_mismatch');
    expect(verdict.firstDifference).toMatch(/^effects/);
  });

  it('compares portable values field by field with the action first', () => {
    expect(
      firstHorseReplayDifference({ a: 1, action: 'call' }, { a: 2, action: 'fold' }, 'd')
    ).toBe('d.action');
    expect(firstHorseReplayDifference([1, 2], [1, 2, 3], 'e')).toBe('e.length');
    expect(firstHorseReplayDifference({ x: { y: [1] } }, { x: { y: [1] } }, 'd')).toBeNull();
    expect(firstHorseReplayDifference({ x: 1 }, { x: 1, z: 2 }, 'd')).toBe('d.z');
  });
});
