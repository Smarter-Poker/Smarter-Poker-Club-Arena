import { expect, it, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
// @ts-expect-error standalone maintained host helper
import { inspectCashTurnFoldRecords } from '../../../../scripts/ci/horse-tournament-predicate-proof.mjs';
import * as records from '../../services/horseDecisionJournal/record.js';
import * as binding from '../../engine/HorseDecisionHandBinding.js';
import * as review from '../../services/horseDecisionJournal/review.js';
import * as witness from '../../engine/HorseExecutionWitness.js';
import { buildHorseDecisionKey } from '../../engine/horseDecision/protocol.js';
import { jointPolicyFixture } from '../../engine/multiway/JointRangeFixture.test-support.js';
import { encodeHorseDecisionReads } from '../../engine/HorseDecisionReadFrame.js';
import { HorseMind } from '../../engine/HorseMind.js';
import { channelHub } from '../../hub/ChannelHub.js';
const api = { ...records, ...binding, ...review };
afterAll(() => channelHub.close());
const table = '12345678-abcd-4321-abcd-123456789abc',
  lease = '22345678-abcd-4321-abcd-123456789abc',
  handId = '32345678-abcd-4321-abcd-123456789abc',
  producer = '42345678-abcd-4321-abcd-123456789abc',
  source = 'a'.repeat(40);
function fixture(change?: (x: any) => void) {
  const { hero, state }: any = JSON.parse(
    JSON.stringify(jointPolicyFixture('plo5', 1, 'cash', 'turn')),
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
    currentBet: 112,
    toCall: 112,
    legalActions: ['fold', 'call', 'all_in'],
  });
  delete state.contestablePot;
  state.actionHistory = Array.from({ length: 14 }, (_, i) => ({
    seat: 2,
    userId: state.players[1].user_id,
    action: 'check',
    amount: 0,
    stage: 'flop',
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
  const decision: any = { action: 'fold', thinkTime: 0 };
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
    action: 'fold',
    amount: 0,
    timestamp: 1001,
    stage: 'turn',
  };
  witness.settleHorseExecutionWitness(w, {
    applied: true,
    acceptedActions: [{ record: action, intended: true }],
  });
  const node: any = {
    version: 1,
    status: 'captured',
    mode: 'cash',
    street: 'turn',
    actorSeat: 1,
    variant: 'plo5',
    currentBet: 112,
    pot: 451,
    toCall: 112,
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
          actionOrdinal: 14,
          observationId: `${handId}:14`,
          sessionKey: 'c'.repeat(64),
        },
      },
    ],
  };
  const handKey = records.journalHash(`${table}:123:${lease}`),
    turnKey = records.journalHash(JSON.stringify([7, s.fence, 9, s.decisionKey, 1000]));
  const input: any = {
    version: 5,
    probe: 'cash_turn_fold',
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
        actionOrdinal: 14,
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
it('captures the cheap effective price with actual maintained reconciliation and no invented equity', () => {
  const f = fixture(),
    out = inspectCashTurnFoldRecords(f.input, f.batch, api);
  expect(review.reconcileHorseJournalHand(f.rows, f.input.cases[0].handKey)).toMatchObject({
    status: 'reconciled',
    gaps: [],
  });
  expect(out, JSON.stringify(out)).toMatchObject({
    status: 'observed',
    rawRecordsExported: false,
    replayVerified: false,
    activationAllowed: false,
  });
  expect(out.cases[0]).toMatchObject({
    rawCall: 112,
    effectiveCall: 36.5,
    uncallableExcess: 75.5,
    stack: 36.5,
    pot: 451,
    capturedContestablePot: null,
    derivedReference: { contestablePot: 375.5, unrakedCallPrice: 36.5 / 412 },
    ownCardCount: 5,
    ownMadeCategory: null,
    originalReferenceEquity: null,
    originalReferenceReason: null,
  });
  expect(
    out.cases[0].policyReceipts.every(
      (r: any) => !r.present && r.callPrice === null && r.equity === null && r.reason === null
    )
  ).toBe(true);
  expect(JSON.stringify(out)).not.toContain(f.input.cases[0].actorId);
  expect(JSON.stringify(out)).not.toMatch(/cards|username|snapshot|requestId/);
});
it.each([
  ['ordinal', (x: any) => (x.input.cases[0].actionOrdinal = 13)],
  ['actor', (x: any) => (x.input.cases[0].actorId = producer)],
  ['turn', (x: any) => (x.capture.snapshot.gameState.stage = 'river')],
  ['not acting turn', (x: any) => (x.capture.snapshot.gameState.currentPlayerSeat = 2)],
  ['own card shape', (x: any) => (x.capture.snapshot.player.cards = [])],
  ['board shape', (x: any) => (x.capture.snapshot.gameState.communityCards = [])],
  ['action', (x: any) => (x.hand.actions[14].action = 'call')],
  ['origin', (x: any) => (x.hand.actions[14].origin = 'human')],
  ['execution', (x: any) => (x.w.executedAction = 'call')],
  ['request identity', (x: any) => (x.w.identity = { ...x.w.identity, requestId: 99 })],
  ['snapshot actor', (x: any) => (x.capture.snapshot.player.user_id = producer)],
  ['public stack', (x: any) => (x.node.seats[0][1] = 100)],
  ['price', (x: any) => (x.node.toCall = 36.5)],
  ['node unavailable', (x: any) => (x.node.status = 'unavailable')],
  ['mode', (x: any) => (x.node.mode = 'tournament')],
  ['variant', (x: any) => (x.node.variant = 'private-secret')],
])('refuses contradictory %s', (_name, change) => {
  const f = fixture(change),
    out = inspectCashTurnFoldRecords(f.input, f.batch, api);
  expect(out.status).toBe('unknown');
  expect(out.cases[0].status).toBe('unknown');
  expect(JSON.stringify(out)).not.toContain('private-secret');
});
it('refuses source, record hash, coordinate, duplicates and absent capture', () => {
  for (const mode of ['source', 'hash', 'coordinate', 'duplicate', 'missing']) {
    const f = fixture();
    if (mode === 'source') f.batch.sourceRelease = 'b'.repeat(40);
    if (mode === 'hash') f.rows[0] = { ...f.rows[0], body: f.rows[0].body + ' ' };
    if (mode === 'coordinate') f.input.cases[0].leaseGeneration = producer;
    if (mode === 'duplicate') f.rows.push(f.rows[0]);
    if (mode === 'missing') f.rows.splice(0, 1);
    expect(inspectCashTurnFoldRecords(f.input, f.batch, api).status, mode).toBe('unknown');
  }
});

it('passes the real Python output boundary and refuses private additions or invented derived values', () => {
  const f = fixture(),
    out = inspectCashTurnFoldRecords(f.input, f.batch, api);
  const program =
    "import json,runpy,sys; a=json.load(sys.stdin); m=runpy.run_path(sys.argv[1]); print(json.dumps(m['sanitize_cash_turn_fold_result'](a['result'],a['input'])))";
  const run = (result: any) =>
    spawnSync(
      'python3',
      ['-B', '-c', program, resolve('../scripts/ci/inspect-tournament-refill.py')],
      { input: JSON.stringify({ result, input: f.input }), encoding: 'utf8', timeout: 5000 }
    );
  const good = run(out);
  expect(good.status, good.stderr).toBe(0);
  expect(JSON.parse(good.stdout)).toEqual(out);
  for (const mutate of [
    (c: any) => (c.opponentCards = ['private-secret']),
    (c: any) => (c.derivedReference.unrakedCallPrice = 0.5),
    (c: any) => (c.policyReceipts[0].reason = 'private-secret'),
    (c: any) => (c.rawCall = true),
    (c: any) => (c.effectiveCall = 112),
    (c: any) => (c.actionOrdinal = 13),
    (c: any) => (c.policyReceipts[0].equity = 0.8),
  ]) {
    const bad = JSON.parse(JSON.stringify(out));
    mutate(bad.cases[0]);
    const r = run(bad);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toContain('private-secret');
  }
});
it('uses the existing bounded installed-image transport with the v5 adapter and closed sanitizer', () => {
  const f = fixture(),
    out = inspectCashTurnFoldRecords(f.input, f.batch, api);
  const program = `import json,runpy,sys,pathlib
 a=json.load(sys.stdin);m=runpy.run_path(sys.argv[1]);g=m['decision_case_diagnostic'].__globals__
 g['TOURNAMENT_PREDICATE_JS']=pathlib.Path(sys.argv[1]).with_name('horse-tournament-predicate-proof.mjs').read_text()
 def bounded(command,**kw):
  assert command[:8]==['docker','exec','-i','club-arena-engine','node','--input-type=module','--max-old-space-size=128','-e']
  assert 'loadInstalledCashTurnFoldApi' in command[8] and 'report=inspectCashTurnFoldRecords(input,batch,api)' in command[8]
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
it('accepts a main-publisher accepted hand with a lower independent producer sequence', () => {
  const f = fixture(),
    old = f.rows[2];
  f.rows[2] = records.makeHorseJournalRecord(
    { ...old, producerId: '52345678-abcd-4321-abcd-123456789abc', sequence: 1 },
    JSON.parse(old.body)
  );
  const reconciled = review.reconcileHorseJournalHand(f.rows, f.input.cases[0].handKey);
  expect(reconciled).toMatchObject({
    status: 'reconciled',
    gaps: [],
    matchedActions: 1,
    acceptedHorseActions: 1,
  });
  expect(inspectCashTurnFoldRecords(f.input, f.batch, api)).toMatchObject({ status: 'observed' });
});
