import { createHash } from 'node:crypto';

/** Numeric-only sklearn 1.9.0 HistGradientBoostingRegressor inference.
 * _predictor.pyx SHA256 8c8e3e6408e42d47a908eeff413b1a2d1d827c8ac4e0676e9dd95f861d08274b
 * gradient_boosting.py SHA256 82619e3ae89af1625dea1d4245d0d4a9e2eb85e0d034790fbd89a1bb51d7e996
 * Leaves already include learning-rate shrinkage. No model execution or deserialization.
 */
export const PUBLIC_HIST215_FORMAT = 'public_hist215_v1' as const;
export const PUBLIC_HIST215_FEATURE_COUNT = 215;
export const PUBLIC_HIST215_MAX_ACTIONS = 16;
export const PUBLIC_HIST215_MAX_MODEL_BYTES = 8 * 1024 * 1024;
export type F64Hex = string;
export type PublicHist215Node =
  | { value_f64: F64Hex }
  | { feature: number; threshold_f64: F64Hex; left: number; right: number; missing_left: boolean };
export interface PublicHist215Head {
  baseline_f64: F64Hex;
  trees: PublicHist215Node[][];
}
export interface PublicHist215Payload {
  format: typeof PUBLIC_HIST215_FORMAT;
  variant: 'direct' | 'coherent';
  feature_count: 215;
  action_ids: string[];
  heads: PublicHist215Head[];
  template_sha256: string;
  feature_schema_sha256: string;
  provenance_sha256: string;
}
export interface PublicHist215Bindings {
  model_sha256: string;
  template_sha256: string;
  feature_schema_sha256: string;
  provenance_sha256: string;
  action_ids: readonly string[];
}
export interface PublicHist215Prediction {
  policyEvBb: number;
  actionEvsBb: Record<string, number>;
  mix: Record<string, number>;
}
const HEX64 = /^[a-f0-9]{64}$/;
const fail = (why: string): never => {
  throw new Error('PUBLIC_HIST215_' + why);
};
export function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('OBJECT');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join('\0') !== [...keys].sort().join('\0')) return fail('KEYS');
  return object;
}
export function validPublic215Digest(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value) && value !== '0'.repeat(64);
}
/** Canonical compact JSON: ASCII strings, sorted object keys, safe integral JSON
 * numbers only. All nonintegral model values are exact f64 hex words. */
