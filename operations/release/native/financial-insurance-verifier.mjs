import assert from 'node:assert/strict';
import { validateFinancialData } from './component-observation-protocol.mjs';
import { chipCents } from './financial-topup-verifier.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function quoteCents(value) {
  assert.ok(typeof value === 'number' && Number.isFinite(value), 'INSURANCE_QUOTE_NUMBER');
  assert.ok(value > 0 && value <= Number.MAX_SAFE_INTEGER / 100, 'INSURANCE_QUOTE_RANGE');
  return chipCents(String(value));
}
function addedRows(before, after) {
  for (const rows of [before, after]) {
    rows.forEach((row) => assert.match(row[0], uuid));
    assert.equal(new Set(rows.map((row) => row[0])).size, rows.length, 'INSURANCE_DUPLICATE_ROW');
  }
  for (const row of before)
    assert.deepEqual(
      after.find((next) => next[0] === row[0]),
      row,
      'INSURANCE_HISTORY_CHANGED'
    );
  const ids = new Set(before.map((row) => row[0]));
  return after.filter((row) => !ids.has(row[0]));
}

/** Independent, fixed-observation comparison for one full-coverage offer in
 * the two-human standalone cash fixture. No SQL, actuation or certificate.
 * The caller must obtain the quote/response/event from its actual WS/HTTP
 * actors and rows from the separately owned fixed-query observer.
 */
