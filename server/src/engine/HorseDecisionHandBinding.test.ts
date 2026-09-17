import { describe, expect, it } from 'vitest';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
} from './HorseExecutionWitness.js';
import {
  anchorHorseDecisionHand,
  bindHorseDecisionToCommittedHand,
  captureHorseHandJournalContext,
  horsePriorActionsDigest,
  horseCompletedHandKey,
} from './HorseDecisionHandBinding.js';
import { HorseCommittedDecisionTracker } from './HorseCommittedDecisionTracker.js';
import { bindHorseObservationIdentity } from './HorseObservationIdentity.js';
import {
  buildHorseDecisionKey,
  validatedHorsePolicySamplingKey,
  type CompletedHandObservation,
  type LiveHorseDecisionSnapshot,
} from './horseDecision/protocol.js';

const TABLE = '10000000-0000-4000-8000-000000000001';
const HORSE = '20000000-0000-4000-8000-000000000001';
const HAND = '30000000-0000-4000-8000-000000000001';
const prefix = [
  {
    seat: 1,
    userId: HORSE,
    action: 'ante',
    amount: 1,
    timestamp: 100,
    stage: 'preflop',
    dead: true,
  },
  {
    seat: 1,
    userId: HORSE,
    action: 'sb',
    amount: 1,
    timestamp: 101,
    stage: 'preflop',
    dead: false,
  },
  {
    seat: 2,
    userId: TABLE,
    action: 'bb',
    amount: 2,
    timestamp: 102,
    stage: 'preflop',
    dead: false,
  },
];

function fixture() {
  const snapshot = {
    generation: 7,
    fence: `${TABLE}:12:1:99:7`,
    decisionTimeMs: 1000,
    player: { seat: 1, user_id: HORSE, stack: 100, bet: 1 },
    gameState: {
      stage: 'preflop',
      gameVariant: 'nlh',
      gameMode: 'cash',
      actionHistory: [],
      toCall: 1,
    },
    handJournalContext: captureHorseHandJournalContext(prefix),
  } as unknown as LiveHorseDecisionSnapshot;
  snapshot.decisionKey = buildHorseDecisionKey(snapshot);
  const witness = createHorseExecutionWitness(
    snapshot,
    { action: 'call', thinkTime: 100 },
    {
      requestId: 8,
      lane: 'fast',
      computeMs: 1,
      governorScale: 1,
    }
  );
  const record = {
    seat: 1,
    userId: HORSE,
    action: 'call' as const,
    amount: 1,
    timestamp: 1001,
    stage: 'preflop' as const,
  };
  settleHorseExecutionWitness(witness, {
    applied: true,
    acceptedActions: [{ record, intended: true }],
  });
  const node = {
    version: 1,
    status: 'captured',
    actorSeat: 1,
    street: 'preflop',
    legalActions: ['call'],
  } as const;
  const identity = bindHorseObservationIdentity(
    { ...record, publicNode: node as never, origin: 'horse_policy' },
    3,
    {
      handId: HAND,
      tableId: TABLE,
      seatGenerations: new Map([
        [HORSE, { seat_id: HORSE, seat_joined_at: '2026-09-14T12:00:00.000Z' }],
      ]) as never,
    }
  );
  expect(identity.status).toBe('bound');
  const observation: CompletedHandObservation = {
    generation: 12,
    fence: `${TABLE}:12:99:observe`,
    handKey: `${TABLE}:12`,
    committedHandId: HAND,
    bigBlind: 2,
    actions: [
      ...structuredClone(prefix),
      {
        ...record,
        publicNode: node as never,
        origin: 'horse_policy',
        observationIdentity: identity,
      },
    ],
  };
  return { snapshot, witness, observation, record };
}

