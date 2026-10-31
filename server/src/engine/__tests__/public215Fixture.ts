/** Synthetic parser/store fixtures; never certification or execution evidence. */
import { public215Digest } from '../GtoPublicHist215Model.js';
import { PUBLIC_HIST215_FEATURE_SCHEMA_SHA256 as SCHEMA } from '../GtoPublicHist215Features.js';
const H64 = 'a'.repeat(64);
const hex = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b.toString('hex');
};
const CELL: any = {
  dataset_id: '11111111-1111-4111-8111-111111111111',
  dataset_key: 'phase4-canary',
  dataset_checksum: H64,
  solver_version: 'PioSOLVER-3.0',
  solver_binary_checksum: 'b'.repeat(64),
  pipeline_commit: 'c'.repeat(40),
  pipeline_bundle_checksum: 'b'.repeat(64),
  manifest_version: '5',
  manifest_checksum: 'd'.repeat(64),
  source_artifact_checksum: 'e'.repeat(64),
  source_combo_order_checksum: 'f'.repeat(64),
  range_bundle_checksum: '1'.repeat(64),
  icm_model_checksum: '5'.repeat(64),
  input_bundle_checksum: '6'.repeat(64),
  cell_key_checksum: '3'.repeat(64),
  cell_payload_checksum: '4'.repeat(64),
  lineage_checksum: '2'.repeat(64),
  quality_status: 'validated',
  dataset_state: 'active',
  dataset_cells: 1,
  source_rows: 20,
  train_source_rows: 18,
  holdout_source_rows: 2,
  invalid_rows: 0,
  audited_at: '2026-09-08T12:00:00.000Z',
  street: 'turn',
  game_family: 'cash',
  objective: 'cash_ev',
  utility_context: 'cash_ev',
  table_size: 2,
  pot_type: 'limped',
  hero_position: 'SB',
  opponent_position: 'BB',
  depth_bucket: 80,
  texture_class: 'Brud',
  node_role: 'barrel',
  facing_kind: 'none',
  facing_size_bucket: 'none',
  hand_matrix: {
    'AKs:22': { c: 0, b262: 1 },
    'AKs:00': { c: 1, b262: 0 },
  },
  action_specs: {
    c: { family: 'check', size_unit: 'none', size_value: null, all_in: false },
    b262: { family: 'bet', size_unit: 'pot_fraction', size_value: 2.62, all_in: false },
  },
  policy_ev_matrix: { 'AKs:22': 8.4, 'AKs:00': 7.9 },
  action_ev_matrix: {
    'AKs:22': { c: 7.9, b262: 8.4 },
    'AKs:00': { c: 7.9, b262: 8.4 },
  },
};

