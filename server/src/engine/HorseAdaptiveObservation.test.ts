import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandController } from './HandController.js';
import { bindHorseObservationIdentity } from './HorseObservationIdentity.js';
import { captureHandSeatGenerations } from './handSeatGeneration.js';
import {
  qualifyAdaptiveHand,
  adaptiveSessionPartition,
  ADAPTIVE_OBSERVATION_HORIZON_MS,
} from './HorseAdaptiveObservation.js';
import type { CompletedHandObservation } from './horseDecision/protocol.js';
import type { HandConfig, SeatPlayer } from '../types.js';
import type { HorsePublicActionNode } from './HorsePublicActionNode.js';
import type { TournamentBrainContext } from '../services/TournamentBrainContext.js';

const NOW = Date.UTC(2026, 8, 12, 17);
const handId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tableId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ids = ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'];
type Node = Extract<HorsePublicActionNode, { status: 'captured' }>;
type MutableNode = { -readonly [K in keyof Node]: Node[K] };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
afterEach(() => vi.restoreAllMocks());

function hand(
  config: Partial<HandConfig> = {},
  whole = false,
  allInStack?: number,
  bigBlindOptionShove = false
): CompletedHandObservation {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const actions: NonNullable<CompletedHandObservation['actions']> = [];
  let completed = false;
  const seats: SeatPlayer[] = ids.map((user_id, i) => ({
    seat: i + 1,
    user_id,
    username: 'private-name',
    stack: allInStack ?? 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  const controller = new HandController(
    {
      tableId,
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true },
      ...config,
    },
    seats,
    1,
    config.isTournament
      ? () => ({
          status: 'complete',
          issues: [],
          ageMs: 5,
          context: {
            schemaVersion: 1,
            contextStatus: 'complete',
            contextIssues: [],
            format: 'mtt',
            entrants: 60,
            playersLeft: 4,
            spotsPaid: 3,
            seatsPerTable: 9,
            currentLevel: 5,
            currentSmallBlind: 1,
            currentBigBlind: 2,
            currentAnte: 0,
            anteType: 'per_player',
            inMoney: false,
            nearBubble: true,
            finalTable: true,
            handForHandExpected: true,
            onBreak: false,
            registrationOpen: false,
            lateRegistrationOpen: false,
            reentryOpen: false,
            rebuyOpen: false,
            addOnPeriodOpen: false,
            isPko: false,
            isBounty: false,
            isMysteryBounty: false,
            mysteryBountyStage: 'none',
            satellite: false,
            satelliteSeats: 0,
          } as unknown as TournamentBrainContext,
        })
      : undefined
  );
  const seatGenerations = captureHandSeatGenerations(
    ids.map((user_id) => ({
      user_id,
      seat_id: user_id,
      seat_joined_at: '2026-09-12T10:00:00.123456+00:00',
    }))
  );
  controller.onEvent((event) => {
    if (event.type === 'HAND_COMPLETE') completed = true;
    if (event.type === 'FORCED_BETS_POSTED')
      for (const p of event.postings)
        actions.push({
          userId: p.userId,
          action: p.kind,
          amount: p.amount,
          stage: 'preflop',
          timestamp: NOW,
        });
    if (event.type === 'PLAYER_ACTION' && event.record) {
      const action = { ...event.record, publicNode: event.publicNode, origin: event.origin };
      actions.push({
        ...action,
        observationIdentity: bindHorseObservationIdentity(action, actions.length, {
          handId,
          tableId,
          seatGenerations,
        }),
      });
    }
  });
  controller.start();
  for (let n = 0; n < 100; n++) {
    const state = controller.getState();
    if (completed || ['complete', 'showdown'].includes(state.stage)) break;
    if (state.stage === 'pineapple_discard') {
      for (const player of state.players.filter(
        (p) => !p.is_folded && !p.is_all_in && p.cards.length === 3
      ))
        expect(controller.performDiscard(player.seat, 0)).toBe(true);
      controller.flushPineappleSettle();
      continue;
    }
    const actor = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
    const rights = controller.getAuthoritativeActionState(actor.user_id)!;
    const shove = bigBlindOptionShove ? n === 1 : allInStack !== undefined;
    const action = shove
      ? 'all_in'
      : rights.legalActions.includes('check')
        ? 'check'
        : rights.legalActions.includes('call')
          ? 'call'
          : 'all_in';
    expect(controller.performAction(actor.seat, action, undefined, 'player')).toBe(true);
    if (bigBlindOptionShove && n === 1) break;
    if (!whole) break;
  }
  if (whole && !bigBlindOptionShove) expect(completed).toBe(true);
  return {
    handKey: tableId + ':1',
    committedHandId: handId,
    generation: 1,
    fence: 'accepted',
    actions,
    bigBlind: 2,
  };
}
function first(h: CompletedHandObservation) {
  return h.actions!.find((a) => a.publicNode?.status === 'captured')!;
}
function qualified(h: CompletedHandObservation) {
  const result = qualifyAdaptiveHand(h, NOW);
  expect(result.observations.length, JSON.stringify(result.rejected)).toBeGreaterThan(0);
  return result.observations[0];
}

describe('qualified adaptive observations', () => {
  it('uses a real committed controller action after original forced-money ordinals', () => {
    const h = hand(),
      q = qualified(h);
    expect(h.actions!.slice(0, 2).map((a) => a.action)).toEqual(['sb', 'bb']);
    expect(q).toMatchObject({
      handId,
      observationId: handId + ':2',
      action: 'call',
      facedBet: true,
      origin: 'player',
      observedAtMs: NOW,
    });
    expect(q.scopeKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(q)).not.toMatch(/private-name|cards|cccccccc|dddddddd|seat_joined_at/);
    expect(qualifyAdaptiveHand(clone(h), NOW)).toEqual(qualifyAdaptiveHand(h, NOW));
    expect(qualifyAdaptiveHand(h, NOW + 1000).observations).toEqual(
      qualifyAdaptiveHand(h, NOW).observations
    );
  });
  it.each([
    'nlh',
    'flh',
    'flo8',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'pineapple',
    'short_deck',
  ] as const)(
    'qualifies real %s action history through every betting street without using discards',
    (variant) => {
      const h = hand({ gameVariant: variant }, true),
        result = qualifyAdaptiveHand(h, NOW);
      expect(new Set(result.observations.map((q) => q.scope[13]))).toEqual(
        new Set(['preflop', 'flop', 'turn', 'river'])
      );
      expect(result.observations.every((q) => q.action === 'call' || q.action === 'check')).toBe(
        true
      );
      expect(Object.keys(result.rejected)).toEqual(['non_betting_action']);
    }
  );
  it('preserves private exclusions and physical double-board history in a bomb pot', () => {
    const h = hand({ bombPot: { anteMultiplier: 2, doubleBoard: true } }, true);
    const result = qualifyAdaptiveHand(h, NOW);
    expect(result.observations.length).toBe(6);
    expect(result.observations.every((q) => q.scope[14] === true && q.scope[16] === 2)).toBe(true);
    expect(Object.keys(result.rejected)).toEqual(['non_betting_action']);
  });
  it('never reads extra private fields, and freezes all retained scope arrays', () => {
    const h = clone(hand()),
      node = first(h).publicNode as Node;
    Object.defineProperty(node, 'privateCards', {
      get() {
        throw Error('private cards read');
      },
    });
    Object.defineProperty(h, 'showdown', {
      get() {
        throw Error('outcome read');
      },
    });
    const q = qualified(h);
    const frozen = (v: unknown) => {
      if (Array.isArray(v)) {
        expect(Object.isFrozen(v)).toBe(true);
        v.forEach(frozen);
      }
    };
    expect(Object.isFrozen(q)).toBe(true);
    frozen(q.scope);
  });
  it.each(['forced', 'horse_fallback', 'unknown', undefined] as const)(
    'excludes %s from model evidence',
    (origin) => {
      const h = hand();
      first(h).origin = origin;
      expect(qualifyAdaptiveHand(h, NOW)).toMatchObject({
        observations: [],
        rejected: { non_voluntary: 1 },
      });
    }
  );
  it('retains a separate self-policy label without changing the public node or session split', () => {
    const h = hand(),
      human = qualified(h);
    first(h).origin = 'horse_policy';
    expect(qualified(h)).toEqual({ ...human, origin: 'horse_policy' });
  });
  it('splits by session before seeing any action and keeps it stable across restarts', () => {
    expect(adaptiveSessionPartition('00000000' + 'a'.repeat(56))).toBe('holdout');
    expect(adaptiveSessionPartition('00000001' + 'b'.repeat(56))).toBe('training');
    const h = hand(),
      q = qualified(h),
      changed = clone(h);
    first(changed).action = 'fold';
    expect(qualified(changed)).toMatchObject({
      partition: q.partition,
      scopeKey: q.scopeKey,
      action: 'fold',
    });
    expect(() => adaptiveSessionPartition('invalid')).toThrow();
  });
  it.each([undefined, '', 'invalid', tableId])(
    'rejects missing or mismatched accepted receipt UUID %s',
    (committedHandId) => {
      const h = hand();
      h.committedHandId = committedHandId;
      expect(qualifyAdaptiveHand(h, NOW).observations).toEqual([]);
    }
  );
  it.each(['observationId', 'handId', 'actionOrdinal', 'sessionKey'] as const)(
    'rejects corrupted immutable %s',
    (field) => {
      const h = clone(hand());
      (first(h).observationIdentity as any)[field] = 'wrong';
      expect(qualifyAdaptiveHand(h, NOW)).toMatchObject({
        observations: [],
        rejected: { invalid_identity: 1 },
      });
    }
  );
  it.each([undefined, NaN, Infinity, NOW + 5001, NOW - ADAPTIVE_OBSERVATION_HORIZON_MS - 1])(
    'excludes missing, invalid or stale timestamp %s',
    (timestamp) => {
      const h = hand();
      first(h).timestamp = timestamp;
      expect(qualifyAdaptiveHand(h, NOW)).toMatchObject({
        observations: [],
        rejected: { invalid_or_stale_time: 1 },
      });
    }
  );
  it.each([
    { legalActions: null },
    { seats: [null, null] },
    { seats: [] },
    { chipUnit: 1 },
    { variant: 'unknown' },
    { actorSeat: 9 },
    { dealerSeat: 9 },
    { bigBlind: 0 },
    { toCall: NaN },
    { boardCount: 10000 },
    { boards: ['As'] },
    { street: 'turn', boards: ['AsAs2c3d'] },
    { allInOrFold: null },
  ])('rejects malformed persisted public nodes without crashing %#', (patch) => {
    const h = clone(hand());
    Object.assign(first(h).publicNode!, patch);
    expect(() => qualifyAdaptiveHand(h, NOW)).not.toThrow();
    expect(qualifyAdaptiveHand(h, NOW).observations).toEqual([]);
  });

  it.each([null, 0, 2, 1.5])(
    'rejects persisted actor-seat disagreement and excludes the dependent public line (%s)',
    (seat) => {
      const h = clone(hand({}, true));
      // Keep the previously bound hand/session identity: read-side validation
      // must not treat it as proof that the action still matches its node.
      Object.assign(first(h), { seat });
      const result = qualifyAdaptiveHand(h, NOW);
      expect(result.observations).toEqual([]);
      expect(result.rejected.unavailable_public_node).toBe(1);
      expect(result.rejected.unavailable_public_line).toBeGreaterThan(0);
    }
  );
  it('resolves an absent seat from the seat this userId provably acted from', () => {
    // The committed snapshot RPC projects no seat column. The whole hand
    // still qualifies exactly as the seat-carrying replay does.
    const seated = hand({}, true),
      h = clone(seated);
    for (const action of h.actions!) delete action.seat;
    expect(qualifyAdaptiveHand(h, NOW)).toEqual(qualifyAdaptiveHand(seated, NOW));
    expect(qualifyAdaptiveHand(h, NOW).observations.length).toBeGreaterThan(1);
  });
  it("rejects an absent seat when the userId is another seat's actor", () => {
    const h = clone(hand({}, true));
    for (const action of h.actions!) delete action.seat;
    // The first voluntary action now claims the other player's identity: one
    // userId at two seats voids every ownership the hand could prove.
    first(h).userId = ids[1];
    const result = qualifyAdaptiveHand(h, NOW);
    expect(result.observations).toEqual([]);
    expect(result.rejected.unavailable_public_node).toBeGreaterThan(0);
  });
  it.each([
    undefined,
    null,
    { version: 1, status: 'captured', rules: 'controller-rake-bbj-v1', rake: null },
  ])('rejects unavailable or malformed deduction rules %#', (deductions) => {
    const h = clone(hand());
    (first(h).publicNode as any).deductions = deductions;
    expect(qualifyAdaptiveHand(h, NOW)).toMatchObject({
      observations: [],
      rejected: { unavailable_scope: 1 },
    });
  });
  it('rejects missing tournament stage rather than pooling it into cash', () => {
    const h = clone(hand({ isTournament: true }));
    delete (first(h).publicNode as MutableNode).tournamentStage;
    expect(qualifyAdaptiveHand(h, NOW)).toMatchObject({
      observations: [],
      rejected: { unavailable_scope: 1 },
    });
  });
  it.each([
    'nlh',
    'flh',
    'flo8',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'pineapple',
    'short_deck',
  ] as const)(
    'preserves captured tournament stage on real %s actions through all betting streets',
    (gameVariant) => {
      const h = hand({ gameVariant, isTournament: true }, true),
        result = qualifyAdaptiveHand(h, NOW);
      expect(new Set(result.observations.map((q) => q.scope[13]))).toEqual(
        new Set(['preflop', 'flop', 'turn', 'river'])
      );
      expect(result.observations.every((q) => q.scope[9] === 'tournament')).toBe(true);
      expect(Object.keys(result.rejected)).toEqual(['non_betting_action']);
    }
  );
  it('isolates field, bubble, level and registration stage without retaining cache age or private state', () => {
    const h = clone(hand({ isTournament: true })),
      base = qualified(h);
    for (const patch of [
      { format: 'sng' },
      { currentLevel: 6 },
      { playersLeft: 3 },
      { entrants: 80 },
      { seatsPerTable: 6 },
      { spotsPaid: 4 },
      { nearBubble: false },
      { registrationOpen: true },
      { isPko: true },
    ]) {
      const changed = clone(h);
      Object.assign((first(changed).publicNode as any).tournamentStage, patch);
      expect(qualified(changed).scopeKey).not.toBe(base.scopeKey);
    }
    (first(h).publicNode as any).tournamentStage.ageMs = 15;
    expect(qualified(h).scopeKey).toBe(base.scopeKey);
    (first(h).publicNode as any).tournamentStage.ageMs = 60_001;
    expect(qualifyAdaptiveHand(h, NOW).observations).toEqual([]);
  });
  it.each([
    [2, {}, 'call'],
    [200, {}, 'raise'],
    [200, { bombPot: { anteMultiplier: 2 } }, 'bet'],
  ] as const)(
    'classifies a real all-in with stack %s and context %j as %s',
    (stack, config, action) => {
      expect(qualified(hand(config, false, stack)).action).toBe(action);
    }
  );
  it.each(
    (
      ['nlh', 'flh', 'flo8', 'plo4', 'plo5', 'plo6', 'plo8', 'pineapple', 'short_deck'] as const
    ).flatMap((gameVariant) => [false, true].map((isTournament) => ({ gameVariant, isTournament })))
  )(
    'classifies the real $gameVariant big-blind option all-in as a raise (tournament=$isTournament)',
    ({ gameVariant, isTournament }) => {
      const h = hand({ gameVariant, isTournament }, true, 4, true);
      const ordinal = h.actions!.findIndex((a) => a.action === 'all_in');
      const node = h.actions![ordinal].publicNode as Node;
      expect(node.actorSeat).toBe(2);
      expect(node.currentBet).toBe(2);
      expect(node.toCall).toBe(0);
      const observation = qualifyAdaptiveHand(h, NOW).observations.find(
        (o) => o.observationId === handId + ':' + ordinal
      );
      expect(observation?.action).toBe('raise');
    }
  );
  it('cannot relabel a changed variant or roster as the same public hand history', () => {
    const h = clone(hand({}, true)),
      a = h.actions!.filter((a) => a.publicNode?.status === 'captured');
    (a[1].publicNode as MutableNode).variant = 'plo4';
    const result = qualifyAdaptiveHand(h, NOW);
    expect(result.observations.map((q) => q.observationId)).toEqual([handId + ':2']);
    expect(result.rejected.unavailable_public_node).toBe(1);
    expect(result.rejected.unavailable_public_line).toBeGreaterThan(0);
  });
  it('isolates stakes, rake, ante mode, position, seat count and wagering rights', () => {
    const h = clone(hand()),
      base = qualified(h).scopeKey;
    const edits: Array<(n: MutableNode) => void> = [
      (n) => {
        n.bigBlind = 3;
      },
      (n) => {
        n.ante = 1;
      },
      (n) => {
        n.anteType = 'big_blind';
      },
      (n) => {
        n.dealerSeat = 2;
      },
      (n) => {
        n.seats = [...n.seats, [3, 200, 0, 0, 0, 0, 0]];
      },
      (n) => {
        n.allInOrFold = true;
      },
      (n) => {
        n.wagersCapped = true;
      },
      (n) => {
        (n.deductions as any).rake.percent = 1;
      },
      (n) => {
        (n.deductions as any).rake.playerCountCaps = [[2, 1]];
      },
    ];
    for (const edit of edits) {
      const changed = clone(h);
      edit(first(changed).publicNode as Node);
      expect(qualified(changed).scopeKey).not.toBe(base);
    }
    expect(qualified(h).scopeKey).toBe(base);
  });
  it('retains forced public action history while excluding its outcome from learning', () => {
    const h = hand({}, true),
      before = qualifyAdaptiveHand(h, NOW);
    first(h).origin = 'forced';
    const after = qualifyAdaptiveHand(h, NOW);
    expect(after.observations).toEqual(before.observations.slice(1));
  });
  it('does not fabricate an empty line after a malformed previous action', () => {
    const h = hand({}, true);
    first(h).publicNode = undefined;
    const result = qualifyAdaptiveHand(h, NOW);
    expect(result.observations).toEqual([]);
    expect(result.rejected.unavailable_public_line).toBeGreaterThan(0);
  });
  it('rejects malformed action arrays and bounds work before iterating oversized input', () => {
    const h = hand();
    h.actions = [null as never, ...h.actions!];
    expect(() => qualifyAdaptiveHand(h, NOW)).not.toThrow();
    expect(qualifyAdaptiveHand(h, NOW).observations).toEqual([]);
    h.actions = new Array(4097);
    expect(qualifyAdaptiveHand(h, NOW)).toEqual({
      observations: [],
      rejected: { invalid_or_oversized_hand: 1 },
    });
  });
});
