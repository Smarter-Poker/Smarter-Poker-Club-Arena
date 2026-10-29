import {
  canonicalPublic215Json,
  decodePublic215F64,
  public215Digest,
  strictObject,
  validPublic215Digest,
  type CompiledPublicHist215,
} from './GtoPublicHist215Model.js';

const NATIVE_SOURCE = '83442cb6604dfaa30ec7ecc6ce38957355609e722b5df85b866365c97f0ccf9b';
const HASH_KEYS = [
  'input_bundle_checksum',
  'model_checksum',
  'training_provenance_checksum',
  'template_checksum',
  'feature_schema_checksum',
  'encoder_checksum',
  'physics_checksum',
  'dependency_lock_checksum',
  'producer_bundle_checksum',
] as const;
const fail = (reason: string): never => {
  throw new Error('PUBLIC_HIST215_BUILD_' + reason);
};
const word = (value: number): string => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return bytes.toString('hex');
};

export interface Public215BuildBindings {
  receipt_checksum: string;
  dataset_id: string;
  input_bundle_checksum: string;
  model_checksum: string;
  training_provenance_checksum: string;
  template_checksum: string;
  feature_schema_checksum: string;
  encoder_checksum: string;
  physics_checksum: string;
  dependency_lock_checksum: string;
  producer_commit: string;
  producer_bundle_checksum: string;
  street: 'flop' | 'turn' | 'river';
  model_payload: unknown;
  model: CompiledPublicHist215;
}

/** Admission verifies the complete immutable receipt and numeric model outputs.
 * Public features must also have been independently recomputed by PostgreSQL
 * before sealing. This parser does not treat claimed timing as execution proof,
 * run native work on the main thread, or replace the protected qualification.
 */
export function validatePublic215BuildReceipt(input: unknown, bindings: Public215BuildBindings) {
  const r = strictObject(input, [
    'format',
    'dataset_id',
    ...HASH_KEYS,
    'producer_commit',
    'runtime',
    'cases',
    'cost',
  ]);
  if (
    r.format !== 'public_hist215_build_receipt_v1' ||
    r.dataset_id !== bindings.dataset_id ||
    r.producer_commit !== bindings.producer_commit ||
    !validPublic215Digest(bindings.receipt_checksum) ||
    public215Digest(r) !== bindings.receipt_checksum
  )
    return fail('IDENTITY');
  for (const key of HASH_KEYS) {
    if (!validPublic215Digest(r[key]) || r[key] !== bindings[key]) return fail('BINDING');
  }
  const runtime = strictObject(r.runtime, [
    'node_version',
    'platform',
    'arch',
    'napi_version',
    'native_source_checksum',
    'native_binary_checksum',
  ]);
  if (
    typeof runtime.node_version !== 'string' ||
    !/^v22\.[0-9]+\.[0-9]+$/.test(runtime.node_version) ||
    runtime.platform !== 'linux' ||
    !['x64', 'arm64'].includes(runtime.arch as string) ||
    runtime.napi_version !== 8 ||
    runtime.native_source_checksum !== NATIVE_SOURCE ||
    !validPublic215Digest(runtime.native_binary_checksum)
  )
    return fail('RUNTIME');
  const actions = bindings.model.actionIds;
  if (!Array.isArray(r.cases) || r.cases.length < 2 || r.cases.length > 32) return fail('CASES');
  const vector = (value: unknown, size: number): number[] => {
    if (!Array.isArray(value) || value.length !== size) return fail('VECTOR');
    return value.map(decodePublic215F64);
  };
  let maxPhysics = 0,
    maxInference = 0;
  const seen = new Set<string>();
  for (const raw of r.cases) {
    const c = strictObject(raw, [
      'board',
      'own',
      'features_f64',
      'raw_heads_f64',
      'policy_ev_f64',
      'Q_f64',
      'frequency_f64',
      'physics_ms_f64',
      'inference_ms_f64',
    ]);
    const boardCount = { flop: 3, turn: 4, river: 5 }[bindings.street];
    if (
      typeof c.board !== 'string' ||
      c.board.length !== 2 * boardCount ||
      !/^(?:[2-9TJQKA][cdhs]){3,5}$/.test(c.board) ||
      !Array.isArray(c.own) ||
      c.own.length !== 2 ||
      c.own.some((card) => typeof card !== 'string' || !/^[2-9TJQKA][cdhs]$/.test(card))
    )
      return fail('CARDS');
    const cards = [...c.own, ...c.board.match(/../g)!];
    if (new Set(cards).size !== cards.length) return fail('DUPLICATE_CARD');
    const identity = c.board + ':' + [...c.own].sort().join('');
    if (seen.has(identity)) return fail('DUPLICATE_CASE');
    seen.add(identity);
    const features = vector(c.features_f64, 215);
    const heads = vector(c.raw_heads_f64, 1 + 2 * actions.length);
    const qs = vector(c.Q_f64, actions.length);
    const frequencies = vector(c.frequency_f64, actions.length);
    const policy = decodePublic215F64(c.policy_ev_f64);
    const actual = bindings.model.predict(features);
    const actualRaw = bindings.model.predictRaw(features);
    if (heads.some((value, i) => word(value) !== word(actualRaw[i])))
      return fail('RAW_HEAD_OUTPUT');
    for (let i = 0; i < actions.length; i++) {
      if (
        word(qs[i]) !== word(heads[1 + i]) ||
        word(qs[i]) !== word(actual.actionEvsBb[actions[i]]) ||
        frequencies[i] < 0 ||
        frequencies[i] > 1 ||
        word(frequencies[i]) !== word(actual.mix[actions[i]])
      )
        return fail('MODEL_OUTPUT');
    }
    if (
      word(policy) !== word(actual.policyEvBb) ||
      (bindings.model.variant === 'direct' && word(policy) !== word(heads[0]))
    )
      return fail('POLICY_OUTPUT');
    const physics = decodePublic215F64(c.physics_ms_f64),
      inference = decodePublic215F64(c.inference_ms_f64);
    if (!(physics > 0) || inference < physics || inference > 8000) return fail('CASE_COST');
    maxPhysics = Math.max(maxPhysics, physics);
    maxInference = Math.max(maxInference, inference);
  }
  const cost = strictObject(r.cost, [
    'method',
    'clock',
    'cold_cases',
    'max_physics_ms_f64',
    'max_inference_ms_f64',
    'execution_limit_ms',
    'model_bytes',
    'head_count',
  ]);
  if (
    cost.method !== 'cold_public215_features_and_all_heads_v1' ||
    cost.clock !== 'process.hrtime.bigint' ||
    cost.cold_cases !== r.cases.length ||
    cost.execution_limit_ms !== 8000 ||
    cost.head_count !== 1 + 2 * actions.length ||
    cost.model_bytes !==
      Buffer.byteLength(canonicalPublic215Json(bindings.model_payload), 'ascii') ||
    cost.max_physics_ms_f64 !== word(maxPhysics) ||
    cost.max_inference_ms_f64 !== word(maxInference)
  )
    return fail('COST_CENSUS');
  return Object.freeze({
    checksum: bindings.receipt_checksum,
    cases: r.cases.length,
    runtime: Object.freeze({ ...runtime }),
    modelBytes: cost.model_bytes,
  });
}
