import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { requireSchemaSourceContract } from '../../native/component-source-contract.mjs';

export const PLAYER_UI_FORMATS = Object.freeze(['MTT', 'SPIN', 'SNG']);
export const PLAYER_UI_FLOWS = Object.freeze([
  'call_any',
  'call_amount',
  'paid_rebuy_return',
  'finish_report',
]);
export const requiredPlayerUIFlows = (format) =>
  format === 'MTT'
    ? [...PLAYER_UI_FLOWS]
    : PLAYER_UI_FLOWS.filter((flow) => flow !== 'paid_rebuy_return');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const money = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const equalMoney = (a, b) =>
  assert.ok(money(a) && money(b) && Math.abs(a - b) < 0.000001, 'PLAYER_UI_MONEY_DISAGREES');

/** Existing isolated tournament ingress, never a way to create/fund a venue.
 * A real service-schema contract and three canonically admitted cohorts must
 * already exist. Credentials remain in memory; receipts contain only facts.
 */
export function validatePlayerUIIngress(value) {
  assert.equal(value?.version, 1);
  assert.equal(value.scope, 'isolated-tournament-player-ui');
  requireSchemaSourceContract(value.source_contract);
  assert.match(value.control_sha, /^[0-9a-f]{40}$/);
  assert.match(value.schema_catalogue_digest, /^[0-9a-f]{64}$/);
  assert.match(value.runtime_image, /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/);
  assert.match(value.engine_sha, /^[0-9a-f]{40}$/);
  assert.match(value.web_sha, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(value.cohorts) && value.cohorts.length === 3);
  assert.deepEqual(value.cohorts.map((c) => c.format).sort(), [...PLAYER_UI_FORMATS].sort());
  assert.equal(new Set(value.cohorts.map((c) => c.tournament_id)).size, 3);
  for (const cohort of value.cohorts) {
    assert.match(cohort.tournament_id, uuid);
    assert.match(cohort.club_id, uuid);
    assert.ok(Array.isArray(cohort.users) && cohort.users.length >= 3 && cohort.users.length <= 9);
    assert.equal(new Set(cohort.users.map((u) => u.id)).size, cohort.users.length);
    for (const user of cohort.users) {
      assert.match(user.id, uuid);
      assert.equal(user.session?.user?.id, user.id);
      const token = user.session?.access_token;
      assert.equal(typeof token, 'string');
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      assert.equal(claims.sub, user.id);
      assert.equal(claims.role, 'authenticated');
      assert.ok(Number.isSafeInteger(claims.exp) && claims.exp > Date.now() / 1000 + 300);
    }
    assert.ok(typeof cohort.anon_key === 'string' && cohort.anon_key.length > 0);
    if (cohort.format === 'MTT') {
      assert.ok(money(cohort.rebuy_cost) && cohort.rebuy_cost > 0);
      assert.ok(Number.isSafeInteger(cohort.rebuy_chips) && cohort.rebuy_chips > 0);
    }
  }
  return value;
}

/** Derive the outcome from actual browser HTTP + private arm frame + public
 * accepted-action wire. No checkbox, successful click or snapshot alone passes.
 */
export function verifyPreActionUI({
  choice,
  tableId,
  userId,
  handNumber,
  clickAt,
  request,
  response,
  armed,
  calls,
  directActions,
}) {
  assert.ok(choice === 'call_any' || choice === 'call_amount');
  assert.match(tableId, uuid);
  assert.match(userId, uuid);
  assert.ok(Number.isSafeInteger(handNumber) && handNumber > 0);
  assert.ok(Number.isFinite(clickAt));
  const action = choice === 'call_any' ? 'auto_call_any' : 'auto_call';
  assert.equal(request.method, 'POST');
  assert.equal(request.pathname, '/preaction');
  assert.equal(request.body.tableId, tableId);
  assert.equal(request.body.action, action);
  assert.ok(request.at >= clickAt);
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(armed.kind, 'pre_action');
  assert.equal(armed.action, action);
  assert.equal(armed.hand_number, handNumber);
  assert.ok(money(armed.to_call_at_set));
  assert.ok(
    Array.isArray(directActions) && directActions.length === 0,
    'PLAYER_UI_DIRECT_ACTION_IS_NOT_PREACTION'
  );
  assert.ok(Array.isArray(calls) && calls.length === 1, 'PLAYER_UI_EXPECTED_ONE_ACCEPTED_CALL');
  const call = calls[0];
  assert.equal(call.tableId, tableId);
  assert.equal(call.user_id, userId);
  assert.equal(call.hand_number, handNumber);
  assert.equal(call.action, 'call');
  assert.notEqual(call.replayed, true);
  assert.ok(call.receivedAt >= request.at);
  assert.ok(money(call.amount) && call.amount > 0);
  if (choice === 'call_amount') {
    assert.ok(armed.to_call_at_set > 0);
    equalMoney(response.body.armedToCall, armed.to_call_at_set);
    assert.ok(call.amount <= armed.to_call_at_set, 'PLAYER_UI_FIXED_CALL_EXCEEDED_ARMED_PRICE');
  }
  return {
    choice,
    tableId,
    userId,
    handNumber,
    amount: call.amount,
    armedAmount: armed.to_call_at_set,
  };
}