export function verifyInsuranceEconomics({ owner, offered, accepted, settled }) {
  const { tableId, clubId, actorIds } = structuredClone(owner);
  assert.equal(actorIds.length, 2);
  assert.equal(new Set(actorIds).size, 2);
  for (const id of [tableId, clubId, ...actorIds]) assert.match(id, uuid);
  const start = structuredClone(offered),
    response = structuredClone(accepted),
    end = structuredClone(settled);
  assert.equal(start.entry.phase, 'insurance.offered');
  assert.equal(response.entry.phase, 'insurance.accepted');
  assert.equal(end.entry.phase, 'settlement.observed');
  const actor = start.entry.actor_id,
    hand = start.entry.hand_number;
  assert.ok(actorIds.includes(actor), 'INSURANCE_ACTOR');
  assert.ok(Number.isSafeInteger(hand) && hand > 0, 'INSURANCE_HAND');
  assert.equal(response.entry.actor_id, actor, 'INSURANCE_ACCEPT_ACTOR');
  for (const checkpoint of [start, response, end]) {
    assert.equal(checkpoint.entry.hand_number, hand, 'INSURANCE_HAND');
    validateFinancialData(checkpoint.facts);
    assert.deepEqual(checkpoint.facts.actor_ids, actorIds, 'INSURANCE_ACTORS');
    assert.deepEqual(
      checkpoint.facts.scope,
      [[tableId, clubId, null, null, 'false', null]],
      'INSURANCE_SCOPE'
    );
  }
  const event = start.entry.offer;
  assert.equal(event.type, 'insurance_offers');
  assert.equal(event.table_id, tableId);
  assert.equal(event.hand_number, hand);
  assert.equal(event.street, 'turn');
  assert.equal(event.offers.length, 1);
  const quote = event.offers[0];
  assert.equal(quote.playerId, actor);
  const quotedPremium = quoteCents(quote.fullPremium),
    insured = quoteCents(quote.fullInsuredAmount);
  assert.ok(quotedPremium <= insured, 'INSURANCE_QUOTE_ORDER');
  const offers = start.facts.offers.filter((row) => row[2] === 'offered');
  assert.equal(offers.length, 1, 'INSURANCE_OFFER_COUNT');
  assert.deepEqual(offers[0].slice(1, 3), [actor, 'offered']);
  assert.equal(chipCents(offers[0][3]), quotedPremium, 'INSURANCE_OFFER_PREMIUM');
  assert.equal(chipCents(offers[0][4]), insured, 'INSURANCE_OFFER_AMOUNT');
  assert.deepEqual(offers[0].slice(5), ['turn', String(hand)]);
  addedRows(start.facts.offers, end.facts.offers);
  assert.equal(
    end.facts.offers.filter((row) => row[2] === 'offered').length,
    1,
    'INSURANCE_OFFER_COUNT'
  );
  const ack = response.entry.response;
  assert.equal(ack.success, true);
  assert.equal(ack.status, 'accepted', 'INSURANCE_ACCEPT_STATUS');
  // The actual acceptance response has no coveragePercent field. Full
  // coverage is checked against both full quote amounts; the pinned actor
  // sends numeric100 and independently compares the before/after preview.
  assert.equal(quoteCents(ack.premium), quotedPremium, 'INSURANCE_ACCEPT_PREMIUM');
  assert.equal(quoteCents(ack.insuredAmount), insured, 'INSURANCE_ACCEPT_AMOUNT');
  const completion = end.entry.event;
  assert.equal(completion.type, 'hand_complete');
  assert.equal(completion.table_id, tableId);
  assert.equal(completion.hand_number, hand);
  const winners = completion.winner_ids;
  assert.ok(
    Array.isArray(winners) && winners.length > 0 && winners.length <= 2,
    'INSURANCE_WINNERS'
  );
  assert.equal(new Set(winners).size, winners.length, 'INSURANCE_WINNERS');
  assert.ok(
    winners.every((id) => actorIds.includes(id)),
    'INSURANCE_WINNERS'
  );
  const won = winners.includes(actor),
    push = won && winners.length > 1;
  const premium = won && !push ? quotedPremium : 0n,
    payout = won ? 0n : insured;
  assert.equal(start.facts.insurance.length, 0, 'INSURANCE_NONEMPTY_BASELINE');
  assert.equal(end.facts.insurance.length, 1, 'INSURANCE_RECEIPT_COUNT');
  const row = end.facts.insurance[0];
  assert.match(row[0], uuid);
  assert.equal(row[1], actor);
  assert.equal(chipCents(row[2]), premium, 'INSURANCE_RECEIPT_PREMIUM');
  assert.equal(chipCents(row[3]), insured, 'INSURANCE_RECEIPT_AMOUNT');
  assert.equal(chipCents(row[4]), payout, 'INSURANCE_RECEIPT_PAYOUT');
  assert.equal(chipCents(row[5]), payout - premium, 'INSURANCE_RECEIPT_NET');
  assert.deepEqual(row.slice(6), [String(won), 'club', clubId], 'INSURANCE_RECEIPT_OWNER');
  for (const facts of [start.facts, end.facts]) {
    assert.equal(facts.banks.length, 1, 'INSURANCE_BANK_COUNT');
    assert.deepEqual(facts.banks[0].slice(0, 2), ['club', clubId], 'INSURANCE_BANK_OWNER');
  }
  const beforeBank = start.facts.banks[0],
    afterBank = end.facts.banks[0];
  if (beforeBank[2] === null) assert.equal(beforeBank[3], null, 'INSURANCE_ABSENT_BANK');
  else {
    assert.match(beforeBank[2], uuid);
    assert.equal(afterBank[2], beforeBank[2], 'INSURANCE_BANK_REPLACED');
  }
  assert.match(afterBank[2], uuid);
  const opening = beforeBank[2] === null ? 0n : chipCents(beforeBank[3]);
  const closing = chipCents(afterBank[3]); // An underwriting bank is signed.
  assert.equal(closing - opening, premium - payout, 'INSURANCE_BANK_DELTA');
  const added = addedRows(start.facts.ledger, end.facts.ledger);
  const bankRows = added.filter(
    (r) => r[1] === 'insurance_bank' || r[3] === 'insurance_bank' || r[6] === 'insurance'
  );
  assert.equal(bankRows.length, premium || payout ? 1 : 0, 'INSURANCE_LEDGER_COUNT');
  if (bankRows.length) {
    const ledger = bankRows[0];
    const endpoints = premium
      ? ['table_stack', tableId, 'insurance_bank', afterBank[2]]
      : ['insurance_bank', afterBank[2], 'table_stack', tableId];
    assert.deepEqual(ledger.slice(1, 5), endpoints, 'INSURANCE_LEDGER_COUNTERPART');
    assert.equal(chipCents(ledger[5]), premium || payout, 'INSURANCE_LEDGER_AMOUNT');
    assert.equal(ledger[6], 'insurance');
  }
  return {
    scope: 'full-coverage-insurance-fixed-observations',
    table_id: tableId,
    club_id: clubId,
    actor_id: actor,
    hand_number: hand,
    branch: push ? 'push' : won ? 'premium' : 'payout',
    premium_cents: String(premium),
    payout_cents: String(payout),
    bank_delta_cents: String(closing - opening),
    bank_wallet_id: afterBank[2],
    receipt_id: row[0],
    ledger_ids: bankRows.map((r) => r[0]),
    product_certificate: false,
  };
}