export function canonicalPublic215Json(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (!/^[\x20-\x7e]*$/.test(value)) return fail('CANONICAL_ASCII');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) return fail('CANONICAL_INTEGER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + Array.from(value, canonicalPublic215Json).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            canonicalPublic215Json(k) +
            ':' +
            canonicalPublic215Json((value as Record<string, unknown>)[k])
        )
        .join(',') +
      '}'
    );
  }
  return fail('CANONICAL_VALUE');
}
export function public215Digest(value: unknown): string {
  return createHash('sha256').update(canonicalPublic215Json(value), 'ascii').digest('hex');
}
/** Big-endian IEEE754 word. DataView preserves negative zero and subnormals. */
export function decodePublic215F64(value: unknown): number {
  if (typeof value !== 'string' || !/^[a-f0-9]{16}$/.test(value)) return fail('F64_WORD');
  const buffer = new ArrayBuffer(8),
    view = new DataView(buffer);
  view.setBigUint64(0, BigInt('0x' + value), false);
  const decoded = view.getFloat64(0, false);
  if (!Number.isFinite(decoded)) return fail('NONFINITE_F64');
  return decoded;
}
interface Tree {
  feature: Int16Array;
  threshold: Float64Array;
  left: Int16Array;
  right: Int16Array;
  value: Float64Array;
  missingLeft: Uint8Array;
}
function compileTree(input: unknown): Tree {
  if (!Array.isArray(input) || input.length < 1 || input.length > 29) return fail('TREE_SIZE');
  const count = input.length;
  const tree: Tree = {
    feature: new Int16Array(count).fill(-1),
    threshold: new Float64Array(count),
    left: new Int16Array(count),
    right: new Int16Array(count),
    value: new Float64Array(count),
    missingLeft: new Uint8Array(count),
  };
  let leaves = 0;
  for (let i = 0; i < count; i++) {
    const raw = input[i];
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'value_f64')) {
      const node = strictObject(raw, ['value_f64']);
      tree.value[i] = decodePublic215F64(node.value_f64);
      leaves++;
    } else {
      const node = strictObject(raw, ['feature', 'threshold_f64', 'left', 'right', 'missing_left']);
      if (
        !Number.isInteger(node.feature) ||
        (node.feature as number) < 0 ||
        (node.feature as number) >= 215
      )
        return fail('FEATURE_INDEX');
      for (const child of [node.left, node.right])
        if (!Number.isInteger(child) || (child as number) < 0 || (child as number) >= count)
          return fail('CHILD_INDEX');
      if (node.left === node.right || typeof node.missing_left !== 'boolean')
        return fail('CHILD_OR_MISSING');
      tree.feature[i] = node.feature as number;
      tree.threshold[i] = decodePublic215F64(node.threshold_f64);
      tree.left[i] = node.left as number;
      tree.right[i] = node.right as number;
      tree.missingLeft[i] = +node.missing_left;
    }
  }
  if (leaves > 15 || count !== 2 * leaves - 1) return fail('LEAF_BOUND');
  const seen = new Set<number>();
  function visit(i: number): void {
    if (seen.has(i)) return fail('TREE_CYCLE_OR_SHARED_CHILD');
    seen.add(i);
    if (tree.feature[i] !== -1) {
      visit(tree.left[i]);
      visit(tree.right[i]);
    }
  }
  visit(0);
  if (seen.size !== count) return fail('UNREACHABLE_NODE');
  return tree;
}
function treePredict(tree: Tree, features: readonly number[]): number {
  let i = 0;
  while (tree.feature[i] !== -1) {
    const x = features[tree.feature[i]];
    i = Number.isNaN(x)
      ? tree.missingLeft[i]
        ? tree.left[i]
        : tree.right[i]
      : x <= tree.threshold[i]
        ? tree.left[i]
        : tree.right[i];
  }
  return tree.value[i];
}
/** NumPy contiguous row pairwise_sum for our bounded action axis (<=16).
 * n<8 starts at -0; n>=8 uses eight accumulators then its fixed reduction.
 */
