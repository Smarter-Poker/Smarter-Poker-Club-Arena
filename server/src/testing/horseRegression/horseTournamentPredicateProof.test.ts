/** Entirely synthetic local fixtures. No production records or live qualification. */
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  explicitTournamentPredicates,
  inspectTournamentPredicateRecords,
  tournamentPredicateInputIsValid,
  // @ts-expect-error standalone runtime helper is deliberately plain JavaScript
} from '../../../../scripts/ci/horse-tournament-predicate-proof.mjs';
import * as payout from '../../engine/HorseTournamentPayoutTerms';
import * as provenance from '../../engine/HorseTournamentContextProvenance';
import * as records from '../../services/horseDecisionJournal/record';
import * as binding from '../../engine/HorseDecisionHandBinding';
import * as review from '../../services/horseDecisionJournal/review';
import * as validation from '../../engine/horseDecision/responseValidation';
import * as witness from '../../engine/HorseExecutionWitness';
import { buildHorseDecisionKey } from '../../engine/horseDecision/protocol';
import { remainingReferenceDeck } from '../../benchmark/RemainingVariantReference';
import { jointPolicyFixture } from '../../engine/multiway/JointRangeFixture.test-support';
import { HorseLogic } from '../../engine/HorseLogic';
import { HorseMind } from '../../engine/HorseMind';
import { encodeHorseDecisionReads } from '../../engine/HorseDecisionReadFrame';
import { seedFastRandom } from '../../engine/HorseEval';
import { channelHub } from '../../hub/ChannelHub';
const api = { ...payout, ...provenance, ...records, ...binding, ...review, ...validation };
const source = 'a'.repeat(40),
  table = '12345678-abcd-4321-abcd-123456789abc',
  lease = '22345678-abcd-4321-abcd-123456789abc',
  handId = '32345678-abcd-4321-abcd-123456789abc',
  producer = '42345678-abcd-4321-abcd-123456789abc';
