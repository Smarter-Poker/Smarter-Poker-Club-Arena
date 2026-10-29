import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'unit-test-placeholder-key');
});

afterAll(() => vi.unstubAllEnvs());
import * as recordsApi from '../../server/src/services/horseDecisionJournal/record';
import * as bindingApi from '../../server/src/engine/HorseDecisionHandBinding';
import * as reviewApi from '../../server/src/services/horseDecisionJournal/review';
import * as effectsApi from '../../server/src/services/horseDecisionJournal/effects';
import * as planApi from '../../server/src/engine/HorseDecisionEffects';
import { headsUpCashCommitment } from '../../server/src/engine/HorseHeadsUpCommitment';
import { HorseFleetPhaseInterpreter } from '../../server/src/services/horseDecisionJournal/phaseProof';
import { decisionRequest } from '../../server/src/testing/horseRegression/plan/fixture';
import { jointPolicyFixture } from '../../server/src/engine/multiway/JointRangeFixture.test-support';
import { HorseLogic } from '../../server/src/engine/HorseLogic';
import { HorseMind } from '../../server/src/engine/HorseMind';
import {
  seedFastRandom,
  saveFastRandom,
  restoreFastRandom,
} from '../../server/src/engine/HorseEval';
import { encodeHorseDecisionReads } from '../../server/src/engine/HorseDecisionReadFrame';
import {
  horsePlanContextFromDecision,
  horsePlanBatchBindingFromRequest,
} from '../../server/src/engine/HorsePlanHandIdentity';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
  expectedHorseExecutionAmount,
} from '../../server/src/engine/HorseExecutionWitness';
import { buildHorseDecisionKey } from '../../server/src/engine/horseDecision/protocol';
// Fixed control helper is JavaScript because the host executes these exact bytes.
// @ts-expect-error This maintained .mjs has no generated declaration.
import { inspectDecision8464Records } from '../../scripts/ci/horse-tournament-predicate-proof.mjs';

const script = resolve(__dirname, '../../scripts/ci/inspect-tournament-refill.py');
const api = {
  ...recordsApi,
  ...bindingApi,
  ...reviewApi,
  ...effectsApi,
  ...planApi,
  headsUpCashCommitment,
  HorseFleetPhaseInterpreter,
};
const source = 'a'.repeat(40),
  handId = '32345678-abcd-4321-abcd-123456789abc';