export function public215ActionSum(values: readonly number[]): number {
  if (values.length < 8) {
    let sum = 0;
    for (const value of values) sum += value;
    return sum;
  }
  const r = values.slice(0, 8);
  let i = 8;
  for (; i + 7 < values.length; i += 8) for (let j = 0; j < 8; j++) r[j] += values[i + j];
  let sum = r[0] + r[1] + (r[2] + r[3]) + (r[4] + r[5] + (r[6] + r[7]));
  for (; i < values.length; i++) sum += values[i];
  // np.sum adds its reduction identity +0 to the pairwise kernel result.
  return 0 + sum;
}
export interface CompiledPublicHist215 {
  readonly format: typeof PUBLIC_HIST215_FORMAT;
  readonly variant: 'direct' | 'coherent';
  readonly actionIds: readonly string[];
  /** Pure numeric inference only. Native feature extraction has its own worker guard. */
  predict(features: readonly number[]): PublicHist215Prediction;
  /** Fresh ordered policy/Q/frequency head values for independent parity receipts. */
  predictRaw(features: readonly number[]): number[];
}
export function compilePublicHist215(
  payload: unknown,
  bindings: PublicHist215Bindings
): CompiledPublicHist215 {
  for (const key of [
    'model_sha256',
    'template_sha256',
    'feature_schema_sha256',
    'provenance_sha256',
  ] as const)
    if (!validPublic215Digest(bindings[key])) return fail('BINDING_DIGEST');
  const model = strictObject(payload, [
    'format',
    'variant',
    'feature_count',
    'action_ids',
    'heads',
    'template_sha256',
    'feature_schema_sha256',
    'provenance_sha256',
  ]);
  if (
    model.format !== PUBLIC_HIST215_FORMAT ||
    model.feature_count !== 215 ||
    (model.variant !== 'direct' && model.variant !== 'coherent')
  )
    return fail('FORMAT');
  for (const key of ['template_sha256', 'feature_schema_sha256', 'provenance_sha256'] as const)
    if (model[key] !== bindings[key]) return fail('DIGEST_REFERENCE');
  const actions = model.action_ids;
  if (
    !Array.isArray(actions) ||
    actions.length < 1 ||
    actions.length > PUBLIC_HIST215_MAX_ACTIONS ||
    actions.some(
      (a) =>
        typeof a !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,96}$/.test(a) ||
        ['__proto__', 'prototype', 'constructor'].includes(a)
    ) ||
    new Set(actions).size !== actions.length ||
    actions.join('\0') !== bindings.action_ids.join('\0')
  )
    return fail('ACTION_ORDER');
  if (!Array.isArray(model.heads) || model.heads.length !== 1 + 2 * actions.length)
    return fail('HEAD_COUNT');
  const heads = model.heads.map((raw) => {
    const head = strictObject(raw, ['baseline_f64', 'trees']);
    if (!Array.isArray(head.trees) || head.trees.length !== 100) return fail('ITERATIONS');
    return { baseline: decodePublic215F64(head.baseline_f64), trees: head.trees.map(compileTree) };
  });
  const text = canonicalPublic215Json(model);
  if (
    Buffer.byteLength(text, 'ascii') > PUBLIC_HIST215_MAX_MODEL_BYTES ||
    createHash('sha256').update(text, 'ascii').digest('hex') !== bindings.model_sha256
  )
    return fail('MODEL_DIGEST_OR_BYTES');
  const actionIds = Object.freeze([...actions]) as readonly string[],
    variant = model.variant;
  const predictRaw = (features: readonly number[]): number[] => {
    if (features.length !== 215 || !features.every(Number.isFinite))
      return fail('FINITE_FEATURE_VECTOR');
    return heads.map((head) => {
      let prediction = 0;
      prediction += head.baseline; // sklearn initializes zeros then adds intercept.
      for (const tree of head.trees) prediction += treePredict(tree, features);
      if (!Number.isFinite(prediction)) return fail('PREDICTION_OVERFLOW');
      return prediction;
    });
  };
  return Object.freeze({
    format: PUBLIC_HIST215_FORMAT,
    variant,
    actionIds,
    predictRaw,
    predict(features: readonly number[]) {
      const raw = predictRaw(features);
      const count = actionIds.length,
        freq = raw.slice(1 + count).map((v) => (v < 0 ? 0 : v > 1 ? 1 : v));
      const total = public215ActionSum(freq);
      if (!(total > 1e-12) || !Number.isFinite(total)) return fail('EMPTY_FREQUENCY_MASS');
      const actionEvsBb: Record<string, number> = {},
        mix: Record<string, number> = {};
      const products: number[] = [];
      for (let i = 0; i < count; i++) {
        const f = freq[i] / total;
        mix[actionIds[i]] = f;
        actionEvsBb[actionIds[i]] = raw[1 + i];
        products.push(f * raw[1 + i]);
      }
      const policyEvBb = variant === 'direct' ? raw[0] : public215ActionSum(products);
      if (!Number.isFinite(policyEvBb)) return fail('COHERENT_OVERFLOW');
      return { policyEvBb, actionEvsBb, mix };
    },
  });
}

const TRAINING_DIGEST_KEYS = [
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
] as const;
export interface Public215TrainingSource {
  readonly source_row_id: string;
  readonly source_node: string;
  readonly board: string;
  readonly artifact_checksum: string;
  readonly node_checksum: string;
}
export interface CompiledPublic215Provenance {
  readonly format: 'public_hist215_training_v1';
  readonly checksum: string;
  readonly approvedInputBundleId: string;
  readonly wholeVariant: 'direct' | 'coherent';
  readonly featureSchemaChecksum: string;
  readonly sourceCount: number;
  readonly artifactCount: number;
  readonly boardCount: number;
  readonly sources: readonly Public215TrainingSource[];
}
/** This proves format and immutable binding only. The database must independently
 * verify these IDs against approved source evidence before admission/certification. */
