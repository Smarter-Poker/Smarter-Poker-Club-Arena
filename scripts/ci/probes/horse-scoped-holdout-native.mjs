import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const { validateScopedOpponentHoldout: validate } = await import(
  pathToFileURL(resolve(root, 'server/dist/engine/HorseScopedOpponentHoldout.js'))
);
const { buildScopedOpponentModel: build, SCOPED_MODEL_ACTIONS: actions } = await import(
  pathToFileURL(resolve(root, 'server/dist/engine/HorseScopedOpponentModel.js'))
);
const sha = (v) => createHash('sha256').update(v).digest('hex'),
  now = Date.UTC(2026, 8, 14),
  day = 86400000;
const prior = {
  version: 'native-frozen-prior-1',
  probabilities: { fold: 0.15, check: 0.15, call: 0.4, bet: 0.15, raise: 0.15 },
};
const scope = sha('native-scope'),
  actor = sha('native-opponent'),
  observer = sha('native-observer');
function population(partition, regime, ageDays = 0, sessions = 80) {
  const rows = [];
  for (let session = 0; session < sessions; session++) {
    const sessionKey =
      (session * 5 + (partition === 'training' ? 1 : 0)).toString(16).padStart(8, '0') +
      sha(String(session)).slice(8);
    for (let h = 0; h < 2 + (session % 4); h++) {
      const handId = `aaaaaaaa-aaaa-4aaa-8aaa-${String((partition === 'holdout' ? 100000 : 0) + session * 10 + h).padStart(12, '0')}`;
      for (let a = 0; a < 1 + (h % 3); a++) {
        rows.push({
          version: 1,
          observationId: handId + ':' + a,
          handId,
          actorKey: actor,
          sessionKey,
          observedAtMs: now - 1000 - (ageDays + (session % 7) / 3) * day - a * 100,
          partition,
          scopeKey: scope,
          scope: [],
          action: regime === 'uniform' ? actions[(session + h + a) % 5] : regime,
          facedBet: true,
          origin: 'player',
        });
      }
    }
  }
  return rows;
}
const input = (observations) => ({
  observations,
  scopeKey: scope,
  opponentKey: actor,
  observerKey: observer,
  cohort: 'human',
  window: { fromMs: now - 30 * day, toMs: now, complete: true },
  prior,
});
const loss = (p, chosen) =>
  actions.reduce((sum, action) => sum + (p[action] - (action === chosen ? 1 : 0)) ** 2, 0);
// Independent direct-loss reference: score each held-out outcome first, then
// average losses within hands/sessions. It never inverts a fitted distribution
// or calls the holdout estimator used by the production scorer.
function reference(rows, candidate) {
  const sessions = new Map();
  for (const row of rows) {
    const hands = sessions.get(row.sessionKey) ?? new Map();
    sessions.set(row.sessionKey, hands);
    const events = hands.get(row.handId) ?? [];
    hands.set(row.handId, events);
    events.push({
      weight: Math.exp((-Math.LN2 * (now - row.observedAtMs)) / (7 * day)),
      gain: loss(prior.probabilities, row.action) - loss(candidate, row.action),
    });
  }
  let total = 0,
    mass = 0;
  for (const hands of sessions.values()) {
    let weightedGain = 0,
      handMass = 0,
      sessionWeight = 0;
    for (const events of hands.values()) {
      const meanWeight = events.reduce((n, e) => n + e.weight, 0) / events.length;
      const meanGain = events.reduce((n, e) => n + e.weight * e.gain, 0) / events.length;
      weightedGain += meanGain;
      handMass += meanWeight;
      sessionWeight = Math.max(sessionWeight, meanWeight);
    }
    total += (weightedGain / handMass) * sessionWeight;
    mass += sessionWeight;
  }
  return total / mass;
}
const cases = [];
for (const trainingAction of ['fold', 'call', 'uniform'])
  for (const holdoutAction of ['fold', 'call', 'raise', 'uniform'])
    for (const age of [0, 20]) {
      const train = population('training', trainingAction),
        heldout = population('holdout', holdoutAction, age),
        i = input([...train, ...heldout]);
      const candidate = build({ ...i, partition: 'training' }),
        r = validate(i);
      assert.notEqual(candidate.status, 'unavailable');
      assert.notEqual(r.status, 'unavailable');
      const expected = reference(heldout, candidate.probabilities);
      assert.ok(Math.abs(r.brierImprovement - expected) < 1e-12);
      assert.ok(r.interval[0] <= expected && r.interval[1] >= expected);
      assert.equal(r.activationAuthorized, false);
      assert.equal(r.causalEvEstablished, false);
      assert.deepEqual(validate(JSON.parse(JSON.stringify(i))), r);
      assert.deepEqual(
        validate({ ...i, observations: [...i.observations, ...i.observations].reverse() }),
        r
      );
      cases.push({
        trainingAction,
        holdoutAction,
        ageDays: age,
        status: r.status,
        expected,
        actual: r.brierImprovement,
        interval: r.interval,
        validationId: r.validationId,
      });
    }
const source = population('training', 'fold', 0, 2000).slice(0, 10000),
  heldout = population('holdout', 'fold', 0, 2000).slice(0, 10000);
const maximum = input([...source, ...heldout]);
assert.equal(maximum.observations.length, 20000);
const start = performance.now(),
  large = validate(maximum),
  elapsedMs = performance.now() - start;
assert.notEqual(large.status, 'unavailable');
assert.equal(
  validate({ ...maximum, observations: [...maximum.observations, maximum.observations[0]] }).reason,
  'input_budget_exceeded'
);
const files = [
  'server/src/engine/HorseScopedOpponentHoldout.ts',
  'server/src/engine/HorseScopedOpponentModel.ts',
  'scripts/ci/probes/horse-scoped-holdout-native.mjs',
];
const proof = {
  casesPassed: cases.length,
  cases,
  maximum: { observations: 20000, elapsedMs, status: large.status },
  invariantDigest: sha(JSON.stringify(cases)),
  sourceHashes: Object.fromEntries(files.map((p) => [p, sha(readFileSync(resolve(root, p)))])),
  productionDataRead: false,
  productionDataWritten: false,
  causalEvEstablished: false,
  activationAuthorized: false,
  limitation:
    'Synthetic offline predictive validation only; no live source completeness, causal utility, candidate-selection correction or fleet certification.',
};
writeFileSync(process.argv[2], JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    casesPassed: proof.casesPassed,
    invariantDigest: proof.invariantDigest,
    maximum: proof.maximum,
  })
);
