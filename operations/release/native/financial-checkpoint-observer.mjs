import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { FINANCIAL_MS, validateFinancialData } from './component-observation-protocol.mjs';
import { createTopupVerifier } from './financial-topup-verifier.mjs';

const phases = Object.freeze([
  'topup.before',
  'topup.malformed_refused',
  'topup.accepted',
  'topup.replayed',
  'insurance.offered',
  'insurance.malformed_refused',
  'insurance.accepted',
  'settlement.observed',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Checkpoint coordination in the independent observer, not the fixture writer.
 * Callbacks must be the observer's pinned engine identity reader, fixed private
 * observation client and its two actual WS clients. This reusable state machine
 * grants no OS, database or network authority and never emits a certificate.
 */
export function createFinancialCheckpointObserver({
  owner,
  observations,
  readEngineIdentity,
  sampleFelt,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const bound = structuredClone(owner);
  for (const id of [bound.tableId, bound.clubId, ...bound.actorIds]) assert.match(id, uuid);
  assert.equal(bound.actorIds.length, 2);
  assert.equal(new Set(bound.actorIds).size, 2);
  assert.match(bound.opId, /^[a-zA-Z0-9-]{8,64}$/);
  assert.match(bound.sourceSha, /^[0-9a-f]{40}$/);
  for (const fn of [observations.financialFacts, readEngineIdentity, sampleFelt])
    assert.equal(typeof fn, 'function');
  assert.equal(observations.binding.table_id, bound.tableId);
  let identity,
    financial,
    deadline,
    topup,
    started = false,
    busy = false,
    failed = false;
  const journal = [];
  function live() {
    assert.ok(started && !failed && now() < deadline, 'FINANCIAL_CHECKPOINT_CLOSED_OR_EXPIRED');
  }
  async function engine() {
    const result = await readEngineIdentity();
    assert.equal(result.running, true, 'FINANCIAL_ENGINE_NOT_RUNNING');
    assert.equal(result.source_sha, bound.sourceSha, 'FINANCIAL_ENGINE_SOURCE');
    assert.ok(
      typeof result.instance_id === 'string' &&
        result.instance_id.length > 0 &&
        result.instance_id.length <= 128,
      'FINANCIAL_ENGINE_INSTANCE'
    );
    return { source_sha: result.source_sha, instance_id: result.instance_id };
  }
  async function facts() {
    live();
    const data = validateFinancialData(await observations.financialFacts(financial));
    live();
    assert.deepEqual(data.actor_ids, bound.actorIds, 'FINANCIAL_CHECKPOINT_ACTORS');
    assert.deepEqual(
      data.scope,
      [[bound.tableId, bound.clubId, null, null, 'false', null]],
      'FINANCIAL_CHECKPOINT_SCOPE'
    );
    return structuredClone(data);
  }
  async function until(predicate, milliseconds) {
    const end = Math.min(deadline, now() + milliseconds);
    for (;;) {
      const data = await facts();
      assert.ok(now() < end, 'FINANCIAL_CHECKPOINT_PERSISTENCE_TIMEOUT');
      if (predicate(data)) return data;
      await sleep(Math.min(100, end - now()));
    }
  }
  return Object.freeze({
    async start() {
      assert.ok(!started && !failed && !busy, 'FINANCIAL_CHECKPOINT_ALREADY_STARTED');
      busy = true;
      try {
        identity = await engine();
        deadline = now() + FINANCIAL_MS;
        started = true;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        busy = false;
      }
    },
    async checkpoint(raw) {
      try {
        live();
        assert.ok(!busy && journal.length < phases.length, 'FINANCIAL_CHECKPOINT_OVERLAP');
        busy = true;
        const entry = structuredClone(raw),
          index = journal.length;
        assert.equal(entry.phase, phases[index], 'FINANCIAL_CHECKPOINT_ORDER');
        assert.ok(Number.isSafeInteger(entry.hand_number) && entry.hand_number > 0);
        if (!financial) {
          const actorIndex = bound.actorIds.indexOf(entry.actor_id);
          assert.ok(actorIndex >= 0, 'FINANCIAL_CHECKPOINT_ACTOR');
          financial = Object.freeze({
            actor_index: actorIndex,
            hand_number: entry.hand_number,
            op_id: bound.opId,
          });
          topup = createTopupVerifier({ ...bound, financial });
        }
        assert.equal(entry.hand_number, financial.hand_number, 'FINANCIAL_CHECKPOINT_HAND');
        if (index < 4) assert.equal(entry.actor_id, bound.actorIds[financial.actor_index]);
        else if (index < 7)
          assert.ok(bound.actorIds.includes(entry.actor_id), 'FINANCIAL_CHECKPOINT_ACTOR');
        let data;
        if (entry.phase === 'insurance.offered') {
          assert.equal(entry.offer.table_id, bound.tableId);
          assert.equal(entry.offer.hand_number, financial.hand_number);
          assert.equal(entry.offer.offers.length, 1);
          assert.equal(entry.offer.offers[0].playerId, entry.actor_id);
          data = await until(
            (row) =>
              row.offers.some(
                (offer) =>
                  offer[1] === entry.actor_id &&
                  offer[2] === 'offered' &&
                  offer[5] === 'turn' &&
                  offer[6] === String(financial.hand_number)
              ),
            5000
          );
        } else if (entry.phase === 'settlement.observed') {
          assert.equal(entry.event.table_id, bound.tableId);
          assert.equal(entry.event.hand_number, financial.hand_number);
          data = await until(
            (row) =>
              row.commits.length === 1 && row.commits[0][3] !== null && row.hands.length === 1,
            15000
          );
          assert.equal(data.hands[0][0], data.commits[0][0], 'FINANCIAL_COMMITTED_HAND_ID');
          const post = JSON.parse(data.commits[0][5]);
          assert.equal(post.ok, true);
          assert.equal(post.hand_id, data.hands[0][0]);
          assert.equal(post.hand_number, financial.hand_number);
          assert.equal(post.insurance, 1);
          assert.equal(post.pending_addons, 1);
          assert.equal(data.insurance.length, 1, 'FINANCIAL_INSURANCE_COUNT');
          assert.equal(data.addons.length, 1);
          assert.ok(data.addons[0][4] !== null, 'FINANCIAL_UNRESOLVED_ADDON');
          assert.deepEqual(await engine(), identity, 'FINANCIAL_ENGINE_REPLACED');
        } else data = await facts();
        if (index < 4) topup.observe(entry, data);
        if (entry.phase === 'insurance.malformed_refused') {
          assert.equal(entry.actor_id, journal[4].entry.actor_id);
          assert.deepEqual(data, journal[4].facts, 'FINANCIAL_INSURANCE_REFUSAL_MUTATED');
        }
        if (entry.phase === 'insurance.accepted')
          assert.equal(entry.actor_id, journal[4].entry.actor_id);
        const felt = structuredClone(await sampleFelt());
        assert.ok(Array.isArray(felt) && felt.length === 2, 'FINANCIAL_FELT_CLIENT_COUNT');
        assert.deepEqual(felt.map((r) => r.actor_id).sort(), [...bound.actorIds].sort());
        for (const sample of felt) {
          assert.equal(sample.state.table_id, bound.tableId, 'FINANCIAL_FELT_TABLE');
          assert.ok(Number.isSafeInteger(sample.sequence) && sample.sequence >= 0);
          assert.ok(
            [financial.hand_number, financial.hand_number + 1].includes(sample.state.hand_number),
            'FINANCIAL_FELT_HAND'
          );
        }
        live();
        const saved = { entry, facts: data, felt };
        assert.ok(
          Buffer.byteLength(JSON.stringify([...journal, saved])) <= 262144,
          'FINANCIAL_CHECKPOINT_JOURNAL_SIZE'
        );
        journal.push(saved);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        busy = false;
      }
    },
    observations() {
      live();
      assert.equal(journal.length, phases.length, 'FINANCIAL_CHECKPOINT_INCOMPLETE');
      return {
        scope: 'independent-financial-route-observations',
        owner: structuredClone(bound),
        engine_identity: structuredClone(identity),
        topup_database: topup.receipt(),
        checkpoints: structuredClone(journal),
        product_certificate: false,
        remaining: [
          'insurance economics and bank conservation',
          'felt-to-database settlement reconciliation',
          'canonical fixture cleanup',
          'source closure and deployed release certification',
        ],
      };
    },
  });
}