export function compilePublic215Provenance(
  input: unknown,
  expectedSha256: string
): CompiledPublic215Provenance {
  if (!validPublic215Digest(expectedSha256)) return fail('PROVENANCE_DIGEST');
  const p = strictObject(input, [
    'format',
    'approved_input_bundle_id',
    ...TRAINING_DIGEST_KEYS,
    'producer_commit',
    'whole_variant',
    'parameters',
    'machine_id',
    'source_count',
    'artifact_count',
    'board_count',
    'sources',
  ]);
  if (
    p.format !== 'public_hist215_training_v1' ||
    p.machine_id !== 'M1' ||
    (p.whole_variant !== 'direct' && p.whole_variant !== 'coherent') ||
    typeof p.approved_input_bundle_id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      p.approved_input_bundle_id
    )
  )
    return fail('PROVENANCE_IDENTITY');
  for (const k of TRAINING_DIGEST_KEYS)
    if (!validPublic215Digest(p[k])) return fail('PROVENANCE_HASH');
  if (
    typeof p.producer_commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(p.producer_commit) ||
    p.producer_commit === '0'.repeat(40)
  )
    return fail('PRODUCER_COMMIT');
  const params = strictObject(p.parameters, [
    'max_iter',
    'max_leaf_nodes',
    'min_samples_leaf',
    'l2_regularization_f64',
    'early_stopping',
    'random_state',
  ]);
  if (
    params.max_iter !== 100 ||
    params.max_leaf_nodes !== 15 ||
    params.min_samples_leaf !== 10 ||
    params.l2_regularization_f64 !== '4024000000000000' ||
    params.early_stopping !== false ||
    params.random_state !== 731
  )
    return fail('TRAINING_PARAMETERS');
  if (
    !Number.isSafeInteger(p.source_count) ||
    (p.source_count as number) < 1 ||
    !Number.isSafeInteger(p.board_count) ||
    (p.board_count as number) < 1 ||
    (p.board_count as number) > (p.source_count as number) ||
    !Array.isArray(p.sources) ||
    p.sources.length !== p.source_count
  )
    return fail('SOURCE_CENSUS');
  if (
    !Number.isSafeInteger(p.artifact_count) ||
    (p.artifact_count as number) < 1 ||
    (p.artifact_count as number) > (p.source_count as number)
  )
    return fail('ARTIFACT_CENSUS');
  const sources: Public215TrainingSource[] = [],
    boards = new Set<string>(),
    artifacts = new Map<string, string>();
  let previous = '';
  for (const raw of p.sources) {
    const s = strictObject(raw, [
      'source_row_id',
      'source_node',
      'board',
      'artifact_checksum',
      'node_checksum',
    ]);
    if (
      typeof s.source_row_id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        s.source_row_id
      )
    )
      return fail('SOURCE_ROW_ID');
    if (
      typeof s.source_node !== 'string' ||
      s.source_node.length > 2048 ||
      !/^r:0(?::(?:c|f|b[1-9][0-9]{0,78}|[2-9TJQKA][cdhs]))*$/.test(s.source_node)
    )
      return fail('SOURCE_NODE');
    if (
      typeof s.board !== 'string' ||
      !/^(?:[2-9TJQKA][cdhs]){3,5}$/.test(s.board) ||
      new Set(s.board.match(/../g)).size !== s.board.length / 2
    )
      return fail('SOURCE_BOARD');
    const identity = s.source_row_id + '\0' + s.source_node;
    if (
      identity <= previous ||
      !validPublic215Digest(s.artifact_checksum) ||
      !validPublic215Digest(s.node_checksum) ||
      (artifacts.has(s.source_row_id) && artifacts.get(s.source_row_id) !== s.artifact_checksum)
    )
      return fail('SOURCE_ORDER_OR_HASH');
    previous = identity;
    artifacts.set(s.source_row_id, s.artifact_checksum);
    boards.add(s.board);
    sources.push(Object.freeze({ ...s }) as unknown as Public215TrainingSource);
  }
  if (
    boards.size !== p.board_count ||
    artifacts.size !== p.artifact_count ||
    public215Digest(p) !== expectedSha256
  )
    return fail('PROVENANCE_CENSUS_OR_HASH');
  return Object.freeze({
    format: 'public_hist215_training_v1',
    checksum: expectedSha256,
    approvedInputBundleId: p.approved_input_bundle_id,
    wholeVariant: p.whole_variant,
    featureSchemaChecksum: p.feature_schema_checksum as string,
    sourceCount: p.source_count as number,
    artifactCount: p.artifact_count as number,
    boardCount: p.board_count as number,
    sources: Object.freeze(sources),
  });
}
