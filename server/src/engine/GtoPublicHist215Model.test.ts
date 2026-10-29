import { describe, expect, it } from 'vitest';
import {
  compilePublicHist215,
  decodePublic215F64,
  public215ActionSum,
  public215Digest,
  type PublicHist215Payload,
} from './GtoPublicHist215Model.js';
const hex = (n: number) => {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, n, false);
  return v.getBigUint64(0, false).toString(16).padStart(16, '0');
};
const d = 'a'.repeat(64),
  X = Array(215).fill(0);
function payload(variant: 'direct' | 'coherent' = 'direct'): PublicHist215Payload {
  return {
    format: 'public_hist215_v1',
    feature_count: 215,
    variant,
    action_ids: ['check', 'bet'],
    template_sha256: d,
    feature_schema_sha256: d,
    provenance_sha256: d,
    heads: [7, 2, 4, 0.25, 0.75].map((n) => ({
      baseline_f64: hex(n),
      trees: Array.from({ length: 100 }, () => [{ value_f64: hex(0) }]),
    })),
  };
}
function compile(p: PublicHist215Payload) {
  return compilePublicHist215(p, {
    model_sha256: public215Digest(p),
    template_sha256: d,
    feature_schema_sha256: d,
    provenance_sha256: d,
    action_ids: p.action_ids,
  });
}
describe('public hist215 strict numeric codec', () => {
  it('decodes negative zero/subnormal words without lossy decimal conversion and refuses nonfinite', () => {
    expect(Object.is(decodePublic215F64('8000000000000000'), -0)).toBe(true);
    expect(decodePublic215F64('0000000000000001')).toBe(Number.MIN_VALUE);
    for (const s of [
      '7ff0000000000000',
      'fff0000000000000',
      '7ff8000000000000',
      '3FF0000000000000',
      '1',
    ])
      expect(() => decodePublic215F64(s)).toThrow();
  });
  it('preserves <= numeric splits and ordered already-shrunk leaf additions', () => {
    const p = payload();
    p.heads[0].trees[0] = [
      { feature: 0, threshold_f64: hex(0), left: 1, right: 2, missing_left: true },
      { value_f64: hex(1) },
      { value_f64: hex(-1) },
    ];
    expect(compile(p).predict(X).policyEvBb).toBe(8);
    const high = [...X];
    high[0] = Number.MIN_VALUE;
    expect(compile(p).predict(high).policyEvBb).toBe(6);
    const ordered = payload();
    ordered.heads[0].baseline_f64 = hex(1e16);
    ordered.heads[0].trees[0] = [{ value_f64: hex(1) }];
    ordered.heads[0].trees[1] = [{ value_f64: hex(-1e16) }];
    expect(compile(ordered).predict(X).policyEvBb).toBe(0);
  });
  it('uses whole direct or coherent, clips and normalizes frequencies, refuses zero support', () => {
    expect(compile(payload()).predict(X)).toEqual({
      policyEvBb: 7,
      actionEvsBb: { check: 2, bet: 4 },
      mix: { check: 0.25, bet: 0.75 },
    });
    expect(compile(payload('coherent')).predict(X).policyEvBb).toBe(3.5);
    const p = payload();
    p.heads[3].baseline_f64 = hex(-1);
    p.heads[4].baseline_f64 = hex(2);
    expect(compile(p).predict(X).mix).toEqual({ check: 0, bet: 1 });
    p.heads[4].baseline_f64 = hex(-1);
    expect(() => compile(p).predict(X)).toThrow('EMPTY_FREQUENCY_MASS');
  });
  it('refuses altered bindings, extra code, wrong shape, categorical nodes, cycles and orphan nodes', () => {
    const p = payload();
    expect(() =>
      compilePublicHist215(p, {
        model_sha256: d,
        template_sha256: d,
        feature_schema_sha256: d,
        provenance_sha256: d,
        action_ids: p.action_ids,
      })
    ).toThrow();
    for (const mutate of [
      (p: any) => (p.code = 'eval'),
      (p: any) => p.heads.pop(),
      (p: any) => p.heads[0].trees.pop(),
      (p: any) =>
        (p.heads[0].trees[0] = [
          { feature: 0, threshold_f64: hex(0), left: 0, right: 1, missing_left: false },
          { value_f64: hex(0) },
        ]),
      (p: any) => (p.heads[0].trees[0] = [{ value_f64: hex(0) }, { value_f64: hex(0) }]),
      (p: any) => (p.heads[0].trees[0][0].is_categorical = true),
    ]) {
      const q = payload();
      mutate(q);
      expect(() => compile(q)).toThrow();
    }
    const model = compile(p);
    for (const row of [
      [...X, 0],
      X.slice(1),
      X.map((v, i) => (i === 3 ? NaN : v)),
      X.map((v, i) => (i === 3 ? Infinity : v)),
    ])
      expect(() => model.predict(row)).toThrow();
  });
  it('matches the bounded NumPy action reduction order, including signed zero', () => {
    for (const count of [1, 2, 3, 8, 16])
      expect(Object.is(public215ActionSum(Array(count).fill(-0)), 0)).toBe(true);
    const v = [1e16, 1, -1e16, 1, 1, 1, 1, 1];
    expect(public215ActionSum(v)).toBe(4);
  });
  it('canonicalizes sorted ASCII keys and exact integer metadata only', () => {
    expect(public215Digest({ b: 2, a: 'x' })).toBe(public215Digest({ a: 'x', b: 2 }));
    for (const x of [{ a: NaN }, { a: 1.5 }, { a: 'é' }, { a: -0 }, Array(2)])
      expect(() => public215Digest(x)).toThrow();
  });
});

