import { describe, it, expect } from 'vitest';
import { public215Digest } from '../engine/GtoPublicHist215Model.js';
import { fixture } from '../engine/__tests__/public215Fixture.js';
import { runPublic215Preflight, validatePreflightRequest } from './public215ModelPreflight.js';
function request() {
  const r = fixture();
  return {
    format: 'public_hist215_preflight_request_v1',
    dataset_id: r.dataset_id,
    program: Object.fromEntries(
      [
        'context',
        'policy_representation',
        'public_model',
        'public_template',
        'public_training_provenance',
        'model_checksum',
        'template_checksum',
        'feature_schema_checksum',
        'training_provenance_checksum',
      ].map((k) => [k, k === 'context' ? r.public_template.context : r[k]])
    ),
    cases: [
      { board: 'Qh9d7c2h', own: ['Ks', 'As'] },
      { board: 'Qh9d7c3h', own: ['Ks', 'As'] },
    ],
  };
}
describe('finite public215 execution admission', () => {
  it('accepts bound pure programs without constructing a runtime cell', () => {
    const r = validatePreflightRequest(request());
    expect(r.model.actionIds).toEqual(['c', 'b262']);
    expect(r.cases).toHaveLength(2);
  });
  it('refuses private/extra inputs, changed programs, reused and illegal cases', () => {
    for (const edit of [
      (r: any) => (r.secret = 'no'),
      (r: any) => (r.program.model_checksum = 'b'.repeat(64)),
      (r: any) => (r.cases[1] = r.cases[0]),
      (r: any) => (r.cases[0].own = ['Qh', 'As']),
      (r: any) => (r.cases[0].board = 'Qh9d7c'),
    ]) {
      const r = request();
      edit(r);
      expect(() => validatePreflightRequest(r)).toThrow();
    }
  });
  it('refuses a self-consistently rehashed foreign feature schema', () => {
    const r: any = request(),
      p = r.program;
    p.feature_schema_checksum = 'b'.repeat(64);
    p.public_training_provenance.feature_schema_checksum = p.feature_schema_checksum;
    p.training_provenance_checksum = public215Digest(p.public_training_provenance);
    p.public_model.feature_schema_sha256 = p.feature_schema_checksum;
    p.public_model.provenance_sha256 = p.training_provenance_checksum;
    p.model_checksum = public215Digest(p.public_model);
    expect(() => validatePreflightRequest(r)).toThrow('IMPLEMENTED_FEATURE_SCHEMA');
  });
  it('never runs native physics on the controller thread', () =>
    expect(() => runPublic215Preflight(request())).toThrow('WORKER_REQUIRED'));
});