function fixture(depth = 80, variant: 'direct' | 'coherent' = 'direct'): any {
  const row = structuredClone(CELL);
  delete row.hand_matrix;
  delete row.policy_ev_matrix;
  delete row.action_ev_matrix;
  Object.assign(row, {
    policy_representation: 'public_hist215_v1',
    feature_contract_version: 'holdem-public-hist215-v1',
    policy_export_schema: 'smarter-poker.pio-policy.v4',
    depth_bucket: depth,
    feature_schema_checksum: SCHEMA,
  });
  const context = Object.fromEntries(
    [
      'depth_bucket',
      'facing_kind',
      'facing_size_bucket',
      'game_family',
      'hero_position',
      'node_role',
      'objective',
      'opponent_position',
      'pot_type',
      'street',
      'table_size',
      'texture_class',
      'utility_context',
    ].map((k) => [k, row[k]])
  );
  row.public_template = {
    format: 'public_hist215_template_v1',
    root_actor: 'IP',
    context,
    scenario: {
      pot_chips_f64: hex(60),
      effective_stack_chips_f64: hex(depth * 10),
      chips_per_bb_f64: hex(10),
      rake_f64: [hex(5), hex(3)],
      ip_range_checksum: '01b3d4e721b36cf6d8d89fd4941b5ece0e9fd2853f61d1e5f98fbebb3f8f5228',
      oop_range_checksum: '3ac1e6fa6d92a000680addaf06eab130d2af9467d2e90aceae7cb542b8725c11',
    },
    opponent_weights: Array(1326).fill('1'),
  };
  const p: any = {
    format: 'public_hist215_training_v1',
    approved_input_bundle_id: '12345678-1234-4234-8234-123456789abc',
    producer_commit: row.pipeline_commit,
    whole_variant: variant,
    parameters: {
      max_iter: 100,
      max_leaf_nodes: 15,
      min_samples_leaf: 10,
      l2_regularization_f64: '4024000000000000',
      early_stopping: false,
      random_state: 731,
    },
    machine_id: 'M1',
    source_count: 1,
    artifact_count: 1,
    board_count: 1,
    sources: [
      {
        source_row_id: '12345678-1234-4234-8234-123456789abc',
        source_node: 'r:0',
        board: 'Qh9d7c2h',
        artifact_checksum: H64,
        node_checksum: H64,
      },
    ],
  };
  for (const k of [
    'input_bundle_checksum',
    'manifest_checksum',
    'producer_bundle_checksum',
    'solver_binary_checksum',
    'range_bundle_checksum',
    'icm_model_checksum',
    'feature_schema_checksum',
  ])
    p[k] = k === 'producer_bundle_checksum' ? row.pipeline_bundle_checksum : row[k];
  for (const k of [
    'capture_receipt_checksum',
    'training_recipe_checksum',
    'source_partition_checksum',
    'encoder_checksum',
    'physics_checksum',
    'dependency_lock_checksum',
    'runtime_parity_protocol_checksum',
  ])
    p[k] = H64;
  row.public_training_provenance = p;
  row.public_model = {
    format: 'public_hist215_v1',
    feature_count: 215,
    variant,
    action_ids: ['c', 'b262'],
    heads: [7, 2, 4, 0.25, 0.75].map((n) => ({
      baseline_f64: hex(n),
      trees: Array.from({ length: 100 }, () => [{ value_f64: hex(0) }]),
    })),
  };
  // Opposite insertion order models jsonb key-order drift while head order stays explicit.
  row.action_specs = { b262: row.action_specs.b262, c: row.action_specs.c };
  return bind(row);
}
function bind(r: any): any {
  r.template_checksum = public215Digest(r.public_template);
  r.training_provenance_checksum = public215Digest(r.public_training_provenance);
  Object.assign(r.public_model, {
    template_sha256: r.template_checksum,
    feature_schema_sha256: r.feature_schema_checksum,
    provenance_sha256: r.training_provenance_checksum,
  });
  r.model_checksum = public215Digest(r.public_model);
  // Synthetic parser/store fixture only. SQL certification independently
  // recomputes public features; these zero vectors are not execution evidence.
  const cases = ['Qh9d7c2h', 'Qh9d7c3h'].map((board, i) => ({
    board,
    own: ['As', 'Ks'],
    features_f64: Array(215).fill(hex(0)),
    raw_heads_f64: [7, 2, 4, 0.25, 0.75].map(hex),
    policy_ev_f64: hex(r.public_model.variant === 'direct' ? 7 : 3.5),
    Q_f64: [2, 4].map(hex),
    frequency_f64: [0.25, 0.75].map(hex),
    physics_ms_f64: hex(1 + i),
    inference_ms_f64: hex(2 + i),
  }));
  const p = r.public_training_provenance;
  r.public_model_build_receipt = {
    format: 'public_hist215_build_receipt_v1',
    dataset_id: r.dataset_id,
    input_bundle_checksum: r.input_bundle_checksum,
    model_checksum: r.model_checksum,
    training_provenance_checksum: r.training_provenance_checksum,
    template_checksum: r.template_checksum,
    feature_schema_checksum: r.feature_schema_checksum,
    encoder_checksum: p.encoder_checksum,
    physics_checksum: p.physics_checksum,
    dependency_lock_checksum: p.dependency_lock_checksum,
    producer_commit: r.pipeline_commit,
    producer_bundle_checksum: r.pipeline_bundle_checksum,
    runtime: {
      node_version: 'v22.23.3',
      platform: 'linux',
      arch: 'x64',
      napi_version: 8,
      native_source_checksum: '83442cb6604dfaa30ec7ecc6ce38957355609e722b5df85b866365c97f0ccf9b',
      native_binary_checksum: H64,
    },
    cases,
    cost: {
      method: 'cold_public215_features_and_all_heads_v1',
      clock: 'process.hrtime.bigint',
      cold_cases: 2,
      max_physics_ms_f64: hex(2),
      max_inference_ms_f64: hex(3),
      execution_limit_ms: 8000,
      model_bytes: Buffer.byteLength(JSON.stringify(r.public_model)),
      head_count: 5,
    },
  };
  r.model_build_receipt_checksum = public215Digest(r.public_model_build_receipt);
  return r;
}
const input: any = {
  street: 'turn',
  family: 'cash',
  objective: 'cash_ev',
  utilityContext: 'cash_ev',
  tableSize: 2,
  potType: 'limped',
  heroPosition: 'SB',
  opponentPosition: 'BB',
  stackBB: 80,
  board: [
    { rank: 'Q', suit: 'hearts' },
    { rank: '9', suit: 'diamonds' },
    { rank: '7', suit: 'clubs' },
    { rank: '2', suit: 'hearts' },
  ],
  hand: 'AKs',
  holeCards: [
    { rank: 'A', suit: 'spades' },
    { rank: 'K', suit: 'spades' },
  ],
  nodeRole: 'barrel',
  facingKind: 'none',
  facingSizeBucket: 'none',
};

export { fixture, bind, hex, input };