describe('canonical accepted-hand decision binding', () => {
  it.each(['50000000-0000-4000-8000-000000000001', 'ABCDEF12-3456-4789-ABCD-0123456789AB'])(
    'binds the exact current UUID lease %s without changing original fence or sampling bytes',
    (generation) => {
      const { snapshot, observation, record } = fixture();
      snapshot.fence = `${TABLE}:12:1:${generation}:7`;
      observation.fence = `${TABLE}:12:${generation}:observe`;
      const before = JSON.stringify(snapshot),
        sampling = validatedHorsePolicySamplingKey(snapshot);
      const witness = createHorseExecutionWitness(
        snapshot,
        { action: 'call', thinkTime: 100 },
        { requestId: 8, lane: 'fast', computeMs: 1, governorScale: 1 }
      );
      settleHorseExecutionWitness(witness, {
        applied: true,
        acceptedActions: [{ record, intended: true }],
      });
      expect(anchorHorseDecisionHand(snapshot)).toMatchObject({
        status: 'anchored',
        leaseGeneration: generation,
      });
      expect(horseCompletedHandKey(observation)).toBe(`${TABLE}:12:${generation}`);
      expect(bindHorseDecisionToCommittedHand(witness, observation)).toMatchObject({
        status: 'bound',
        committedHandId: HAND,
      });
      expect(JSON.stringify(snapshot)).toBe(before);
      expect(validatedHorsePolicySamplingKey(snapshot)).toBe(sampling);
    }
  );
  it.each([1, 9, 10])('retains canonical seat %i in action prefixes and turn anchors', (seat) => {
    const { snapshot } = fixture();
    const actions = prefix.map((action) => ({ ...action, seat }));
    expect(horsePriorActionsDigest(actions)).toMatch(/^[0-9a-f]{64}$/);
    snapshot.player.seat = seat;
    snapshot.fence = `${TABLE}:12:${seat}:99:7`;
    snapshot.handJournalContext = captureHorseHandJournalContext(actions)!;
    expect(anchorHorseDecisionHand(snapshot)).toMatchObject({ status: 'anchored', seat });
  });
  it.each([0, -1, 11, 1.5])('refuses noncanonical seat %i', (seat) => {
    const { snapshot } = fixture();
    expect(horsePriorActionsDigest([{ ...prefix[0], seat }])).toBeNull();
    snapshot.player.seat = seat;
    snapshot.fence = `${TABLE}:12:${seat}:99:7`;
    expect(anchorHorseDecisionHand(snapshot)).toEqual({
      status: 'unavailable',
      reason: 'invalid_turn_identity',
    });
  });
  it('uses the unfiltered accepted-history ordinal including posts and antes', () => {
    const { witness, observation } = fixture();
    expect(witness.handAnchor).toMatchObject({ status: 'anchored', actionOrdinal: 3 });
    expect(bindHorseDecisionToCommittedHand(witness, observation)).toMatchObject({
      status: 'bound',
      committedHandId: HAND,
      observationId: `${HAND}:3`,
      actionOrdinal: 3,
    });
  });
  it('retains immutable controller actor/time/raise facts through executor settlement', () => {
    const { witness, record } = fixture();
    record.timestamp = 9999;
    record.userId = TABLE;
    expect(witness.acceptedActions[0]!.record).toMatchObject({ userId: HORSE, timestamp: 1001 });
  });
  it('binds audit input while preserving the exact prior strategy sampling key', () => {
    const { snapshot } = fixture();
    const without = { ...snapshot, handJournalContext: undefined };
    const original = buildHorseDecisionKey(without);
    expect(snapshot.decisionKey).not.toBe(original);
    expect(validatedHorsePolicySamplingKey(snapshot)).toBe(original);
    const altered = {
      ...snapshot,
      handJournalContext: { ...snapshot.handJournalContext!, actionCount: 4 },
    };
    expect(buildHorseDecisionKey(altered)).not.toBe(snapshot.decisionKey);
    altered.decisionKey = buildHorseDecisionKey(altered);
    expect(validatedHorsePolicySamplingKey(altered)).toBe(original);
  });
  it.each([
    'unverified',
    '0',
    '-1',
    '1.5',
    '01',
    '9223372036854775808',
    '00000000-0000-0000-0000-000000000000',
    '50000000-0000-6000-8000-000000000001',
    '50000000-0000-4000-7000-000000000001',
    ' 50000000-0000-4000-8000-000000000001',
  ])('refuses invalid lease %s', (lease) => {
    const { snapshot } = fixture();
    snapshot.fence = `${TABLE}:12:1:${lease}:7`;
    expect(anchorHorseDecisionHand(snapshot)).toEqual({
      status: 'unavailable',
      reason: 'invalid_turn_identity',
    });
  });
  it.each([
    'wrong_table',
    'wrong_hand',
    'wrong_lease',
    'wrong_generation',
    'wrong_hand_key',
    'missing_uuid',
    'short_prefix',
    'changed_prefix',
    'changed_dead_money',
    'changed_accepted_amount',
    'changed_accepted_time',
    'changed_actor',
    'changed_raise_flag',
    'missing_action_identity',
    'wrong_ordinal',
    'wrong_session',
    'wrong_hand_identity',
    'forced_origin',
    'wrong_public_actor',
    'pending_execution',
    'fallback_execution',
    'extra_execution',
    'missing_controller_time',
    'missing_controller_actor',
  ])('refuses %s instead of guessing a canonical action', (change) => {
    const { witness, observation } = fixture();
    const action = observation.actions![3]!;
    switch (change) {
      case 'wrong_table':
        observation.fence = `${HAND}:12:99:observe`;
        observation.handKey = `${HAND}:12`;
        break;
      case 'wrong_hand':
        observation.fence = `${TABLE}:13:99:observe`;
        observation.handKey = `${TABLE}:13`;
        observation.generation = 13;
        break;
      case 'wrong_lease':
        observation.fence = `${TABLE}:12:100:observe`;
        break;
      case 'wrong_generation':
        observation.generation++;
        break;
      case 'wrong_hand_key':
        observation.handKey = 'wrong';
        break;
      case 'missing_uuid':
        delete observation.committedHandId;
        break;
      case 'short_prefix':
        observation.actions = observation.actions!.slice(1);
        break;
      case 'changed_prefix':
        observation.actions![0]!.amount = 2;
        break;
      case 'changed_dead_money':
        (observation.actions![0] as any).dead = false;
        break;
      case 'changed_accepted_amount':
        action.amount = 2;
        break;
      case 'changed_accepted_time':
        action.timestamp = 1002;
        break;
      case 'changed_actor':
        action.userId = TABLE;
        break;
      case 'changed_raise_flag':
        action.isFullRaise = false;
        break;
      case 'missing_action_identity':
        delete action.observationIdentity;
        break;
      case 'wrong_ordinal':
        action.observationIdentity = { ...action.observationIdentity, actionOrdinal: 0 } as never;
        break;
      case 'wrong_session':
        action.observationIdentity = { ...action.observationIdentity, sessionKey: '' } as never;
        break;
      case 'wrong_hand_identity':
        action.observationIdentity = { ...action.observationIdentity, handId: TABLE } as never;
        break;
      case 'forced_origin':
        action.origin = 'forced';
        break;
      case 'wrong_public_actor':
        action.publicNode = { ...action.publicNode, actorSeat: 2 } as never;
        break;
      case 'pending_execution':
        witness.executionStatus = 'pending';
        break;
      case 'fallback_execution':
        witness.executionStatus = 'fallback';
        break;
      case 'extra_execution':
        witness.acceptedActions.push(witness.acceptedActions[0]!);
        break;
      case 'missing_controller_time':
        delete (witness.acceptedActions[0]!.record as any).timestamp;
        break;
      case 'missing_controller_actor':
        delete (witness.acceptedActions[0]!.record as any).userId;
        break;
    }
    expect(bindHorseDecisionToCommittedHand(witness, observation).status).toBe('unavailable');
  });
  it('allows a coerced wager to bind its actual action without relabelling it intended', () => {
    const { witness, observation } = fixture();
    witness.executionStatus = 'coerced';
    expect(bindHorseDecisionToCommittedHand(witness, observation).status).toBe('bound');
    expect(witness.executionStatus).toBe('coerced');
  });
  it('binds multiple decisions to different ordinals in the same accepted hand', () => {
    const { snapshot, witness, observation } = fixture();
    const record = {
      seat: 1,
      userId: HORSE,
      action: 'check' as const,
      amount: 0,
      timestamp: 2000,
      stage: 'flop' as const,
    };
    const other = createHorseExecutionWitness(
      {
        ...snapshot,
        handJournalContext: captureHorseHandJournalContext(observation.actions!),
        gameState: { ...snapshot.gameState, stage: 'flop' },
      },
      { action: 'check', thinkTime: 100 },
      { requestId: 9, lane: 'fast', computeMs: 1, governorScale: 1 }
    );
    settleHorseExecutionWitness(other, {
      applied: true,
      acceptedActions: [{ record, intended: true }],
    });
    observation.actions!.push({
      ...record,
      origin: 'horse_policy',
      publicNode: { ...observation.actions![3]!.publicNode, street: 'flop' } as never,
      observationIdentity: {
        ...observation.actions![3]!.observationIdentity,
        actionOrdinal: 4,
        observationId: `${HAND}:4`,
      } as never,
    });
    expect(bindHorseDecisionToCommittedHand(witness, observation)).toMatchObject({
      status: 'bound',
      actionOrdinal: 3,
    });
    expect(bindHorseDecisionToCommittedHand(other, observation)).toMatchObject({
      status: 'bound',
      actionOrdinal: 4,
    });
  });
  it('preserves unavailable history instead of inventing an empty line', () => {
    const { snapshot } = fixture();
    delete snapshot.handJournalContext;
    expect(anchorHorseDecisionHand(snapshot)).toEqual({
      status: 'unavailable',
      reason: 'missing_prior_actions',
    });
    expect(horsePriorActionsDigest([{ ...prefix[0], amount: NaN }])).toBeNull();
    expect(horsePriorActionsDigest(Array(4097).fill(prefix[0]))).toBeNull();
  });
});