function python(mode: string, value: unknown) {
  return spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `import json,runpy,sys; m=runpy.run_path(sys.argv[1]); v=json.load(sys.stdin); print(json.dumps(m['${mode}'](*v)))`,
      script,
    ],
    { input: JSON.stringify(value), encoding: 'utf8', timeout: 5000 }
  );
}
function fixture(probe: 'matched_risk' | 'phase7_allocated' = 'matched_risk') {
  const snapshot = decisionRequest();
  if (probe === 'matched_risk') {
    const p = snapshot.player,
      g = snapshot.gameState;
    Object.assign(p, {
      stack: 1000,
      bet: 0,
      totalInvested: 10,
      cards: [
        { rank: 'A', suit: 'clubs' },
        { rank: 'Q', suit: 'diamonds' },
      ],
    });
    Object.assign(g, {
      pot: 40,
      contestablePot: 40,
      currentBet: 20,
      minRaise: 20,
      lastRaise: 20,
      toCall: 20,
      legalActions: ['fold', 'call', 'raise', 'all_in'],
      minRaiseTo: 40,
      maxRaiseTo: 1000,
      communityCards: [
        { rank: 'Q', suit: 'spades' },
        { rank: '8', suit: 'hearts' },
        { rank: '3', suit: 'diamonds' },
      ],
      players: [
        { ...p, cards: [] },
        { ...g.players[1], stack: 15, bet: 20, totalInvested: 30 },
      ],
      actionHistory: [
        { stage: 'flop', seat: 1, userId: p.user_id, action: 'check', amount: 0, timestamp: 1 },
        {
          stage: 'flop',
          seat: 2,
          userId: g.players[1].user_id,
          action: 'bet',
          amount: 20,
          timestamp: 2,
        },
      ],
    });
  } else {
    const f = JSON.parse(
      JSON.stringify(jointPolicyFixture('nlh', 1, 'tournament', 'preflop')),
      (_k, v) =>
        typeof v === 'string' && /^p[0-9]$/.test(v)
          ? `20000000-0000-4000-8000-00000000000${Number(v.slice(1)) + 1}`
          : v
    );
    Object.assign(f.state, {
      toCall: 0,
      legalActions: ['check'],
      minRaiseTo: null,
      maxRaiseTo: null,
      actionHistory: snapshot.gameState.actionHistory,
    });
    f.state.tournament.stackByUser = Object.fromEntries(
      f.state.players.map((p: any) => [p.user_id, p.stack + p.totalInvested])
    );
    snapshot.player = f.hero;
    snapshot.gameState = f.state;
  }
  snapshot.gameState.actionHistory = snapshot.gameState.actionHistory!.map((a) => ({
    ...a,
    origin: 'player' as const,
  }));
  snapshot.opts = {
    telemetry: false,
    mind: false,
    v7AdaptiveMC: false,
    v27GtoCharts: false,
    phase8Postflop: 'off',
    phase13Joint: 'off',
    decisionTimeMs: 1000,
  };
  if (probe === 'phase7_allocated') delete snapshot.opts.v7AdaptiveMC;
  snapshot.handJournalContext = bindingApi.captureHorseHandJournalContext(
    snapshot.gameState.actionHistory!
  );
  snapshot.decisionKey = buildHorseDecisionKey(snapshot);
  const before = saveFastRandom();
  let decision;
  try {
    seedFastRandom(probe === 'matched_risk' ? 1 : 7300930);
    decision = HorseLogic.decide(
      snapshot.player,
      snapshot.gameState,
      'balanced',
      {},
      snapshot.opts
    );
  } finally {
    restoreFastRandom(before);
  }
  const context = horsePlanContextFromDecision(snapshot);
  const readFrame = encodeHorseDecisionReads(
    HorseMind.createSandbox(),
    snapshot.gameState.players,
    planApi.horsePlanHandKey(snapshot.gameState.actionHistory, context),
    context
  );
  if (decision.tournamentUtility) decision.tournamentUtility.readFrameSha256 = readFrame.sha256;
  const capture = {
    snapshot,
    decision,
    readFrame,
    effects: [],
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 1,
    governorScale: 1,
    planContext: context,
    planBinding: horsePlanBatchBindingFromRequest(snapshot),
  };
  const witness = createHorseExecutionWitness(snapshot, decision, {
    requestId: snapshot.requestId,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  const action = {
    seat: snapshot.player.seat,
    userId: snapshot.player.user_id,
    stage: snapshot.gameState.stage,
    action: decision.action,
    amount: expectedHorseExecutionAmount(snapshot, decision) ?? 0,
    timestamp: snapshot.decisionTimeMs + 1,
  };
  settleHorseExecutionWitness(witness, {
    applied: true,
    acceptedActions: [{ record: action, intended: true }],
  });
  const ordinal = snapshot.gameState.actionHistory!.length;
  const anchor = bindingApi.anchorHorseDecisionHand(snapshot);
  if (anchor.status !== 'anchored') throw Error('fixture anchor');
  const coordinate = bindingApi.horseHandAnchorKey(anchor),
    handKey = recordsApi.journalHash(coordinate);
  const hand = {
    generation: anchor.handNumber,
    fence: `${anchor.tableId}:${anchor.handNumber}:${anchor.leaseGeneration}:observe`,
    handKey: `${anchor.tableId}:${anchor.handNumber}`,
    committedHandId: handId,
    bigBlind: snapshot.gameState.bigBlind,
    actions: [
      ...snapshot.gameState.actionHistory!,
      {
        ...action,
        origin: 'horse_policy',
        publicNode: {
          version: 1,
          status: 'captured',
          actorSeat: action.seat,
          street: action.stage,
        },
        observationIdentity: {
          version: 1,
          status: 'bound',
          handId,
          actionOrdinal: ordinal,
          observationId: `${handId}:${ordinal}`,
          sessionKey: 'a'.repeat(64),
        },
      },
    ],
  };
  const turnKey = recordsApi.journalHash(
    JSON.stringify([
      snapshot.generation,
      snapshot.fence,
      snapshot.requestId,
      snapshot.decisionKey,
      snapshot.decisionTimeMs,
    ])
  );
  const make = (kind: any, sequence: number, body: unknown) =>
    recordsApi.makeHorseJournalRecord(
      {
        producerId: '40000000-0000-4000-8000-000000000001',
        sequence,
        atMs: 2000,
        sourceRelease: source,
        kind,
        handKey,
        turnKey: kind === 'accepted_hand' ? handKey : turnKey,
      },
      body
    );
  const rows = () => [
    make('decision', 1, capture),
    make('execution', 2, witness),
    make('accepted_hand', 3, hand),
  ];
  const input = {
    version: 4,
    sourceRelease: source,
    probe,
    cases: [
      {
        handKey,
        tableId: anchor.tableId,
        handId,
        handNumber: anchor.handNumber,
        leaseGeneration: anchor.leaseGeneration,
        decisionRecordSha256: null as string | null,
        actionOrdinal: ordinal,
      },
    ],
  };
  const batch = () => ({
    status: 'canonical_journal_export',
    sourceRelease: source,
    recordsByHand: [{ handKey, records: rows() }],
  });
  return { input, batch, capture, witness, hand, rows };
}
afterEach(() => HorseMind.reset());
it('admits only closed bounded v4 metadata without changing old selector contracts', () => {
  const f = fixture();
  const encode = (value: unknown) =>
    spawnSync('python3', ['-B', script, '--encode-reference-cases', source], {
      input: JSON.stringify(value),
      encoding: 'utf8',
      timeout: 5000,
    });
  expect(encode(f.input).status).toBe(0);
  for (const bad of [
    { ...f.input, probe: 'private-command' },
    { ...f.input, version: true },
    { ...f.input, raw: [] },
    { ...f.input, cases: [...f.input.cases, ...f.input.cases] },
    { ...f.input, cases: [{ ...f.input.cases[0], actionOrdinal: -1 }] },
    { ...f.input, cases: [{ ...f.input.cases[0], cards: ['As'] }] },
  ])
    expect(encode(bad).status).toBe(1);
});
it('uses real helper and real original hand reconciliation for a bounded covering raise', () => {
  const f = fixture();
  expect(f.capture.decision).toMatchObject({ action: 'raise', amount: 40 });
  expect(reviewApi.reconcileHorseJournalHand(f.rows(), f.input.cases[0].handKey)).toMatchObject({
    status: 'reconciled',
    gaps: [],
  });
  const result = inspectDecision8464Records(f.input, f.batch(), api);
  expect(result).toMatchObject({
    status: 'observed',
    replayVerified: false,
    causalReplayVerified: false,
    cases: [
      {
        observation: 'accepted_matched_risk_bounded_wager',
        exposure: 35,
        physicalStack: 1000,
        raiseTo: 40,
      },
    ],
  });
  expect(python('sanitize_decision_8464_result', [result, f.input]).status).toBe(0);
  const dispatch = (value: unknown) =>
    spawnSync(
      'python3',
      [
        '-B',
        '-c',
        "import json,runpy,sys; m=runpy.run_path(sys.argv[1]); d=json.load(sys.stdin); g=m['decision_case_diagnostic'].__globals__; g['TOURNAMENT_PREDICATE_JS']='fixed-control'; g['bounded_command']=lambda *a,**k:json.dumps(d['result']); print(json.dumps(m['decision_case_diagnostic'](d['input'])))",
        script,
      ],
      { input: JSON.stringify({ input: f.input, result: value }), encoding: 'utf8', timeout: 5000 }
    );
  const validDispatch = dispatch(result);
  expect(validDispatch.status, validDispatch.stderr).toBe(0);
  expect(JSON.parse(validDispatch.stdout)).toEqual(result);
  const refusedDispatch = dispatch({ ...result, raw: 'private-sentinel' });
  expect(refusedDispatch.status, refusedDispatch.stderr).toBe(0);
  expect(JSON.parse(refusedDispatch.stdout)).toMatchObject({
    status: 'unknown',
    diagnostic: { stage: 'sanitizer', code: 'result_refused' },
  });
  expect(refusedDispatch.stdout).not.toContain('private-sentinel');

  for (const mutate of [
    (v: any) => (v.rawRecordsExported = true),
    (v: any) => (v.cases[0].cards = ['As']),
    (v: any) => (v.cases[0].exposure = 1000),
    (v: any) => v.cases[0].actionOrdinal++,
    (v: any) => (v.causalReplayVerified = true),
  ]) {
    const changed = structuredClone(result);
    mutate(changed);
    expect(python('sanitize_decision_8464_result', [changed, f.input]).status).not.toBe(0);
  }
});
it('runs the actual allocated nonempty Phase7 interpreter with original envelopes', () => {
  const f = fixture('phase7_allocated');
  expect(reviewApi.reconcileHorseJournalHand(f.rows(), f.input.cases[0].handKey)).toMatchObject({
    status: 'reconciled',
    gaps: [],
  });
  expect(
    new HorseFleetPhaseInterpreter(() => {}).interpret(
      f.capture,
      f.witness,
      reviewApi.reviewHorsePlanEffects(f.rows(), f.input.cases[0].handKey)
    ).phase7
  ).toMatchObject({ reason: 'supported_uncalibrated_utility_baseline' });
  const result = inspectDecision8464Records(f.input, f.batch(), api);
  expect(result).toMatchObject({
    status: 'observed',
    cases: [
      {
        allocatedContext: true,
        nonemptyHistory: true,
        allocatedKeyDiffersFromLegacy: true,
        phase7: { reason: 'supported_uncalibrated_utility_baseline', application: 'accepted' },
      },
    ],
  });
  expect(python('sanitize_decision_8464_result', [result, f.input]).status).toBe(0);
});
it('refuses missing ordinals, duplicate envelopes, changed source and coerced acceptance', () => {
  for (const kind of ['ordinal', 'duplicate', 'source', 'coerced']) {
    const f = fixture();
    const batch = f.batch();
    if (kind === 'ordinal') f.input.cases[0].actionOrdinal = 4000;
    if (kind === 'duplicate')
      batch.recordsByHand[0].records.push(batch.recordsByHand[0].records[0]);
    if (kind === 'source') batch.sourceRelease = 'b'.repeat(40);
    if (kind === 'coerced') {
      f.witness.executionStatus = 'coerced';
      batch.recordsByHand[0].records = f.rows();
    }
    expect(inspectDecision8464Records(f.input, batch, api).status, kind).toBe('unknown');
  }
});
it('fails closed for excluded helper domains and invalid or empty allocated context', () => {
  for (const kind of ['bomb', 'multiway', 'callOnly']) {
    const f = fixture();
    if (kind === 'bomb') f.capture.snapshot.gameState.bombPot = true;
    if (kind === 'multiway')
      f.capture.snapshot.gameState.players.push({
        ...f.capture.snapshot.gameState.players[1],
        seat: 3,
      });
    if (kind === 'callOnly') f.capture.snapshot.gameState.legalActions = ['fold', 'call'];
    expect(inspectDecision8464Records(f.input, f.batch(), api).status, kind).toBe('unknown');
  }
  for (const kind of ['invalid', 'empty', 'forged']) {
    const f = fixture('phase7_allocated');
    if (kind === 'invalid')
      (f.capture as any).planContext = { version: 1, hand: { tableId: 'foreign' } };
    if (kind === 'empty') f.capture.snapshot.gameState.actionHistory = [];
    if (kind === 'forged') f.capture.readFrame = { ...f.capture.readFrame, sha256: 'f'.repeat(64) };
    expect(inspectDecision8464Records(f.input, f.batch(), api).status, kind).toBe('unknown');
  }
});
it('generates the exact installed-image adapter without raw export or policy replay', () => {
  const generated = spawnSync('python3', ['-B', script, '--host-script'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(generated.status).toBe(0);
  const source = readFileSync(script, 'utf8');
  expect(generated.stdout).toContain('inspectDecision8464Records');
  expect(source).toContain("diagnostic_js = helper + '\\n' + DECISION_8464_ADAPTER");
  expect(source).not.toContain('exactReplayHorseDecisionRecord');
  expect(createHash('sha256').update(generated.stdout).digest('hex')).toHaveLength(64);
});
it('bounds the new selector and refuses malformed input before installed APIs', () => {
  const f = fixture();
  for (const value of [
    null,
    undefined,
    {},
    { ...f.input, probe: 'secret' },
    { ...f.input, cases: Array(7).fill(f.input.cases[0]) },
    { ...f.input, sourceRelease: 's'.repeat(9000) },
  ]) {
    expect(inspectDecision8464Records(value, null, api)).toMatchObject({
      status: 'unknown',
      reason: 'input_refused',
    });
  }
  const encode = (value: string) =>
    spawnSync('python3', ['-B', script, '--encode-reference-cases', source], {
      input: value,
      encoding: 'utf8',
      timeout: 5000,
    });
  for (const raw of [
    JSON.stringify({ ...f.input, cases: [{ ...f.input.cases[0], actionOrdinal: true }] }),
    JSON.stringify(f.input).replace('"version":4', '"version":4,"version":4'),
    'x'.repeat(8193),
  ]) {
    const result = encode(raw);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  }
  const unknown = {
    version: 4,
    probe: f.input.probe,
    status: 'unknown',
    sourceRelease: source,
    rawRecordsExported: false,
    replayVerified: false,
    causalReplayVerified: false,
    activationAllowed: false,
    cases: [
      { handKey: f.input.cases[0].handKey, status: 'unknown', reason: 'matched_risk_not_observed' },
    ],
  };
  expect(python('sanitize_decision_8464_result', [unknown, f.input]).status).toBe(0);
  expect(
    python('sanitize_decision_8464_result', [
      { ...unknown, cases: [{ ...unknown.cases[0], raw: 'private' }] },
      f.input,
    ]).status
  ).not.toBe(0);
});
it('checks generated child syntax and observes no agreement for a replaced final wager', () => {
  const child = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      "import runpy,sys; m=runpy.run_path(sys.argv[1]); print(open(sys.argv[2]).read()+'\\n'+m['DECISION_8464_ADAPTER'])",
      script,
      resolve(__dirname, '../../scripts/ci/horse-tournament-predicate-proof.mjs'),
    ],
    { encoding: 'utf8', timeout: 5000 }
  );
  expect(child.status).toBe(0);
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: child.stdout,
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(syntax.status, syntax.stderr).toBe(0);
  const f = fixture();
  f.capture.decision.amount = 42;
  const w = f.witness as any;
  w.selected = { ...w.selected, amount: 42 };
  // A changed captured amount must first fail the authoritative original joins,
  // never be rescued by computing the helper's legal raise in the observer.
  expect(inspectDecision8464Records(f.input, f.batch(), api).status).toBe('unknown');
});
it('binds optional exact record digests and refuses a foreign committed hand', () => {
  const f = fixture();
  f.input.cases[0].decisionRecordSha256 = f.rows()[0].sha256;
  expect(inspectDecision8464Records(f.input, f.batch(), api).status).toBe('observed');
  f.input.cases[0].decisionRecordSha256 = 'b'.repeat(64);
  expect(inspectDecision8464Records(f.input, f.batch(), api).cases[0].reason).toBe(
    'matching_decision_missing'
  );
  f.input.cases[0].decisionRecordSha256 = null;
  f.hand.committedHandId = '42345678-abcd-4321-abcd-123456789abc';
  expect(inspectDecision8464Records(f.input, f.batch(), api).cases[0].reason).toBe(
    'accepted_hand_binding_mismatch'
  );
});
