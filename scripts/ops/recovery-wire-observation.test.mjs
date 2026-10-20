import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryWireObservation, recoveryUiInPage } from './recovery-wire-observation.mjs';
import { runInNewContext } from 'node:vm';
const room = '10000000-0000-4000-8000-000000000001';
const otherRoom = '10000000-0000-4000-8000-000000000002';
const own = '10000000-0000-4000-8000-000000000003';
const opponent = '10000000-0000-4000-8000-000000000004';
const send = (observer, frame) => observer.receive(JSON.stringify(frame));
const state = {
  hand_id: own,
  stage: 'flop',
  current_player: own,
  turn_deadline_ms: 100,
  players: [
    { user_id: own, cards: [] },
    { user_id: opponent, cards: [] },
  ],
};
test('actual private owner and independent room clocks retain no card faces or raw frames', () => {
  const observer = recoveryWireObservation([room, otherRoom], own);
  send(observer, {
    type: 'USER_EVENT',
    tableId: room,
    payload: { kind: 'hole_cards', row: { table_id: room, user_id: own, cards: ['SECRET_CARD'] } },
  });
  send(observer, { type: 'SNAPSHOT', tableId: room, seq: 1, state });
  send(observer, {
    type: 'SNAPSHOT',
    tableId: otherRoom,
    seq: 7,
    state: { ...state, hand_id: opponent, turn_deadline_ms: 200 },
  });
  const summary = observer.summary();
  assert.equal(summary.rooms[0].privateOwnFrames, 1);
  assert.equal(summary.rooms[0].publicBettingSnapshots, 1);
  assert.equal(summary.rooms[0].opponentCardViolations, 0);
  assert.deepEqual(
    summary.rooms.map((r) => r.clock),
    [
      { handId: own, deadlineMs: 100 },
      { handId: opponent, deadlineMs: 200 },
    ]
  );
  assert.doesNotMatch(JSON.stringify(summary), /SECRET_CARD|cards|players|payload/);
});
test('foreign private ownership, wrong room and pre-showdown opponent cards are counted without retaining their values', () => {
  const observer = recoveryWireObservation([room], own);
  for (const frame of [
    {
      type: 'USER_EVENT',
      tableId: room,
      payload: {
        kind: 'hole_cards',
        row: { table_id: room, user_id: opponent, cards: ['SECRET'] },
      },
    },
    {
      type: 'USER_EVENT',
      tableId: otherRoom,
      payload: {
        kind: 'hole_cards',
        row: { table_id: otherRoom, user_id: own, cards: ['SECRET'] },
      },
    },
    {
      type: 'SNAPSHOT',
      tableId: room,
      seq: 1,
      state: {
        ...state,
        players: [
          { user_id: own, cards: [] },
          { user_id: opponent, cards: ['SECRET'] },
        ],
      },
    },
  ])
    send(observer, frame);
  const summary = observer.summary();
  assert.equal(summary.unexpectedRoomPrivateFrames, 1);
  assert.equal(summary.rooms[0].privateForeignFrames, 1);
  assert.equal(summary.rooms[0].opponentCardViolations, 1);
  assert.doesNotMatch(JSON.stringify(summary), /SECRET/);
});
test('showdown and clockless all-in runout are not misclassified as live hidden-card violations; absent samples stay zero', () => {
  const observer = recoveryWireObservation([room], own);
  for (const patch of [{ stage: 'showdown' }, { current_player: null, turn_deadline_ms: 0 }])
    send(observer, {
      type: 'SNAPSHOT',
      tableId: room,
      seq: 1,
      state: {
        ...state,
        ...patch,
        players: [
          { user_id: own, cards: [] },
          { user_id: opponent, cards: ['PUBLIC'] },
        ],
      },
    });
  observer.receive('INVALID_SECRET');
  const row = observer.summary().rooms[0];
  assert.equal(row.publicBettingSnapshots, 0);
  assert.equal(row.opponentCardViolations, 0);
  assert.equal(row.privateOwnFrames, 0);
});
test('a gap in room-specific deltas cannot fabricate another running clock', () => {
  const observer = recoveryWireObservation([room], own);
  send(observer, {
    type: 'DELTA',
    tableId: room,
    seq: 3,
    prev: 2,
    patch: [
      { op: 'add', path: '/hand_id', value: own },
      { op: 'add', path: '/turn_deadline_ms', value: 100 },
    ],
  });
  assert.equal(observer.summary().rooms[0].clockFrames, 0);
});
test('failure UI diagnostics expose only fixed route, layer and count classes', () => {
  const scope = {
    location: { pathname: '/hub/club-arena/lightning/SECRET' },
    document: {
      querySelectorAll: (selector) =>
        selector.includes('welcome') ? [{ getClientRects: () => [1] }] : [],
      querySelector: () => ({ getAttribute: () => 'SECRET_PROFILE' }),
    },
  };
  const result = runInNewContext('(' + recoveryUiInPage.toString() + ')()', scope);
  assert.equal(result.route, 'entry');
  assert.equal(result.layer, 'device_welcome');
  assert.equal(result.profileGate, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});
