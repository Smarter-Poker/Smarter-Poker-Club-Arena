/** One synthetic serving smoke through the actual worker/native/store path. */
import assert from 'node:assert/strict';
import { isMainThread } from 'node:worker_threads';
import { replaceGtoPostflopV31, gtoStreetAdviceV31 } from '../../src/engine/GtoPostflopV31.js';
assert.equal(isMainThread, false, 'serving smoke must execute in a real worker');
const payload: unknown = JSON.parse(process.argv[2]);
assert.ok(payload && typeof payload === 'object' && 'row' in payload && 'input' in payload);
const { row, input } = payload as {
  row: Parameters<typeof replaceGtoPostflopV31>[0][number];
  input: Parameters<typeof gtoStreetAdviceV31>[0];
};
assert.equal(replaceGtoPostflopV31([row]), 1);
const found = gtoStreetAdviceV31(input);
assert.equal(found.hit, true);
if (!found.hit) throw Error('PUBLIC215_WORKER_SERVING_MISS');
assert.deepEqual(found.mix, { c: 0.25, b262: 0.75 });
assert.deepEqual(found.actionEvsBb, { c: 2, b262: 4 });
assert.equal(found.policyEvBb, 7);
assert.equal(found.sourceSeal.policy_representation, 'public_hist215_v1');
assert.equal(found.sourceSeal.model_checksum, row.model_checksum);
assert.equal(found.sourceSeal.template_checksum, row.template_checksum);
assert.equal(found.sourceSeal.feature_schema_checksum, row.feature_schema_checksum);
assert.equal(found.sourceSeal.training_provenance_checksum, row.training_provenance_checksum);
assert.equal(found.sourceSeal.model_build_receipt_checksum, row.model_build_receipt_checksum);
