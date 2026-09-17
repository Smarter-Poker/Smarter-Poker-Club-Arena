// Copied synthetic canonical fixture; this is not solver or installed authority proof.
import type { GtoPostflopV31Row } from '../engine/GtoPostflopV31.js';

const H64 = 'a'.repeat(64);
export const CELL: GtoPostflopV31Row = {
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

export function evaluationCell(datasetId = '22222222-2222-4222-8222-222222222222') {
  return {
    ...structuredClone(CELL),
    dataset_id: datasetId,
    dataset_checksum: '7'.repeat(64),
    dataset_state: 'evaluating' as const,
  };
}

// Finite synthetic loader corpus. The real store validates every row; the
// repeated source seals here are test data, never a certified solver corpus.
export function pagedCells(total: 500 | 501, evaluation = false): GtoPostflopV31Row[] {
  const rows: GtoPostflopV31Row[] = [];
  for (const pot_type of ['limped', 'srp', '3bet'] as const) {
    for (const depth_bucket of [10, 20, 40, 80, 150]) {
      for (const high of 'ABML')
        for (const suits of 'mtr') {
          for (const paired of 'pu')
            for (const connected of 'cd') {
              rows.push({
                ...(evaluation ? evaluationCell() : structuredClone(CELL)),
                pot_type,
                depth_bucket,
                texture_class: `${high}${suits}${paired}${connected}`,
                dataset_cells: total,
              });
              if (rows.length === total) return rows;
            }
        }
    }
  }
  throw new Error('synthetic_loader_fixture_count_unavailable');
}
