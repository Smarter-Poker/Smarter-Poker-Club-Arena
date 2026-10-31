import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectPlayerUIWire } from './tournament-player-ui-wire.mjs';
import {
  verifyPreActionUI,
  verifyPaidRebuyReturn,
  verifyFinishReport,
  requireCompletePlayerUICoverage,
  requiredPlayerUIFlows,
} from './tournament-player-ui-evidence.mjs';
import {
  validateTournamentRead,
  tournamentObservationBinding,
} from '../../native/tournament-player-observations.mjs';
const id = (n) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function preaction(choice = 'call_amount') {
  return {
    choice,
    tableId: id(1),
    userId: id(2),
    handNumber: 7,
    clickAt: 100,
    request: {
      method: 'POST',
      pathname: '/preaction',
      body: { tableId: id(1), action: choice === 'call_any' ? 'auto_call_any' : 'auto_call' },
      at: 101,
    },
    response: { status: 200, body: { success: true, armedToCall: 4 } },
    armed: {
      kind: 'pre_action',
      action: choice === 'call_any' ? 'auto_call_any' : 'auto_call',
      hand_number: 7,
      to_call_at_set: 4,
    },
    calls: [
      {
        tableId: id(1),
        user_id: id(2),
        hand_number: 7,
        action: 'call',
        receivedAt: 102,
        amount: 4,
      },
    ],
    directActions: [],
  };
}
test('preaction needs actual accepted same-hand same-player call and never direct input', () => {
  for (const choice of ['call_any', 'call_amount'])
    assert.equal(verifyPreActionUI(preaction(choice)).amount, 4);
  for (const mutate of [
    (x) => (x.calls = []),
    (x) => x.calls.push({ ...x.calls[0] }),
    (x) => x.calls[0].hand_number++,
    (x) => (x.calls[0].user_id = id(8)),
    (x) => (x.calls[0].replayed = true),
    (x) => x.directActions.push({}),
    (x) => (x.calls[0].amount = 5),
    (x) => (x.response.body.success = false),
  ]) {
    const value = preaction();
    mutate(value);
    assert.throws(() => verifyPreActionUI(value));
  }
});
function rebuy() {
  return {
    tournamentId: id(3),
    userId: id(2),
    request: {
      method: 'POST',
      pathname: '/rest/v1/rpc/process_tournament_rebuy',
      body: {
        p_tournament_id: id(3),
        p_user_id: id(2),
        p_rebuy_type: 'rebuy',
        p_client_token: 'original-token',
        p_cost: 20,
      },
    },
    response: {
      status: 200,
      body: {
        success: true,
        atomic_tournament_chip_purchase: 'v1',
        seated: true,
        table_id: id(1),
        seat_number: 2,
      },
    },
    before: {
      tournamentId: id(3),
      userId: id(2),
      activeSeatCount: 0,
      stack: 0,
      playerChipCount: 0,
      wallet: 100,
      purchaseCount: 0,
    },
    after: {
      tournamentId: id(3),
      userId: id(2),
      activeSeatCount: 1,
      tableId: id(1),
      seatNumber: 2,
      stack: 10000,
      playerStatus: 'playing',
      wallet: 80,
      purchaseCount: 1,
      purchaseToken: 'original-token',
      purchaseCommitted: true,
    },
    observedTableId: id(1),
    observedSeatNumber: 2,
    manualSeatRequests: [],
  };
}
test('paid return requires exact debit, original committed receipt and one automatic chair', () => {
  assert.equal(verifyPaidRebuyReturn(rebuy()).cost, 20);
  for (const mutate of [
    (x) => (x.after.wallet = 79),
    (x) => (x.after.purchaseCount = 2),
    (x) => (x.after.purchaseToken = 'another-token'),
    (x) => (x.after.purchaseCommitted = false),
    (x) => (x.after.activeSeatCount = 2),
    (x) => (x.after.tableId = id(9)),
    (x) => (x.before.stack = 1),
    (x) => (x.before.playerChipCount = 1),
    (x) => x.manualSeatRequests.push({}),
    (x) => (x.after.userId = id(8)),
  ]) {
    const value = rebuy();
    mutate(value);
    assert.throws(() => verifyPaidRebuyReturn(value));
  }
  const retainedZeroSeat = rebuy();
  retainedZeroSeat.before.activeSeatCount = 1;
  assert.equal(verifyPaidRebuyReturn(retainedZeroSeat).cost, 20);
});
test('all three persisted reports and supported MTT rebuy are required', () => {
  const rows = [1, 2, 3].map((n) => ({
    user_id: id(n),
    position: n,
    prize: n === 1 ? 54 : 0,
    bounty_winnings: 0,
  }));
  const input = {
    tournamentId: id(4),
    endedAt: '2026-10-31T15:00:00Z',
    status: 'COMPLETED',
    beforeReload: rows,
    afterReload: structuredClone(rows),
    visibleUserIds: rows.map((r) => r.user_id),
    reportTournamentId: id(4),
  };
  assert.equal(verifyFinishReport(input).players, 3);
  input.afterReload[0].prize = 53;
  assert.throws(() => verifyFinishReport(input));
  const cohorts = ['MTT', 'SPIN', 'SNG'].map((format) => ({
    format,
    flows: Object.fromEntries(requiredPlayerUIFlows(format).map((f) => [f, { verified: true }])),
  }));
  assert.equal(requireCompletePlayerUICoverage(cohorts).product_certificate, false);
  delete cohorts[1].flows.finish_report;
  assert.throws(() => requireCompletePlayerUICoverage(cohorts));
});
test('native request cannot select arbitrary IDs, SQL, users or out-of-range cohorts', () => {
  assert.equal(
    validateTournamentRead({ cohort_index: 0, actor_index: 2, token: null }).actor_index,
    2
  );
  for (const value of [
    { cohort_index: 3, actor_index: 0, token: null },
    { cohort_index: 0, actor_index: 9, token: null },
    { cohort_index: 0, actor_index: 0, token: null, sql: 'select 1' },
    { cohort_index: 0, actor_index: 0, token: "x'; select 1; --" },
  ])
    assert.throws(() => validateTournamentRead(value));
  const cohorts = ['MTT', 'SPIN', 'SNG'].map((format, i) => ({
    format,
    tournament_id: id(10 + i),
    club_id: id(20),
    actor_ids: [id(1), id(2), id(3)],
  }));
  assert.equal(tournamentObservationBinding(cohorts).length, 3);
  cohorts[1].tournament_id = cohorts[0].tournament_id;
  assert.throws(() => tournamentObservationBinding(cohorts));
});