describe('actual client receipt retention boundaries', () => {
  it('refuses competing executed decisions for the same committed action', () => {
    const first = fixture(),
      second = fixture(),
      third = fixture();
    const notes: string[] = [];
    const tracker = new HorseCommittedDecisionTracker({ note: (x) => notes.push(x) });
    tracker.track(first.witness);
    tracker.track(second.witness);
    tracker.observe(first.observation);
    expect(first.witness.committedHand).toEqual({
      status: 'unavailable',
      reason: 'multiple_decisions_for_action',
    });
    expect(second.witness.committedHand).toEqual(first.witness.committedHand);
    expect(notes).not.toContain('phase15_hand_binding_bound');
    tracker.track(third.witness);
    tracker.observe(first.observation);
    expect(third.witness.committedHand).toEqual(first.witness.committedHand);
  });
  it('deduplicates replay and makes contradictory committed identities terminal', () => {
    const notes: string[] = [],
      { witness, observation } = fixture();
    const tracker = new HorseCommittedDecisionTracker({ note: (x) => notes.push(x) });
    tracker.track(witness);
    tracker.observe(observation);
    tracker.observe(structuredClone(observation));
    expect(notes).toEqual(['phase15_hand_binding_bound']);
    const conflict = structuredClone(observation);
    conflict.committedHandId = TABLE;
    conflict.actions![3]!.observationIdentity = {
      ...conflict.actions![3]!.observationIdentity,
      handId: TABLE,
      observationId: `${TABLE}:3`,
    } as never;
    tracker.observe(conflict);
    tracker.observe(observation);
    expect(witness.committedHand).toEqual({
      status: 'unavailable',
      reason: 'committed_identity_conflict',
    });
    expect(notes).toEqual([
      'phase15_hand_binding_bound',
      'phase15_hand_binding_committed_identity_conflict',
    ]);
  });
  it.each(['capacity', 'expired'])(
    'makes %s eviction explicit and cannot late-bind an evicted receipt',
    (mode) => {
      let now = 0;
      const { witness, observation } = fixture();
      const tracker = new HorseCommittedDecisionTracker({
        now: () => now,
        note: () => {},
        maxEntries: 1,
        ttlMs: 10,
      });
      tracker.track(witness);
      if (mode === 'capacity') tracker.track(fixture().witness);
      else {
        now = 10;
        tracker.observe(observation);
      }
      tracker.observe(observation);
      expect(witness.committedHand).toEqual({
        status: 'unavailable',
        reason: mode === 'capacity' ? 'tracking_capacity' : 'tracking_expired',
      });
    }
  );
  it('keeps pending execution unavailable and permits a later exact observation after settlement', () => {
    const { witness, observation } = fixture();
    const tracker = new HorseCommittedDecisionTracker({
      note: () => {
        throw Error('counter unavailable');
      },
    });
    witness.executionStatus = 'pending';
    tracker.track(witness);
    tracker.observe(observation);
    expect(witness.committedHand.status).toBe('unavailable');
    witness.executionStatus = 'intended';
    tracker.observe(observation);
    expect(witness.committedHand.status).toBe('bound');
  });
});