let fixture: any;
beforeAll(() => {
  channelHub.close();
  const { hero, state }: any = JSON.parse(
    JSON.stringify(jointPolicyFixture('nlh', 1, 'tournament', 'river')),
    (_k, v) =>
      typeof v === 'string' && /^p[0-9]$/.test(v)
        ? '20000000-0000-4000-8000-00000000000' + (Number(v[1]) + 1)
        : v
  );
  state.actionHistory = [];
  const t = state.tournament;
  t.stackByUser = Object.fromEntries(
    state.players.map((p: any) => [p.user_id, p.stack + p.totalInvested])
  );
  t.tournamentId = '52345678-abcd-4321-abcd-123456789abc';
  Object.assign(
    t,
    payout.captureHorseTournamentPayoutTerms(
      {
        id: t.tournamentId,
        prize_pool_finalized: true,
        bubble_protection: true,
        payout_club: null,
        prize_pool: 100,
        buy_in_amount: 10,
      },
      [
        { place: 1, percentage: 65 },
        { place: 2, percentage: 35 },
      ],
      4,
      false
    )
  );
  t.currentSmallBlind = 1;
  t.currentBigBlind = state.bigBlind;
  t.currentAnte = state.ante ?? 0;
  t.sourceAgeMs = 0;
  t.contextStatus = 'complete';
  t.contextIssues = [];
  t.contextProvenance = {
    version: 1,
    readAtMs: 1000,
    status: 'complete',
    issues: [],
    ageMs: 0,
    source: {
      version: 1,
      tournamentId: t.tournamentId,
      cacheId: producer,
      generation: 1,
      readStartedAtMs: 999,
      readCompletedAtMs: 1000,
      contextDigest: 'b'.repeat(64),
      contextStatus: 'complete',
      contextIssues: [],
    },
    projection: {
      tableId: table,
      handNumber: 123,
      actorId: hero.user_id,
      actorSeat: hero.seat,
      dealerSeat: state.dealerSeat ?? null,
      dealtSeatIds: state.players.map((p: any) => p.seat),
      smallBlind: 1,
      bigBlind: state.bigBlind,
      ante: state.ante ?? 0,
      gameVariant: state.gameVariant,
    },
  };
  const s: any = {
    type: 'DECIDE_FAST',
    requestId: 9,
    generation: 7,
    fence: `${table}:123:${hero.seat}:${lease}:7`,
    decisionTimeMs: 1000,
    decisionKey: '',
    player: hero,
    gameState: state,
    style: 'balanced',
    opts: { mind: false, telemetry: false, phase8Postflop: 'off', phase13Joint: 'off' },
    handJournalContext: binding.captureHorseHandJournalContext([]),
  };
  s.decisionKey = buildHorseDecisionKey(s);
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  let decision: any;
  try {
    seedFastRandom(1500921);
    decision = HorseLogic.decide(hero, state, 'balanced', {}, { ...s.opts, decisionTimeMs: 1000 });
  } finally {
    clock.mockRestore();
  }
  const readFrame = encodeHorseDecisionReads(
    HorseMind.createSandbox(),
    state.players,
    HorseMind.handKeyOf([])
  );
  expect(
    decision.tournamentUtility,
    JSON.stringify({ refusal: decision.tournamentUtilityRefusal, terms: t })
  ).toBeDefined();
  decision.tournamentUtility.readFrameSha256 = readFrame.sha256;
  const capture = {
    snapshot: s,
    readFrame,
    decision,
    effects: [],
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 1,
    governorScale: 1,
    runtimePins: 'incomplete',
  };
  const w = witness.createHorseExecutionWitness(s, decision, {
    requestId: 9,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  const amount = w.expectedExecutionAmount;
  const action: any = {
    seat: hero.seat,
    userId: hero.user_id,
    action: decision.action,
    amount,
    timestamp: 1001,
    stage: 'river',
  };
  witness.settleHorseExecutionWitness(w, {
    applied: true,
    acceptedActions: [{ record: action, intended: true }],
  });
  const hand = {
    type: 'OBSERVE_COMPLETED_HAND',
    requestId: 10,
    generation: 123,
    fence: `${table}:123:${lease}:observe`,
    handKey: `${table}:123`,
    committedHandId: handId,
    bigBlind: state.bigBlind,
    actions: [
      {
        ...action,
        origin: 'horse_policy',
        publicNode: { version: 1, status: 'captured', actorSeat: hero.seat, street: 'river' },
        observationIdentity: {
          version: 1,
          status: 'bound',
          handId,
          actionOrdinal: 0,
          observationId: `${handId}:0`,
          sessionKey: 'c'.repeat(64),
        },
      },
    ],
  };
  const handKey = records.journalHash(`${table}:123:${lease}`),
    turnKey = records.journalHash(JSON.stringify([7, s.fence, 9, s.decisionKey, 1000]));
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
  const input = {
    version: 1,
    sourceRelease: source,
    cases: [
      {
        handKey,
        tableId: table,
        handId,
        handNumber: 123,
        leaseGeneration: lease,
        decisionRecordSha256: null,
      },
    ],
  };
  const batch = {
    status: 'canonical_journal_export',
    sourceRelease: source,
    recordsByHand: [{ handKey, records: rows }],
  };
  fixture = { capture, w, hand, rows, input, batch, make, handKey, action };
});
afterAll(() => channelHub.close());
it('observes actual finalized payout/provenance validators and actual reconciled intended hand', () => {
  expect(
    payout.validHorseTournamentPayoutTerms(fixture.capture.snapshot.gameState.tournament)
  ).toBe(true);
  expect(provenance.horseTournamentProvenanceMatchesSnapshot(fixture.capture.snapshot)).toBe(true);
  expect(review.reconcileHorseJournalHand(fixture.rows, fixture.handKey)).toMatchObject({
    status: 'reconciled',
    gaps: [],
  });
  const result = inspectTournamentPredicateRecords(fixture.input, fixture.batch, api);
  expect(result.status).toBe('observed');
  const sanitized = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      "import json,runpy,sys; m=runpy.run_path(sys.argv[1]);d=json.loads(sys.stdin.read());print(json.dumps(m['sanitize_tournament_result'](d['result'],d['input'])))",
      resolve(__dirname, '../../../../scripts/ci/inspect-tournament-refill.py'),
    ],
    { input: JSON.stringify({ result, input: fixture.input }), encoding: 'utf8' }
  );
  expect(sanitized.status, sanitized.stderr).toBe(0);
  expect(JSON.parse(sanitized.stdout)).toEqual(result);
  for (const mutate of [
    (r: any) => {
      r.cases[0].privatePayload = 'private-sentinel';
    },
    (r: any) => {
      r.cases[0].handReconciled = 1;
    },
    (r: any) => {
      r.cases[0].contextDigest = 'bad';
    },
    (r: any) => {
      r.sourceRelease = 'b'.repeat(40);
    },
    (r: any) => {
      r.status = 'unknown';
    },
  ]) {
    const refused = structuredClone(result);
    mutate(refused);
    const checked = spawnSync(
      'python3',
      [
        '-B',
        '-c',
        "import json,runpy,sys; m=runpy.run_path(sys.argv[1]);d=json.loads(sys.stdin.read());\ntry: m['sanitize_tournament_result'](d['result'],d['input']);print('accepted')\nexcept Exception: print('refused')",
        resolve(__dirname, '../../../../scripts/ci/inspect-tournament-refill.py'),
      ],
      { input: JSON.stringify({ result: refused, input: fixture.input }), encoding: 'utf8' }
    );
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout.trim()).toBe('refused');
  }

  expect(result.cases[0]).toMatchObject({
    finalizedLadderValidated: true,
    bubbleProtectionCaptured: true,
    bubbleProtectionEnabled: true,
    handReconciled: true,
  });
  expect(result).toMatchObject({
    v56Causality: 'unknown',
    previousLevelBranch: 'unknown',
    activationAllowed: false,
    replayVerified: false,
    rawRecordsExported: false,
  });
  expect(JSON.stringify(result)).not.toContain(fixture.capture.snapshot.player.user_id);
});
it('does not promote legacy absence, malformed terms, absent receipt or foreign provenance', () => {
  expect(payout.validHorseTournamentPayoutTerms({})).toBe(true);
  const legacy = structuredClone(fixture.capture);
  for (const key of [
    'payoutTermsVersion',
    'prizePoolFinalized',
    'bubbleProtection',
    'prizeUnitCents',
    'finalizedPrizeLadder',
  ])
    delete legacy.snapshot.gameState.tournament[key];
  expect(payout.validHorseTournamentPayoutTerms(legacy.snapshot.gameState.tournament)).toBe(true);
  expect(explicitTournamentPredicates(legacy, api)).toBeNull();
  for (const mutate of [
    (d: any) => {
      delete d.snapshot.gameState.tournament.payoutTermsVersion;
    },
    (d: any) => {
      delete d.snapshot.gameState.tournament.finalizedPrizeLadder;
    },
    (d: any) => {
      d.snapshot.gameState.tournament.finalizedPrizeLadder.poolCents++;
    },
    (d: any) => {
      d.snapshot.gameState.tournament.prizePoolCents++;
    },
    (d: any) => {
      delete d.snapshot.gameState.tournament.contextProvenance;
    },
    (d: any) => {
      d.snapshot.gameState.tournament.contextProvenance.projection.actorSeat = 9;
    },
    (d: any) => {
      delete d.decision.tournamentUtility.evidence;
    },
    (d: any) => {
      d.decision.tournamentUtility.readFrameSha256 = '0'.repeat(64);
    },
  ]) {
    const d = structuredClone(fixture.capture);
    mutate(d);
    expect(explicitTournamentPredicates(d, api)).toBeNull();
  }
});
it('refuses invalid coordinates/hash/source/bounds before processing records', () => {
  for (const change of [
    { version: 2 },
    { sourceRelease: 'bad' },
    { cases: [] },
    { cases: Array(7).fill(fixture.input.cases[0]) },
    { cases: [{ ...fixture.input.cases[0], decisionRecordSha256: 'bad' }] },
    { cases: [{ ...fixture.input.cases[0], handKey: '0'.repeat(64) }] },
  ])
    expect(tournamentPredicateInputIsValid({ ...fixture.input, ...change }, source)).toBe(false);
  expect(
    inspectTournamentPredicateRecords(
      fixture.input,
      { ...fixture.batch, sourceRelease: 'b'.repeat(40) },
      api
    ).status
  ).toBe('unknown');
  const batch = structuredClone(fixture.batch);
  batch.recordsByHand[0].records[0].sha256 = '0'.repeat(64);
  expect(inspectTournamentPredicateRecords(fixture.input, batch, api).status).toBe('unknown');
});
it('refuses wrong explicit hash, ambiguous bounded discovery and rehashed wrong execution identity', () => {
  const input = structuredClone(fixture.input);
  input.cases[0].decisionRecordSha256 = '0'.repeat(64);
  expect(inspectTournamentPredicateRecords(input, fixture.batch, api).cases[0].reason).toBe(
    'matching_decision_missing'
  );
  const batch = structuredClone(fixture.batch);
  batch.recordsByHand[0].records.push(fixture.make('decision', 4, fixture.capture));
  expect(inspectTournamentPredicateRecords(fixture.input, batch, api).cases[0].reason).toBe(
    'matching_decision_ambiguous'
  );
  const w = structuredClone(fixture.w);
  w.identity.requestId++;
  batch.recordsByHand[0].records = [
    fixture.rows[0],
    fixture.make('execution', 2, w),
    fixture.rows[2],
  ];
  expect(inspectTournamentPredicateRecords(fixture.input, batch, api).cases[0].reason).toBe(
    'hand_not_reconciled'
  );
});
it('keeps missing execution, accepted identity, duplicate, oversized and malformed journals unknown', () => {
  const variants = [
    fixture.rows.filter((r: any) => r.kind !== 'execution'),
    [
      fixture.rows[0],
      fixture.rows[1],
      fixture.make('accepted_hand', 3, { ...fixture.hand, committedHandId: producer }),
    ],
    [...fixture.rows, fixture.rows[0]],
    Array(257).fill(fixture.rows[0]),
    [{ ...fixture.rows[0], body: 'not-json' }, ...fixture.rows.slice(1)],
    [{ ...fixture.rows[0], sourceRelease: 'b'.repeat(40) }, ...fixture.rows.slice(1)],
  ];
  for (const rows of variants) {
    const batch = {
      ...fixture.batch,
      recordsByHand: [{ handKey: fixture.handKey, records: rows }],
    };
    expect(inspectTournamentPredicateRecords(fixture.input, batch, api).status).toBe('unknown');
  }
  const input = structuredClone(fixture.input);
  input.cases[0].decisionRecordSha256 = fixture.rows[0].sha256;
  expect(inspectTournamentPredicateRecords(input, fixture.batch, api).status).toBe('observed');
});
function multipleP7Fixture() {
  const first = fixture.capture,
    second = structuredClone(first),
    s = second.snapshot;
  // Local synthetic second player's ordinary turn; preserve the full accepted prefix.
  const firstAction = structuredClone(fixture.hand.actions[0]);
  const hero = s.gameState.players[1];
  const used = new Set(
    [...s.gameState.communityCards, ...first.snapshot.player.cards].map((c: any) =>
      JSON.stringify(c)
    )
  );
  hero.cards = remainingReferenceDeck(false)
    .filter((c) => !used.has(JSON.stringify(c)))
    .slice(0, 2);
  s.player = hero;
  s.gameState.heroSeat = hero.seat;
  s.gameState.currentPlayerSeat = hero.seat;
  s.gameState.actionHistory = [firstAction];
  if (['bet', 'raise', 'all_in'].includes(firstAction.action)) {
    s.gameState.currentBet = firstAction.amount;
    s.gameState.toCall = Math.max(0, firstAction.amount - hero.bet);
    s.gameState.legalActions = ['fold', 'call', 'raise', 'all_in'];
  }
  const prov = s.gameState.tournament.contextProvenance;
  prov.projection.actorId = hero.user_id;
  prov.projection.actorSeat = hero.seat;
  s.requestId = 11;
  s.decisionTimeMs = 1002;
  s.fence = `${table}:123:${hero.seat}:${lease}:7`;
  s.handJournalContext = binding.captureHorseHandJournalContext([firstAction]);
  s.decisionKey = buildHorseDecisionKey(s);
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    seedFastRandom(1500923);
    second.decision = HorseLogic.decide(
      hero,
      s.gameState,
      'balanced',
      {},
      { ...s.opts, decisionTimeMs: 1002 }
    );
  } finally {
    clock.mockRestore();
  }
  expect(
    second.decision.tournamentUtility?.evidence,
    JSON.stringify({
      action: firstAction.action,
      amount: firstAction.amount,
      refusal: second.decision.tournamentUtilityRefusal,
    })
  ).toBeDefined();
  second.readFrame = encodeHorseDecisionReads(
    HorseMind.createSandbox(),
    s.gameState.players,
    HorseMind.handKeyOf(s.gameState.actionHistory)
  );
  second.decision.tournamentUtility.readFrameSha256 = second.readFrame.sha256;
  const w = witness.createHorseExecutionWitness(s, second.decision, {
    requestId: 11,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  const action: any = {
    seat: hero.seat,
    userId: hero.user_id,
    action: second.decision.action,
    amount: w.expectedExecutionAmount,
    timestamp: 1003,
    stage: 'river',
  };
  witness.settleHorseExecutionWitness(w, {
    applied: true,
    acceptedActions: [{ record: action, intended: true }],
  });
  const hand = structuredClone(fixture.hand);
  hand.actions.push({
    ...action,
    origin: 'horse_policy',
    publicNode: { version: 1, status: 'captured', actorSeat: hero.seat, street: 'river' },
    observationIdentity: {
      version: 1,
      status: 'bound',
      handId,
      actionOrdinal: 1,
      observationId: `${handId}:1`,
      sessionKey: 'd'.repeat(64),
    },
  });
  const turnKey = records.journalHash(
    JSON.stringify([s.generation, s.fence, s.requestId, s.decisionKey, s.decisionTimeMs])
  );
  const make = (kind: any, sequence: number, body: any) =>
    records.makeHorseJournalRecord(
      {
        producerId: producer,
        sequence,
        atMs: 2000,
        sourceRelease: source,
        kind,
        handKey: fixture.handKey,
        turnKey,
      },
      body
    );
  const rows = [
    fixture.rows[0],
    fixture.rows[1],
    make('decision', 3, second),
    make('execution', 4, w),
    fixture.make('accepted_hand', 5, hand),
  ];
  const input = { ...structuredClone(fixture.input), version: 2 };
  input.cases[0].actionOrdinal = 1;
  const batch = { ...fixture.batch, recordsByHand: [{ handKey: fixture.handKey, records: rows }] };
  return { input, batch, rows, make, second, w, hand };
}
it('version2 binds an exact original ordinal among multiple real P7 turns; version1 stays ambiguous', () => {
  const f = multipleP7Fixture();
  expect(review.reconcileHorseJournalHand(f.rows, fixture.handKey)).toMatchObject({
    status: 'reconciled',
    gaps: [],
    matchedActions: 2,
  });
  expect(inspectTournamentPredicateRecords(fixture.input, f.batch, api).cases[0].reason).toBe(
    'matching_decision_ambiguous'
  );
  const result = inspectTournamentPredicateRecords(f.input, f.batch, api);
  expect(result).toMatchObject({ version: 2, status: 'observed' });
  expect(result.cases[0]).toMatchObject({
    actionOrdinal: 1,
    decisionRecordSha256: f.rows[2].sha256,
  });
  const runSanitizer = (value: any) =>
    spawnSync(
      'python3',
      [
        '-B',
        '-c',
        "import json,runpy,sys; m=runpy.run_path(sys.argv[1]);d=json.loads(sys.stdin.read());\ntry: print(json.dumps(m['sanitize_tournament_result'](d['result'],d['input'])))\nexcept Exception: print('refused')",
        resolve(__dirname, '../../../../scripts/ci/inspect-tournament-refill.py'),
      ],
      { input: JSON.stringify({ result: value, input: f.input }), encoding: 'utf8' }
    );
  const sanitized = runSanitizer(result);
  expect(sanitized.status, sanitized.stderr).toBe(0);
  expect(JSON.parse(sanitized.stdout)).toEqual(result);
  for (const ordinal of [0, true, '1']) {
    const altered = structuredClone(result);
    altered.cases[0].actionOrdinal = ordinal;
    expect(runSanitizer(altered).stdout.trim()).toBe('refused');
  }

  const exact = structuredClone(f.input);
  exact.cases[0].decisionRecordSha256 = f.rows[2].sha256;
  expect(inspectTournamentPredicateRecords(exact, f.batch, api).status).toBe('observed');
  exact.cases[0].actionOrdinal = 0;
  expect(inspectTournamentPredicateRecords(exact, f.batch, api).status).toBe('unknown');
});
it('version2 refuses out-of-hand ordinals, forged same-turn identity and duplicate binding ambiguity', () => {
  const f = multipleP7Fixture(),
    input = structuredClone(f.input);
  input.cases[0].actionOrdinal = 2;
  expect(inspectTournamentPredicateRecords(input, f.batch, api).cases[0].reason).toBe(
    'original_action_ordinal_unavailable'
  );
  const w = {
    ...structuredClone(f.w),
    identity: { ...f.w.identity, requestId: f.w.identity.requestId + 1 },
  };
  const wrong = {
    ...f.batch,
    recordsByHand: [
      {
        handKey: fixture.handKey,
        records: [...f.rows.slice(0, 3), f.make('execution', 4, w), f.rows[4]],
      },
    ],
  };
  expect(inspectTournamentPredicateRecords(f.input, wrong, api).status).toBe('unknown');
  const duplicate = {
    ...f.batch,
    recordsByHand: [
      { handKey: fixture.handKey, records: [...f.rows, f.make('decision', 6, f.second)] },
    ],
  };
  expect(inspectTournamentPredicateRecords(f.input, duplicate, api).cases[0].reason).toBe(
    'matching_decision_ambiguous'
  );
});
