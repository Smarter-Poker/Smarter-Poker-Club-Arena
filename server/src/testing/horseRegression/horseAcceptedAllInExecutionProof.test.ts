import { expect, it, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
// @ts-expect-error standalone maintained host helper
import * as diagnostic from '../../../../scripts/ci/horse-tournament-predicate-proof.mjs';
import * as records from '../../services/horseDecisionJournal/record.js';
import * as binding from '../../engine/HorseDecisionHandBinding.js';
import * as review from '../../services/horseDecisionJournal/review.js';
import * as witness from '../../engine/HorseExecutionWitness.js';
import * as lifecycle from '../../services/horseDecisionJournal/lifecycle.js';
import {
  HorseQualifiedAuthorityHolder,
  HorsePhase8AuthorityGate,
} from '../../engine/HorseQualifiedAuthority.js';
import { qualifiedTestAdmission } from '../../engine/HorseQualifiedAuthority.test-support.js';
import { buildHorseDecisionKey } from '../../engine/horseDecision/protocol.js';
import { jointPolicyFixture } from '../../engine/multiway/JointRangeFixture.test-support.js';
import { encodeHorseDecisionReads } from '../../engine/HorseDecisionReadFrame.js';
import { HorseMind } from '../../engine/HorseMind.js';
import { channelHub } from '../../hub/ChannelHub.js';
const api = { ...records, ...binding, ...review, ...lifecycle };
afterAll(() => channelHub.close());
const table = '12345678-abcd-4321-abcd-123456789abc',
  lease = '22345678-abcd-4321-abcd-123456789abc',
  handId = '32345678-abcd-4321-abcd-123456789abc',
  producer = '42345678-abcd-4321-abcd-123456789abc',
  source = 'a'.repeat(40);
function fixture(
  change?: (x: any) => void,
  stage: 'preflop' | 'flop' | 'turn' | 'river' = 'river'
) {
  const { hero, state }: any = JSON.parse(
    JSON.stringify(jointPolicyFixture('plo5', 1, 'cash', stage)),
    (_k, v) =>
      typeof v === 'string' && /^p[0-9]$/.test(v)
        ? '20000000-0000-4000-8000-00000000000' + (Number(v[1]) + 1)
        : v
  );
  hero.stack = 36.5;
  hero.bet = 0;
  state.players[0].stack = 36.5;
  state.players[0].bet = 0;
  Object.assign(state, {
    pot: 451,
    currentBet: 20,
    toCall: 20,
    legalActions: ['fold', 'call', 'all_in'],
  });
  delete state.contestablePot;
  state.actionHistory = Array.from({ length: 3 }, (_, i) => ({
    seat: 2,
    userId: state.players[1].user_id,
    action: 'check',
    amount: 0,
    stage: 'preflop',
    timestamp: 100 + i,
  }));
  const s: any = {
    type: 'DECIDE_FAST',
    requestId: 9,
    generation: 7,
    fence: `${table}:123:1:${lease}:7`,
    decisionTimeMs: 1000,
    decisionKey: '',
    player: hero,
    gameState: state,
    style: 'balanced',
    opts: {},
    handJournalContext: binding.captureHorseHandJournalContext(state.actionHistory),
  };
  s.decisionKey = buildHorseDecisionKey(s);
  const decision: any = { action: 'raise', amount: 36.5, thinkTime: 0 };
  const capture: any = {
    snapshot: s,
    decision,
    effects: [],
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 1,
    governorScale: 1,
    runtimePins: 'incomplete',
    readFrame: encodeHorseDecisionReads(
      HorseMind.createSandbox(),
      state.players,
      HorseMind.handKeyOf(state.actionHistory)
    ),
  };
  const w = witness.createHorseExecutionWitness(s, decision, {
    requestId: 9,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  const action: any = {
    seat: 1,
    userId: hero.user_id,
    action: 'all_in',
    amount: 36.5,
    timestamp: 1001,
    stage,
  };
  witness.settleHorseExecutionWitness(w, {
    applied: true,
    acceptedActions: [{ record: action, intended: true }],
  });
  const node: any = {
    version: 1,
    status: 'captured',
    mode: 'cash',
    street: stage,
    actorSeat: 1,
    variant: 'plo5',
    currentBet: 20,
    pot: 451,
    toCall: 20,
    seats: state.players.map((p: any) => [p.seat, p.stack, p.bet, p.totalInvested, 0, 0, 0]),
  };
  const hand: any = {
    type: 'OBSERVE_COMPLETED_HAND',
    requestId: 10,
    generation: 123,
    fence: `${table}:123:${lease}:observe`,
    handKey: `${table}:123`,
    committedHandId: handId,
    bigBlind: 2,
    actions: [
      ...state.actionHistory.map((a: any) => ({ ...a, origin: 'player' })),
      {
        ...action,
        origin: 'horse_policy',
        publicNode: node,
        observationIdentity: {
          version: 1,
          status: 'bound',
          handId,
          actionOrdinal: 3,
          observationId: `${handId}:3`,
          sessionKey: 'c'.repeat(64),
        },
      },
    ],
  };
  const handKey = records.journalHash(`${table}:123:${lease}`),
    turnKey = records.journalHash(JSON.stringify([7, s.fence, 9, s.decisionKey, 1000]));
  const input: any = {
    version: 6,
    probe: 'accepted_all_in_execution',
    sourceRelease: source,
    cases: [
      {
        handKey,
        tableId: table,
        handId,
        handNumber: 123,
        leaseGeneration: lease,
        decisionRecordSha256: null,
        actorId: hero.user_id,
        seat: 1,
        actionOrdinal: 3,
      },
    ],
  };
  change?.({ input, capture, w, hand, node });
  const make = (kind: any, sequence: number, body: any) =>
    records.makeHorseJournalRecord(
      {
        producerId: producer,
        sequence,
        atMs: 2000,
        sourceRelease: source,
        kind,
        handKey,
        turnKey: kind === 'accepted_hand' ? handKey : turnKey,
      },
      body
    );
  const rows = [
    make('decision', 1, capture),
    make('execution', 2, w),
    make('accepted_hand', 3, hand),
  ];
  return {
    input,
    batch: {
      status: 'canonical_journal_export',
      sourceRelease: source,
      recordsByHand: [{ handKey, records: rows }],
    },
    rows,
  };
}

it('admits the closed accepted-all-in metadata through the actual existing encoder', () => {
  const f = fixture();
  const r = spawnSync(
    'python3',
    [
      '-B',
      resolve('../scripts/ci/inspect-tournament-refill.py'),
      '--encode-reference-cases',
      source,
    ],
    { input: JSON.stringify(f.input), encoding: 'utf8', timeout: 5000 }
  );
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(Buffer.from(r.stdout.trim(), 'base64').toString())).toEqual(f.input);
});
const inspect = (f: any) => diagnostic.inspectAcceptedAllInExecutionRecords(f.input, f.batch, api);
it('reports a type-only whole-stack promotion with real canonical reconciliation', () => {
  const f = fixture(),
    out = inspect(f);
  expect(review.reconcileHorseJournalHand(f.rows, f.input.cases[0].handKey)).toMatchObject({
    status: 'reconciled',
    gaps: [],
  });
  expect(out, JSON.stringify(out)).toMatchObject({
    status: 'observed',
    rawRecordsExported: false,
    activationAllowed: false,
  });
  expect(out.cases[0]).toMatchObject({
    selectedAction: 'raise',
    selectedAmount: 36.5,
    expectedExecutionAmount: 36.5,
    executedAction: 'all_in',
    acceptedAmount: 36.5,
    executionStatus: 'coerced',
    actionTypeMatches: false,
    amountMatches: true,
    derivedNormalizationKind: 'sized_wager_promoted_to_all_in',
    originalNormalizationReason: null,
    handReconciled: true,
  });
  expect(JSON.stringify(out)).not.toContain(f.input.cases[0].actorId);
  expect(JSON.stringify(out)).not.toMatch(/cards|username|snapshot|requestId/);
});
it.each(['preflop', 'river'] as const)(
  'retains %s missing-pair UNKNOWN and exact available counts independently',
  (stage) => {
    const f = fixture(undefined, stage);
    f.rows.splice(0, 2);
    const out = inspect(f);
    expect(out).toMatchObject({
      status: 'unknown',
      cases: [
        {
          status: 'unknown',
          reason: 'matching_pair_missing',
          counts: {
            decisionRecords: 0,
            executionRecords: 0,
            matchingDecisions: 0,
            matchingExecutions: 0,
            matchingPairs: 0,
          },
        },
      ],
    });
    expect(out.cases[0]).not.toHaveProperty('selectedAction');
  }
);
it('does not let a positive case hide the independent missing preflop cell', () => {
  const f = fixture(),
    missing = fixture(undefined, 'preflop');
  missing.rows.splice(0, 2);
  const oldKey = missing.input.cases[0].handKey;
  // Separate original hand coordinate, preserving all canonical hashes.
  const c = { ...missing.input.cases[0], handNumber: 124 };
  c.handKey = records.journalHash(`${table}:124:${lease}`);
  const h = JSON.parse(missing.rows[0].body);
  h.generation = 124;
  h.fence = `${table}:124:${lease}:observe`;
  h.handKey = `${table}:124`;
  const r = records.makeHorseJournalRecord(
    { ...missing.rows[0], handKey: c.handKey, turnKey: c.handKey },
    h
  );
  f.input.cases.push(c);
  f.batch.recordsByHand.push({ handKey: c.handKey, records: [r] });
  expect(oldKey).not.toBe(c.handKey);
  const out = inspect(f);
  expect(out.status).toBe('unknown');
  expect(out.cases[0].status).toBe('observed');
  expect(out.cases[1]).toMatchObject({ status: 'unknown', reason: 'matching_pair_missing' });
});
it('distinguishes real amount differences without calling them legal normalization', () => {
  const f = fixture(({ capture, w }: any) => {
    capture.decision.amount = 40;
    w.selected = { ...w.selected, amount: 40 };
    w.expectedExecutionAmount = 40;
  });
  expect(inspect(f).cases[0]).toMatchObject({
    status: 'observed',
    executionStatus: 'coerced',
    amountMatches: false,
    derivedNormalizationKind: 'action_and_amount_changed',
  });
});
it('retains an original chosen all-in as intended', () => {
  const f = fixture(({ capture, w }: any) => {
    capture.decision.action = 'all_in';
    delete capture.decision.amount;
    w.selected = { ...w.selected, action: 'all_in', amount: null };
    w.executionStatus = 'intended';
  });
  expect(inspect(f).cases[0]).toMatchObject({
    status: 'observed',
    executionStatus: 'intended',
    derivedNormalizationKind: 'unchanged',
  });
});
it.each([
  [
    'source',
    (f: any) => {
      f.batch.sourceRelease = 'b'.repeat(40);
    },
  ],
  [
    'hash',
    (f: any) => {
      f.rows[0] = { ...f.rows[0], body: f.rows[0].body + ' ' };
    },
  ],
  [
    'coordinate',
    (f: any) => {
      f.input.cases[0].leaseGeneration = producer;
    },
  ],
  [
    'ordinal',
    (f: any) => {
      f.input.cases[0].actionOrdinal = 2;
    },
  ],
  [
    'actor',
    (f: any) => {
      f.input.cases[0].actorId = producer;
    },
  ],
  [
    'duplicate',
    (f: any) => {
      f.rows.push(f.rows[0]);
    },
  ],
  [
    'missing hand',
    (f: any) => {
      f.rows.pop();
    },
  ],
  [
    'missing execution',
    (f: any) => {
      f.rows.splice(1, 1);
    },
  ],
])('refuses %s substitution or absent proof', (_n, mutate) => {
  const f = fixture();
  mutate(f);
  expect(inspect(f).status).toBe('unknown');
});
it.each([
  [
    'fallback',
    (x: any) => {
      x.w.executionStatus = 'fallback';
    },
  ],
  [
    'wrong action',
    (x: any) => {
      x.w.executedAction = 'call';
    },
  ],
  [
    'wrong accepted amount',
    (x: any) => {
      x.hand.actions[3].amount = 36;
    },
  ],
  [
    'contradictory intended',
    (x: any) => {
      x.w.executionStatus = 'intended';
    },
  ],
  [
    'wrong street',
    (x: any) => {
      x.capture.snapshot.gameState.stage = 'turn';
    },
  ],
  [
    'wrong request',
    (x: any) => {
      x.w.identity = { ...x.w.identity, requestId: 99 };
    },
  ],
  [
    'stale key',
    (x: any) => {
      x.capture.snapshot.decisionKey = 'wrong';
    },
  ],
])('keeps %s UNKNOWN with canonical components', (_n, change) => {
  expect(inspect(fixture(change)).status).toBe('unknown');
});
it('respects producer-local ordering across the accepted main record', () => {
  const f = fixture(),
    old = f.rows[2];
  f.rows[2] = records.makeHorseJournalRecord(
    { ...old, producerId: '52345678-abcd-4321-abcd-123456789abc', sequence: 1 },
    JSON.parse(old.body)
  );
  expect(inspect(f).status).toBe('observed');
});
function sanitize(f: any, result: any) {
  return spawnSync(
    'python3',
    [
      '-B',
      '-c',
      "import json,runpy,sys;a=json.load(sys.stdin);m=runpy.run_path(sys.argv[1]);print(json.dumps(m['sanitize_accepted_all_in_result'](a['result'],a['input'])))",
      resolve('../scripts/ci/inspect-tournament-refill.py'),
    ],
    { input: JSON.stringify({ input: f.input, result }), encoding: 'utf8', timeout: 5000 }
  );
}
it('uses the real Python sanitizer and refuses private or fabricated fields', () => {
  const f = fixture(),
    out = inspect(f),
    good = sanitize(f, out);
  expect(good.status, good.stderr).toBe(0);
  expect(JSON.parse(good.stdout)).toEqual(out);
  for (const change of [
    (c: any) => {
      c.cards = ['private-secret'];
    },
    (c: any) => {
      c.originalNormalizationReason = 'private-secret';
    },
    (c: any) => {
      c.actionTypeMatches = true;
    },
    (c: any) => {
      c.amountMatches = false;
    },
    (c: any) => {
      c.derivedNormalizationKind = 'unchanged';
    },
    (c: any) => {
      c.stack = true;
    },
    (c: any) => {
      c.acceptedAmount = 37;
    },
    (c: any) => {
      c.counts.matchingPairs = 0;
    },
    (c: any) => {
      c.decisionRecordSha256 = 'private-secret';
    },
  ]) {
    const bad = JSON.parse(JSON.stringify(out));
    change(bad.cases[0]);
    const r = sanitize(f, bad);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toContain('private-secret');
  }
});
it('sanitizes missing and ambiguous pair counts without inventing facts', () => {
  const f = fixture();
  f.rows.splice(0, 2);
  const out = inspect(f);
  expect(sanitize(f, out).status).toBe(0);
  const bad = JSON.parse(JSON.stringify(out));
  bad.cases[0].counts.matchingPairs = 1;
  expect(sanitize(f, bad).status).not.toBe(0);
});
it('refuses extra input, wrong source, coordinate, ordinal, actor, boolean and excess cases', () => {
  const f = fixture();
  const run = (input: any) =>
    spawnSync(
      'python3',
      [
        '-B',
        resolve('../scripts/ci/inspect-tournament-refill.py'),
        '--encode-reference-cases',
        source,
      ],
      { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 }
    );
  for (const bad of [
    { ...f.input, cards: ['private-secret'] },
    { ...f.input, sourceRelease: 'b'.repeat(40) },
    { ...f.input, cases: [{ ...f.input.cases[0], actorId: 'private-secret' }] },
    { ...f.input, cases: [{ ...f.input.cases[0], actionOrdinal: true }] },
    { ...f.input, cases: [{ ...f.input.cases[0], seat: 0 }] },
    { ...f.input, cases: [{ ...f.input.cases[0], handKey: '0'.repeat(64) }] },
    { ...f.input, cases: Array(7).fill(f.input.cases[0]) },
  ]) {
    const r = run(bad);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toContain('private-secret');
  }
});
it('uses the existing bounded child transport and closed v6 output', () => {
  const f = fixture(),
    out = inspect(f);
  const program = `import json,runpy,sys,pathlib
 a=json.load(sys.stdin);m=runpy.run_path(sys.argv[1]);g=m['decision_case_diagnostic'].__globals__
 g['TOURNAMENT_PREDICATE_JS']=pathlib.Path(sys.argv[1]).with_name('horse-tournament-predicate-proof.mjs').read_text()
 def bounded(command,**kw):
  assert command[:8]==['docker','exec','-i','club-arena-engine','node','--input-type=module','--max-old-space-size=128','-e']
  assert 'report=inspectAcceptedAllInExecutionRecords(input,batch,api)' in command[8]
  assert kw['separate_stderr'] is True and json.loads(kw['input_bytes'])==a['input']
  return json.dumps(a['result']).encode()
 g['bounded_command']=bounded
 print(json.dumps(m['decision_case_diagnostic'](a['input'])))`.replace(/^ /gm, '');
  const r = spawnSync(
    'python3',
    ['-B', '-c', program, resolve('../scripts/ci/inspect-tournament-refill.py')],
    { input: JSON.stringify({ input: f.input, result: out }), encoding: 'utf8', timeout: 5000 }
  );
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(out);
});
it('retains a same-action amount mismatch as an observed difference, not normalized success', () => {
  const f = fixture(({ capture, w, hand }: any) => {
    capture.decision.action = 'all_in';
    delete capture.decision.amount;
    w.selected = { ...w.selected, action: 'all_in', amount: null };
    w.executedAmount = 36;
    w.acceptedActions[0].record.amount = 36;
    hand.actions[3].amount = 36;
  });
  expect(inspect(f).cases[0]).toMatchObject({
    status: 'observed',
    actionTypeMatches: true,
    amountMatches: false,
    executionStatus: 'coerced',
    derivedNormalizationKind: 'amount_changed',
  });
});
it('keeps two original matching producer pairs ambiguous, with no selected facts', () => {
  const f = fixture();
  for (const original of f.rows.slice(0, 2))
    f.rows.push(
      records.makeHorseJournalRecord(
        { ...original, producerId: '62345678-abcd-4321-abcd-123456789abc' },
        JSON.parse(original.body)
      )
    );
  const out = inspect(f);
  expect(out.cases[0]).toMatchObject({
    status: 'unknown',
    reason: 'matching_pair_ambiguous',
    counts: { matchingPairs: 2 },
  });
  expect(out.cases[0]).not.toHaveProperty('selectedAction');
  expect(sanitize(f, out).status).toBe(0);
});
it('supports the original preflop all-in cell when its pair is actually retained', () => {
  expect(inspect(fixture(undefined, 'preflop')).cases[0]).toMatchObject({
    status: 'observed',
    stage: 'preflop',
    executionStatus: 'coerced',
  });
});
it('reports a retained decision with a missing execution as UNKNOWN, rather than no decision', () => {
  const f = fixture(undefined, 'preflop');
  f.rows.splice(1, 1);
  const out = inspect(f);
  expect(out.cases[0]).toMatchObject({
    status: 'unknown',
    reason: 'matching_pair_missing',
    counts: {
      decisionRecords: 1,
      executionRecords: 0,
      matchingDecisions: 1,
      matchingExecutions: 0,
      matchingPairs: 0,
    },
  });
  expect(sanitize(f, out).status).toBe(0);
});

it('keeps a genuine authority withdrawal distinct from later controller normalization', () => {
  const f = fixture(({ capture, w, hand }: any) => {
    const holder = new HorseQualifiedAuthorityHolder('allin-review-worker');
    holder.apply(qualifiedTestAdmission(1));
    const ledger = (authority: any) => ({
      version: 'horse-tournament-postflop-round2-v1',
      mode: 'candidate',
      changed: true,
      applied: true,
      selection: 'selected',
      authority,
      authorityVerdict: null,
      baselineAction: 'all_in',
      baselineAmount: null,
      candidateAction: 'fold',
      candidateAmount: null,
      executionStatus: 'pending',
      executedAction: null,
      executedAmount: null,
    });
    capture.decision = {
      action: 'fold',
      thinkTime: 0,
      tournamentPostflop: ledger(holder.receipt()),
    };
    const gate = new HorsePhase8AuthorityGate(() => qualifiedTestAdmission(1), 'allin-review-main');
    gate.refresh();
    const delivered = {
      ...capture.decision,
      tournamentPostflop: ledger(gate.stamp(holder.receipt())),
    };
    const replacement = witness.createHorseExecutionWitness(capture.snapshot, delivered, {
      requestId: 9,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    });
    witness.withdrawHorsePhase8Selection(replacement, capture.snapshot, 'withdrawn');
    witness.settleHorseExecutionWitness(replacement, {
      applied: true,
      acceptedActions: [{ record: hand.actions[3], intended: true }],
    });
    Object.assign(w, replacement);
  });
  const out = inspect(f);
  expect(out, JSON.stringify(out)).toMatchObject({ status: 'observed' });
  expect(out.cases[0]).toMatchObject({
    capturedAction: 'fold',
    selectedAction: 'all_in',
    acceptedAction: 'all_in',
    capturedVsSelectedActionMatches: false,
    capturedVsSelectedAmountMatches: true,
    normalizationComparison: 'selected_vs_accepted',
    derivedNormalizationKind: 'unchanged',
    originalNormalizationReason: null,
  });
  expect(sanitize(f, out).status).toBe(0);
});
it('refuses an unexplained captured-versus-selected substitution', () => {
  const f = fixture(({ capture }: any) => {
    capture.decision.action = 'fold';
    delete capture.decision.amount;
  });
  const out = inspect(f);
  expect(out.cases[0]).toMatchObject({
    status: 'unknown',
    reason: 'hand_not_reconciled',
    diagnostics: {
      wholeHandReview: {
        scope: 'whole_original_hand',
        status: 'incomplete',
        gapCounts: { counts: { input_mismatch: 1 } },
      },
    },
  });
});
it('exposes fixed whole-hand gaps and exact-target binder refusal when a pair cannot bind', () => {
  const f = fixture(({ w }: any) => {
    w.acceptedActions[0].record.amount = 37;
  });
  const out = inspect(f);
  expect(out.cases[0]).toMatchObject({
    status: 'unknown',
    reason: 'matching_pair_missing',
    diagnostics: {
      wholeHandReview: { scope: 'whole_original_hand', status: 'incomplete' },
      targetBinder: {
        scope: 'original_target_anchor',
        targetExecutions: 1,
        boundExecutions: 0,
        refusalCounts: { counts: { accepted_action_mismatch: 1 }, otherCount: 0 },
      },
    },
  });
  expect(sanitize(f, out).status).toBe(0);
});
it('retains actual SDK unmatched-action gaps on a standalone missing preflop pair', () => {
  const f = fixture(undefined, 'preflop');
  f.rows.splice(0, 2);
  const out = inspect(f);
  expect(out.cases[0]).toMatchObject({
    status: 'unknown',
    reason: 'matching_pair_missing',
    diagnostics: {
      wholeHandReview: {
        scope: 'whole_original_hand',
        status: 'incomplete',
        gapCounts: { counts: { unmatched_horse_action: 1 } },
      },
      targetBinder: { targetExecutions: 0, boundExecutions: 0 },
      targetLifecycle: { requested: 0, terminal: 0 },
    },
  });
  expect(sanitize(f, out).status).toBe(0);
});
function addLifecycle(f: any, badDigest = false) {
  const [d, e, h] = f.rows,
    s = JSON.parse(d.body).snapshot,
    requestDigest = lifecycle.horseLifecycleRequestDigest(s);
  const make = (original: any, kind: any, sequence: number, body: any) =>
    records.makeHorseJournalRecord({ ...original, kind, sequence }, body);
  const requested = make(d, 'request_lifecycle', 1, {
    version: 1,
    phase: 'requested',
    request: s,
    requestDigest,
    origin: 'worker_compute',
  });
  const terminal = make(d, 'request_lifecycle', 3, {
    version: 1,
    phase: 'terminal',
    requestDigest: badDigest ? 'f'.repeat(64) : requestDigest,
    outcome: 'success',
  });
  f.rows.splice(
    0,
    3,
    requested,
    make(d, 'decision', 2, JSON.parse(d.body)),
    terminal,
    make(e, 'execution', 4, JSON.parse(e.body)),
    make(h, 'accepted_hand', 5, JSON.parse(h.body))
  );
}
it('counts original target lifecycle only after actual digest and producer/turn joins', () => {
  const f = fixture();
  addLifecycle(f);
  const out = inspect(f);
  expect(out, JSON.stringify(out)).toMatchObject({
    status: 'observed',
    cases: [
      {
        diagnostics: {
          wholeHandReview: {
            requestedRequests: 1,
            terminalRequests: 1,
            requestLifecycleVerified: true,
          },
          targetLifecycle: {
            scope: 'original_target_request_digest',
            requested: 1,
            terminal: 1,
            terminalOutcomes: { success: 1 },
          },
        },
      },
    ],
  });
  expect(sanitize(f, out).status).toBe(0);
});
it('does not credit a terminal with a foreign original request digest', () => {
  const f = fixture();
  addLifecycle(f, true);
  const out = inspect(f);
  expect(out.cases[0]).toMatchObject({
    status: 'unknown',
    diagnostics: {
      wholeHandReview: {
        status: 'incomplete',
        gapCounts: { counts: { request_lifecycle_mismatch: 1 } },
      },
      targetLifecycle: { requested: 1, terminal: 0, terminalOutcomes: { success: 0 } },
    },
  });
  expect(sanitize(f, out).status).toBe(0);
});
it('keeps a different actor lifecycle in whole-hand counts, not target counts', () => {
  const f = fixture(),
    s = JSON.parse(f.rows[0].body).snapshot;
  s.player = { ...s.gameState.players[1] };
  s.gameState.currentPlayerSeat = 2;
  s.fence = `${table}:123:2:${lease}:7`;
  s.decisionKey = buildHorseDecisionKey(s);
  const keys = lifecycle.horseLifecycleKeys(s),
    requestDigest = lifecycle.horseLifecycleRequestDigest(s);
  const meta = {
    ...f.rows[0],
    producerId: '72345678-abcd-4321-abcd-123456789abc',
    turnKey: records.journalHash(keys.turn),
  };
  f.rows.push(
    records.makeHorseJournalRecord(
      { ...meta, kind: 'request_lifecycle', sequence: 1 },
      { version: 1, phase: 'requested', request: s, requestDigest, origin: 'worker_compute' }
    )
  );
  f.rows.push(
    records.makeHorseJournalRecord(
      { ...meta, kind: 'request_lifecycle', sequence: 2 },
      { version: 1, phase: 'terminal', requestDigest, outcome: 'cancelled' }
    )
  );
  const out = inspect(f);
  expect(out.cases[0]).toMatchObject({
    status: 'observed',
    diagnostics: {
      wholeHandReview: { requestedRequests: 1, terminalRequests: 1 },
      targetLifecycle: { requested: 0, terminal: 0, terminalOutcomes: { cancelled: 0 } },
    },
  });
  expect(sanitize(f, out).status).toBe(0);
});
it('maps new SDK gap labels to an other count, never exporting arbitrary reasons', () => {
  const f = fixture();
  f.rows.splice(0, 2);
  const out = diagnostic.inspectAcceptedAllInExecutionRecords(f.input, f.batch, {
    ...api,
    reconcileHorseJournalHand: (...args: any[]) => ({
      ...review.reconcileHorseJournalHand(args[0], args[1]),
      gaps: ['private-secret'],
    }),
  });
  expect(out.cases[0].diagnostics.wholeHandReview.gapCounts).toEqual({ counts: {}, otherCount: 1 });
  expect(JSON.stringify(out)).not.toContain('private-secret');
  expect(sanitize(f, out).status).toBe(0);
});
it('refuses forged diagnostic scopes, reason labels, counts and comparison flags at the real output boundary', () => {
  const f = fixture(),
    out = inspect(f);
  for (const change of [
    (c: any) => {
      c.diagnostics.wholeHandReview.scope = 'target';
    },
    (c: any) => {
      c.diagnostics.wholeHandReview.gapCounts.counts = { 'private-secret': 1 };
    },
    (c: any) => {
      c.diagnostics.targetBinder.targetExecutions = 3;
    },
    (c: any) => {
      c.diagnostics.targetLifecycle.terminalOutcomes.success = 1;
    },
    (c: any) => {
      c.capturedVsSelectedActionMatches = false;
    },
    (c: any) => {
      c.normalizationComparison = 'captured_vs_accepted';
    },
  ]) {
    const bad = JSON.parse(JSON.stringify(out));
    change(bad.cases[0]);
    const r = sanitize(f, bad);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toContain('private-secret');
  }
});
it('does not attribute a different original actor anchor to the target binder', () => {
  const f = fixture(({ w }: any) => {
    w.handAnchor = { ...w.handAnchor, actorId: producer };
  });
  const out = inspect(f);
  expect(out.cases[0]).toMatchObject({
    status: 'unknown',
    diagnostics: {
      targetBinder: {
        targetExecutions: 0,
        boundExecutions: 0,
        refusalCounts: { counts: {}, otherCount: 0 },
      },
    },
  });
  expect(sanitize(f, out).status).toBe(0);
});
it('maps unknown target binder reasons to a count without echoing their contents', () => {
  const f = fixture();
  const out = diagnostic.inspectAcceptedAllInExecutionRecords(f.input, f.batch, {
    ...api,
    bindHorseDecisionToCommittedHand: () => ({ status: 'unavailable', reason: 'private-secret' }),
  });
  expect(out.cases[0]).toMatchObject({
    status: 'unknown',
    diagnostics: {
      targetBinder: {
        targetExecutions: 1,
        boundExecutions: 0,
        refusalCounts: { counts: {}, otherCount: 1 },
      },
    },
  });
  expect(JSON.stringify(out)).not.toContain('private-secret');
  expect(sanitize(f, out).status).toBe(0);
});