export function verifyPaidRebuyReturn({
  tournamentId,
  userId,
  request,
  response,
  before,
  after,
  observedTableId,
  observedSeatNumber,
  manualSeatRequests,
}) {
  assert.match(tournamentId, uuid);
  assert.match(userId, uuid);
  assert.equal(request.method, 'POST');
  assert.equal(request.pathname, '/rest/v1/rpc/process_tournament_rebuy');
  assert.equal(request.body.p_tournament_id, tournamentId);
  assert.equal(request.body.p_user_id, userId);
  assert.ok(['rebuy', 'reentry'].includes(request.body.p_rebuy_type));
  assert.ok(
    typeof request.body.p_client_token === 'string' &&
      /^[A-Za-z0-9-]{8,128}$/.test(request.body.p_client_token)
  );
  assert.ok(money(request.body.p_cost) && request.body.p_cost > 0);
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.atomic_tournament_chip_purchase, 'v1');
  assert.equal(response.body.seated, true);
  assert.equal(response.body.table_id, observedTableId);
  assert.equal(response.body.seat_number, observedSeatNumber);
  assert.ok(
    before.activeSeatCount === 0 || before.activeSeatCount === 1,
    'PLAYER_UI_REBUY_DUPLICATE_OR_UNKNOWN_CHAIR'
  );
  assert.equal(before.stack, 0, 'PLAYER_UI_REBUY_DID_NOT_START_BUSTED');
  assert.equal(before.playerChipCount, 0, 'PLAYER_UI_REBUY_DID_NOT_START_BUSTED');
  assert.equal(after.activeSeatCount, 1);
  assert.equal(after.tableId, observedTableId);
  assert.equal(after.seatNumber, observedSeatNumber);
  assert.ok(after.stack > 0);
  assert.equal(after.playerStatus, 'playing');
  equalMoney(before.wallet - after.wallet, request.body.p_cost);
  assert.equal(
    after.purchaseCount - before.purchaseCount,
    1,
    'PLAYER_UI_REBUY_PURCHASE_CARDINALITY'
  );
  assert.equal(after.purchaseToken, request.body.p_client_token);
  assert.equal(after.purchaseCommitted, true);
  assert.equal(before.tournamentId, tournamentId);
  assert.equal(after.tournamentId, tournamentId);
  assert.equal(before.userId, userId);
  assert.equal(after.userId, userId);
  assert.ok(
    Array.isArray(manualSeatRequests) && manualSeatRequests.length === 0,
    'PLAYER_UI_MANUAL_SEATING_IS_NOT_RETURN'
  );
  return {
    tournamentId,
    userId,
    tableId: observedTableId,
    seatNumber: observedSeatNumber,
    cost: request.body.p_cost,
    token: request.body.p_client_token,
  };
}

export function standingsDigest(rows) {
  assert.ok(Array.isArray(rows) && rows.length >= 3 && rows.length <= 9);
  const normalized = rows
    .map((row) => {
      assert.match(row.user_id, uuid);
      assert.ok(Number.isSafeInteger(row.position) && row.position > 0);
      assert.ok(money(row.prize) && money(row.bounty_winnings));
      return {
        user_id: row.user_id,
        position: row.position,
        prize: row.prize,
        bounty_winnings: row.bounty_winnings,
      };
    })
    .sort((a, b) => a.user_id.localeCompare(b.user_id));
  assert.equal(new Set(normalized.map((r) => r.user_id)).size, normalized.length);
  assert.equal(new Set(normalized.map((r) => r.position)).size, normalized.length);
  assert.equal(Math.min(...normalized.map((r) => r.position)), 1);
  assert.equal(Math.max(...normalized.map((r) => r.position)), normalized.length);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function verifyFinishReport({
  tournamentId,
  endedAt,
  status,
  beforeReload,
  afterReload,
  visibleUserIds,
  reportTournamentId,
}) {
  assert.match(tournamentId, uuid);
  assert.ok(['COMPLETED', 'FINISHED', 'ENDED'].includes(String(status).toUpperCase()));
  assert.ok(Number.isFinite(Date.parse(endedAt)));
  assert.equal(reportTournamentId, tournamentId);
  const first = standingsDigest(beforeReload),
    second = standingsDigest(afterReload);
  assert.equal(second, first, 'PLAYER_UI_FINISH_REPORT_CHANGED_ON_COLD_READ');
  assert.deepEqual([...visibleUserIds].sort(), beforeReload.map((r) => r.user_id).sort());
  return { tournamentId, endedAt, standingsDigest: first, players: beforeReload.length };
}

export function requireCompletePlayerUICoverage(cohorts) {
  assert.deepEqual(cohorts.map((c) => c.format).sort(), [...PLAYER_UI_FORMATS].sort());
  for (const cohort of cohorts) {
    const required = requiredPlayerUIFlows(cohort.format);
    assert.deepEqual(Object.keys(cohort.flows).sort(), required.sort());
    for (const flow of required)
      assert.equal(
        cohort.flows[flow]?.verified,
        true,
        `PLAYER_UI_UNVERIFIED_${cohort.format}_${flow}`
      );
  }
  // The outer existing fixture owner still must prove native custody and full
  // resource cleanup. This scoped evidence cannot certify a release itself.
  return {
    scope: 'isolated-tournament-player-ui-observations',
    product_certificate: false,
    formats: [...PLAYER_UI_FORMATS],
    flows: [...PLAYER_UI_FLOWS],
  };
}
