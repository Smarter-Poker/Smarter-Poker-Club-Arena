import { describe, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import { bindHorseObservationIdentity } from './HorseObservationIdentity.js';
import { captureHandSeatGenerations } from './handSeatGeneration.js';
import type { HorseIdentityAction } from './HorseObservationIdentity.js';
import type { HandEvent, SeatPlayer } from '../types.js';

const handId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tableId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const seatId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const joinedAt = '2026-09-12T10:00:00.123456+00:00';

function accepted() {
  const players: SeatPlayer[] = [userId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'].map((id, i) => ({
    seat: i + 1,
    user_id: id,
    username: 'private-name',
    stack: 200,
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
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    players,
    1
  );
  let event: Extract<HandEvent, { type: 'PLAYER_ACTION' }> | undefined;
  controller.onEvent((e) => {
    if (e.type === 'PLAYER_ACTION') event = e;
  });
  controller.start();
  expect(controller.performAction(1, 'call', undefined, 'player')).toBe(true);
  if (!event?.record) throw Error('accepted action missing');
  const action: HorseIdentityAction = {
    ...event.record,
    publicNode: event.publicNode,
    origin: event.origin,
  };
  const row = { user_id: userId, seat_id: seatId, seat_joined_at: joinedAt };
  const context = { handId, tableId, seatGenerations: captureHandSeatGenerations([row]) };
  return { action, context, row };
}

describe('accepted observation identity', () => {
  it('binds a real accepted controller event to an immutable hand and original ordinal', () => {
    const { action, context } = accepted();
    const identity = bindHorseObservationIdentity(action, 7, context);
    expect(identity).toMatchObject({
      version: 1,
      status: 'bound',
      handId,
      actionOrdinal: 7,
      observationId: `${handId}:7`,
      sessionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(JSON.stringify(identity)).not.toMatch(/private-name|cards|seat_joined_at/);
    expect(JSON.stringify(identity)).not.toContain(seatId);
    expect(JSON.stringify(identity)).not.toContain(joinedAt);
    expect(bindHorseObservationIdentity(action, 7, context)).toEqual(identity);
    // A fresh process can recover the identical identity from serialized hand evidence.
    expect(JSON.parse(JSON.stringify(identity))).toEqual(identity);
  });

  it('uses original action position and hand UUID, not session, for observation deduplication', () => {
    const { action, context } = accepted();
    const first = bindHorseObservationIdentity(action, 0, context);
    const next = bindHorseObservationIdentity(action, 1, context);
    const otherHand = bindHorseObservationIdentity(action, 0, {
      ...context,
      handId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    if (first.status !== 'bound' || next.status !== 'bound' || otherHand.status !== 'bound')
      throw Error('not bound');
    expect(new Set([first.observationId, next.observationId, otherHand.observationId]).size).toBe(
      3
    );
    expect(new Set([first.sessionKey, next.sessionKey, otherHand.sessionKey]).size).toBe(1);
  });

  it('keeps raw sub-millisecond session precision and the dealt generation after roster mutation', () => {
    const { action, context, row } = accepted();
    const first = bindHorseObservationIdentity(action, 0, context);
    row.seat_joined_at = '2026-09-12T10:00:00.123457+00:00';
    expect(Date.parse(row.seat_joined_at)).toBe(Date.parse(joinedAt));
    expect(bindHorseObservationIdentity(action, 0, context)).toEqual(first);
    const second = bindHorseObservationIdentity(action, 0, {
      ...context,
      seatGenerations: captureHandSeatGenerations([row]),
    });
    if (first.status !== 'bound' || second.status !== 'bound') throw Error('not bound');
    expect(second.observationId).toBe(first.observationId);
    expect(second.sessionKey).not.toBe(first.sessionKey);
  });

  it('separates actor, table and seat generation without adding those private fields to the digest record', () => {
    const { action, context } = accepted();
    const ids = [
      bindHorseObservationIdentity(action, 0, context),
      bindHorseObservationIdentity(action, 0, { ...context, tableId: handId }),
      bindHorseObservationIdentity(action, 0, {
        ...context,
        seatGenerations: captureHandSeatGenerations([
          { user_id: userId, seat_id: handId, seat_joined_at: joinedAt },
        ]),
      }),
      bindHorseObservationIdentity({ ...action, userId: handId }, 0, {
        ...context,
        seatGenerations: captureHandSeatGenerations([
          { user_id: handId, seat_id: seatId, seat_joined_at: joinedAt },
        ]),
      }),
    ];
    expect(ids.every((i) => i.status === 'bound')).toBe(true);
    expect(new Set(ids.map((i) => (i.status === 'bound' ? i.sessionKey : ''))).size).toBe(4);
    expect(
      bindHorseObservationIdentity(action, 0, {
        ...context,
        handId: handId.toUpperCase(),
        tableId: tableId.toUpperCase(),
      })
    ).toEqual(ids[0]);
  });

  it.each(['player', 'pre_action', 'horse_policy'] as const)(
    'binds voluntary %s lineage',
    (origin) => {
      const { action, context } = accepted();
      expect(bindHorseObservationIdentity({ ...action, origin }, 0, context).status).toBe('bound');
    }
  );
  it.each(['forced', 'horse_fallback', 'unknown', undefined] as const)(
    'excludes %s from voluntary lineage',
    (origin) => {
      const { action, context } = accepted();
      expect(bindHorseObservationIdentity({ ...action, origin }, 0, context)).toMatchObject({
        status: 'unavailable',
        reason: 'non_voluntary_origin',
      });
    }
  );
  it.each([undefined, '', 'invalid'])(
    'does not retrofit a missing or invalid hand UUID %s',
    (id) => {
      const { action, context } = accepted();
      expect(bindHorseObservationIdentity(action, 0, { ...context, handId: id })).toMatchObject({
        status: 'unavailable',
        reason: 'missing_hand_identity',
      });
    }
  );
  it.each([-1, 0.5, NaN, Infinity])('rejects invalid action ordinal %s', (ordinal) => {
    const { action, context } = accepted();
    expect(bindHorseObservationIdentity(action, ordinal, context).status).toBe('unavailable');
  });
  it('fails closed for missing or malformed generation and actor identity', () => {
    const { action, context } = accepted();
    expect(
      bindHorseObservationIdentity(action, 0, { ...context, seatGenerations: new Map() })
    ).toMatchObject({ reason: 'missing_seat_generation' });
    expect(
      bindHorseObservationIdentity(action, 0, {
        ...context,
        seatGenerations: new Map([[userId, { seat_id: seatId, seat_joined_at: 'invalid' }]]),
      })
    ).toMatchObject({ reason: 'invalid_seat_generation' });
    expect(
      bindHorseObservationIdentity({ ...action, userId: undefined }, 0, context)
    ).toMatchObject({ reason: 'invalid_actor_identity' });
  });
  it('excludes private discards, missing nodes and mismatched action/seat/street nodes', () => {
    const { action, context } = accepted();
    expect(
      bindHorseObservationIdentity({ ...action, publicNode: undefined }, 0, context)
    ).toMatchObject({ reason: 'unavailable_public_node' });
    expect(
      bindHorseObservationIdentity(
        {
          ...action,
          publicNode: { version: 1, status: 'unavailable', reason: 'private_discard_choice' },
        },
        0,
        context
      )
    ).toMatchObject({ reason: 'unavailable_public_node' });
    for (const change of [
      { seat: 2 },
      { stage: 'river' },
      { action: 'discard' },
      { action: 'check' },
    ]) {
      expect(bindHorseObservationIdentity({ ...action, ...change }, 0, context)).toMatchObject({
        reason: 'action_node_mismatch',
      });
    }
  });
});