test('wire collector cannot reuse an old arm across socket generations or archive private cards', () => {
  const page = new EventEmitter(),
    socket = new EventEmitter();
  socket.url = () => 'wss://engine.smarter.poker/ws/multi?v=0';
  const wire = collectPlayerUIWire(page, id(2));
  page.emit('websocket', socket);
  const emit = (message) =>
    socket.emit('framereceived', { payload: JSON.stringify({ tableId: id(1), ...message }) });
  const snapshot = { type: 'SNAPSHOT', seq: 1, state: { hand_number: 7, players: [] } };
  const key = { tableId: id(1), userId: id(2), handNumber: 7, since: Date.now() };
  emit(snapshot);
  emit({ type: 'USER_EVENT', payload: { kind: 'hole_cards', cards: ['Ah', 'As'] } });
  assert.equal(wire.readArm(wire, key), undefined);
  emit({
    type: 'USER_EVENT',
    payload: {
      kind: 'pre_action',
      action: 'auto_call',
      hand_number: 7,
      to_call_at_set: 4,
      cards: ['Ah', 'As'],
    },
  });
  assert.equal(wire.readArm(wire, key).to_call_at_set, 4);
  assert.equal('cards' in wire.readArm(wire, key), false);
  socket.emit('close');
  emit(snapshot);
  assert.equal(wire.readArm(wire, key), undefined);
  wire.close();
  assert.equal(page.listenerCount('websocket'), 0);
  assert.equal(socket.listenerCount('framereceived'), 0);
});

test('gapped dealer state fails the same wire generation without accepting a later arm', () => {
  const page = new EventEmitter(),
    socket = new EventEmitter();
  socket.url = () => 'wss://engine.smarter.poker/ws/multi?v=0';
  const wire = collectPlayerUIWire(page, id(2));
  page.emit('websocket', socket);
  const emit = (message) =>
    socket.emit('framereceived', { payload: JSON.stringify({ tableId: id(1), ...message }) });
  emit({ type: 'SNAPSHOT', seq: 1, state: { hand_number: 7, players: [] } });
  emit({ type: 'DELTA', prev: 0, seq: 3, patch: [] });
  assert.throws(() => wire.state(id(1)), /PLAYER_UI_WIRE_REFUSED/);
  wire.close();
});