import { compilePublic215Provenance } from './GtoPublicHist215Model.js';
function provenance(): any {
  const p: any = {
    format: 'public_hist215_training_v1',
    approved_input_bundle_id: '12345678-1234-4234-8234-123456789abc',
    producer_commit: 'b'.repeat(40),
    whole_variant: 'coherent',
    parameters: {
      max_iter: 100,
      max_leaf_nodes: 15,
      min_samples_leaf: 10,
      l2_regularization_f64: '4024000000000000',
      early_stopping: false,
      random_state: 731,
    },
    machine_id: 'M1',
    source_count: 2,
    artifact_count: 1,
    board_count: 1,
    sources: [
      {
        source_row_id: '12345678-1234-4234-8234-123456789abc',
        source_node: 'r:0',
        board: '2c7dTh',
        artifact_checksum: d,
        node_checksum: d,
      },
      {
        source_row_id: '12345678-1234-4234-8234-123456789abc',
        source_node: 'r:0:c',
        board: '2c7dTh',
        artifact_checksum: d,
        node_checksum: d,
      },
    ],
  };
  for (const key of [
    'input_bundle_checksum',
    'manifest_checksum',
    'capture_receipt_checksum',
    'training_recipe_checksum',
    'source_partition_checksum',
    'producer_bundle_checksum',
    'solver_binary_checksum',
    'range_bundle_checksum',
    'icm_model_checksum',
    'feature_schema_checksum',
    'encoder_checksum',
    'physics_checksum',
    'dependency_lock_checksum',
    'runtime_parity_protocol_checksum',
  ])
    p[key] = d;
  return p;
}
describe('public215 training provenance admission format', () => {
  it('retains distinct source nodes sharing their real artifact and board', () => {
    const p = provenance(),
      c = compilePublic215Provenance(p, public215Digest(p));
    expect(c.sourceCount).toBe(2);
    expect(c.artifactCount).toBe(1);
    expect(c.boardCount).toBe(1);
    expect(Object.isFrozen(c.sources[0])).toBe(true);
  });
  it('refuses unbound or reinterpreted source claims without supplying approval', () => {
    for (const change of [
      (p: any) => (p.machine_id = 'M2'),
      (p: any) => (p.parameters.max_iter = 300),
      (p: any) => p.sources.reverse(),
      (p: any) => (p.sources[1].source_node = 'r:0'),
      (p: any) => (p.sources[1].artifact_checksum = 'b'.repeat(64)),
      (p: any) => (p.sources[0].board = '2c2cTh'),
      (p: any) => (p.artifact_count = 2),
      (p: any) => (p.capture_receipt_checksum = '0'.repeat(64)),
    ]) {
      const p = provenance();
      change(p);
      expect(() => compilePublic215Provenance(p, public215Digest(p))).toThrow();
    }
  });
});
