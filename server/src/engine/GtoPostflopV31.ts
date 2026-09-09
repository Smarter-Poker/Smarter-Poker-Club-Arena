/**
 * V31 certified NLH postflop policy store.
 *
 * The source warehouse is never queried on an action clock. A promoted,
 * independently held-out dataset is compacted in the database, loaded into
 * memory, and then read synchronously. Every runtime row carries the complete
 * dataset and cell seal. One malformed or unsealed row rejects the whole
 * refresh, preserving the last known-good in-memory snapshot.
 *
 * Node semantics are part of the key. A facing-bet, facing-raise, check-raise,
 * bet-raise, all-in, probe, delayed-cbet, barrel, or open policy can only
 * answer the matching public action state. There is no ICM-to-chip-EV family
 * fallback and no response synthesized from an open node here.
 */

import type { Card } from '../types.js';
import { depthCandidates, textureClass } from './GtoPostflop.js';
import type {
  GtoV31FacingKind,
  GtoV31NodeRole,
  GtoV31Position,
  GtoV31PotType,
  GtoV31SizeBucket,
  GtoV31UtilityContext,
} from './GtoDecisionContext.js';

export type GtoV31GameFamily = 'cash' | 'spin' | 'tourney_ev' | 'tourney_icm';
export type GtoV31Objective = 'cash_ev' | 'chip_ev' | 'icm';
export type GtoV31ActionFamily = 'check' | 'fold' | 'call' | 'bet' | 'raise' | 'all_in';

export interface GtoV31ActionSpec {
  family: GtoV31ActionFamily;
  size_unit: 'none' | 'pot_fraction' | 'pot_after_call_fraction' | 'all_in';
  size_value: number | null;
  all_in: boolean;
}

export interface GtoV31SourceSeal {
  dataset_id: string;
  dataset_key: string;
  dataset_checksum: string;
  solver_version: string;
  solver_binary_checksum: string;
  pipeline_commit: string;
  pipeline_bundle_checksum: string;
  manifest_version: string;
  manifest_checksum: string;
  source_artifact_checksum: string;
  source_combo_order_checksum: string;
  range_bundle_checksum: string;
  icm_model_checksum: string;
  input_bundle_checksum: string;
  cell_key_checksum: string;
  cell_payload_checksum: string;
  lineage_checksum: string;
  quality_status: 'validated';
  dataset_state: 'evaluating' | 'candidate' | 'active';
  dataset_cells: number;
  source_rows: number;
  train_source_rows: number;
  holdout_source_rows: number;
  invalid_rows: 0;
  audited_at: string;
}

export interface GtoPostflopV31Row extends GtoV31SourceSeal {
  street: 'flop' | 'turn' | 'river';
  game_family: GtoV31GameFamily;
  objective: GtoV31Objective;
  utility_context: GtoV31UtilityContext;
  table_size: number;
  pot_type: GtoV31PotType;
  hero_position: GtoV31Position;
  opponent_position: GtoV31Position;
  depth_bucket: number;
  texture_class: string;
  node_role: GtoV31NodeRole;
  facing_kind: GtoV31FacingKind;
  facing_size_bucket: GtoV31SizeBucket;
  hand_matrix: Record<string, Record<string, number>>;
  action_specs: Record<string, GtoV31ActionSpec>;
  policy_ev_matrix?: Record<string, number | null> | null;
  action_ev_matrix?: Record<string, Record<string, number | null>> | null;
}

export type GtoV31Miss = 'no_hand' | 'no_texture' | 'no_cell' | 'hand_not_in_cell' | 'empty_store';

export type GtoV31Lookup =
  | {
      hit: true;
      mix: Record<string, number>;
      actions: Record<string, GtoV31ActionSpec>;
      policyEvBb: number | null;
      actionEvsBb: Record<string, number | null> | null;
      cell: string;
      sourceSeal: GtoV31SourceSeal;
      nodeRole: GtoV31NodeRole;
      depthBucket: number;
    }
  | { hit: false; miss: GtoV31Miss };

interface StoredCell {
  matrix: Record<string, Record<string, number>>;
  actions: Record<string, GtoV31ActionSpec>;
  policyEvs: Record<string, number | null>;
  actionEvs: Record<string, Record<string, number | null>>;
  seal: GtoV31SourceSeal;
  role: GtoV31NodeRole;
}

interface Store {
  cells: Map<string, StoredCell>;
  datasetId: string | null;
  datasetChecksum: string | null;
}

const makeStore = (): Store => ({
  cells: new Map<string, StoredCell>(),
  datasetId: null,
  datasetChecksum: null,
});

// The live store and every evaluation store are physically distinct objects.
// A candidate can only be selected by its immutable checksum and can never be
// swapped into the live action path by loading order or shared map mutation.
const activeStore: Store = makeStore();
const evaluationStores = new Map<string, Store>();
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIONS = new Set(['UTG', 'UTG1', 'UTG2', 'UTG3', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
const DEPTHS = new Set([10, 20, 40, 80, 150]);
const POT_TYPES = new Set<GtoV31PotType>(['limped', 'srp', '3bet', '4bet_plus']);
const UTILITY_CONTEXTS = new Set<GtoV31UtilityContext>([
  'cash_ev',
  'chip_ev',
  'spin_ladder',
  'satellite',
  'bubble',
  'final_table',
  'in_money',
  'ladder',
]);
const OPEN_ROLES = new Set<GtoV31NodeRole>(['open', 'cbet', 'probe', 'delayed_cbet', 'barrel']);
const RESPONSE_ROLES = new Set<GtoV31NodeRole>([
  'facing_bet',
  'facing_raise',
  'check_raise',
  'bet_raise',
  'all_in',
]);
const TEXTURE_CLASS = /^[ABML][mtr][pu][cd]$/;
const RANK_INDEX: Record<string, number> = Object.fromEntries(
  [...'AKQJT98765432'].map((rank, index) => [rank, index])
);

function canonicalHandKey(value: string): boolean {
  if (typeof value !== 'string') return false;
  const match = /^([AKQJT98765432])([AKQJT98765432])([so]?):([0-2])$/.exec(value);
  if (!match) return false;
  const [, first, second, suitedness] = match;
  if (first === second) return suitedness === '';
  return suitedness !== '' && RANK_INDEX[first] < RANK_INDEX[second];
}

const TABLE_POSITIONS: Record<number, ReadonlySet<string>> = {
  2: new Set(['SB', 'BB']),
  3: new Set(['SB', 'BB', 'BTN']),
  4: new Set(['SB', 'BB', 'CO', 'BTN']),
  5: new Set(['SB', 'BB', 'HJ', 'CO', 'BTN']),
  6: new Set(['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN']),
  7: new Set(['SB', 'BB', 'UTG', 'MP', 'HJ', 'CO', 'BTN']),
  8: new Set(['SB', 'BB', 'UTG', 'UTG1', 'MP', 'HJ', 'CO', 'BTN']),
  9: new Set(['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'MP', 'HJ', 'CO', 'BTN']),
  10: new Set(['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'UTG3', 'MP', 'HJ', 'CO', 'BTN']),
};

const SUIT_INDEX: Record<string, number> = {
  clubs: 0,
  diamonds: 1,
  hearts: 2,
  spades: 3,
};

function key(args: {
  street: string;
  family: string;
  objective: string;
  utilityContext: string;
  tableSize: number;
  potType: string;
  heroPosition: string;
  opponentPosition: string;
  depth: number;
  texture: string;
  nodeRole: string;
  facingKind: string;
  facingSizeBucket: string;
}): string {
  return [
    args.street,
    args.family,
    args.objective,
    args.utilityContext,
    args.tableSize,
    args.potType,
    args.heroPosition,
    args.opponentPosition,
    args.depth,
    args.texture,
    args.nodeRole,
    args.facingKind,
    args.facingSizeBucket,
  ].join('|');
}

function objectiveMatchesFamily(family: GtoV31GameFamily, objective: GtoV31Objective): boolean {
  if (family === 'cash') return objective === 'cash_ev';
  if (family === 'tourney_icm') return objective === 'icm';
  return objective === 'chip_ev' || (family === 'spin' && objective === 'icm');
}

function utilityMatchesObjective(row: GtoPostflopV31Row): boolean {
  if (row.objective === 'cash_ev') return row.utility_context === 'cash_ev';
  if (row.objective === 'chip_ev') return row.utility_context === 'chip_ev';
  if (row.game_family === 'spin') return row.utility_context === 'spin_ladder';
  return ['satellite', 'bubble', 'final_table', 'in_money', 'ladder'].includes(row.utility_context);
}

function contextIsCoherent(row: GtoPostflopV31Row): boolean {
  if (OPEN_ROLES.has(row.node_role)) {
    return row.facing_kind === 'none' && row.facing_size_bucket === 'none';
  }
  if (!RESPONSE_ROLES.has(row.node_role)) return false;
  if (row.node_role === 'all_in') {
    return row.facing_kind === 'all_in' && row.facing_size_bucket === 'all_in';
  }
  if (row.node_role === 'facing_bet' && row.facing_kind !== 'bet') return false;
  if (
    ['facing_raise', 'check_raise', 'bet_raise'].includes(row.node_role) &&
    row.facing_kind !== 'raise'
  ) {
    return false;
  }
  return row.facing_size_bucket !== 'none' && row.facing_size_bucket !== 'all_in';
}

function sealIsValid(
  row: GtoPostflopV31Row,
  allowedStates: ReadonlySet<GtoV31SourceSeal['dataset_state']>
): boolean {
  const nonzero64 = (value: unknown): value is string =>
    typeof value === 'string' && HEX64.test(value) && value !== '0'.repeat(64);
  return (
    UUID.test(row.dataset_id) &&
    typeof row.dataset_key === 'string' &&
    row.dataset_key.length > 0 &&
    nonzero64(row.dataset_checksum) &&
    typeof row.solver_version === 'string' &&
    row.solver_version.length > 0 &&
    nonzero64(row.solver_binary_checksum) &&
    HEX40.test(row.pipeline_commit) &&
    nonzero64(row.pipeline_bundle_checksum) &&
    typeof row.manifest_version === 'string' &&
    row.manifest_version.length > 0 &&
    nonzero64(row.manifest_checksum) &&
    nonzero64(row.source_artifact_checksum) &&
    nonzero64(row.source_combo_order_checksum) &&
    nonzero64(row.range_bundle_checksum) &&
    nonzero64(row.icm_model_checksum) &&
    nonzero64(row.input_bundle_checksum) &&
    nonzero64(row.cell_key_checksum) &&
    nonzero64(row.cell_payload_checksum) &&
    nonzero64(row.lineage_checksum) &&
    row.quality_status === 'validated' &&
    allowedStates.has(row.dataset_state) &&
    Number.isInteger(row.dataset_cells) &&
    row.dataset_cells > 0 &&
    Number.isInteger(row.source_rows) &&
    row.source_rows > 0 &&
    Number.isInteger(row.train_source_rows) &&
    row.train_source_rows > 0 &&
    Number.isInteger(row.holdout_source_rows) &&
    row.holdout_source_rows > 0 &&
    row.invalid_rows === 0 &&
    typeof row.audited_at === 'string' &&
    Number.isFinite(Date.parse(row.audited_at))
  );
}

function datasetSealKey(row: GtoPostflopV31Row): string {
  return JSON.stringify({
    dataset_id: row.dataset_id,
    dataset_key: row.dataset_key,
    dataset_checksum: row.dataset_checksum,
    solver_version: row.solver_version,
    solver_binary_checksum: row.solver_binary_checksum,
    pipeline_commit: row.pipeline_commit,
    pipeline_bundle_checksum: row.pipeline_bundle_checksum,
    manifest_version: row.manifest_version,
    manifest_checksum: row.manifest_checksum,
    source_artifact_checksum: row.source_artifact_checksum,
    source_combo_order_checksum: row.source_combo_order_checksum,
    range_bundle_checksum: row.range_bundle_checksum,
    icm_model_checksum: row.icm_model_checksum,
    input_bundle_checksum: row.input_bundle_checksum,
    quality_status: row.quality_status,
    dataset_state: row.dataset_state,
    dataset_cells: row.dataset_cells,
    source_rows: row.source_rows,
    train_source_rows: row.train_source_rows,
    holdout_source_rows: row.holdout_source_rows,
    invalid_rows: row.invalid_rows,
    audited_at: row.audited_at,
  });
}

function actionSpecIsValid(spec: GtoV31ActionSpec): boolean {
  if (!spec || !['check', 'fold', 'call', 'bet', 'raise', 'all_in'].includes(spec.family)) {
    return false;
  }
  if (spec.family === 'all_in') {
    return spec.all_in === true && spec.size_unit === 'all_in' && spec.size_value === null;
  }
  if (spec.family === 'bet' || spec.family === 'raise') {
    const expected = spec.family === 'bet' ? 'pot_fraction' : 'pot_after_call_fraction';
    return (
      spec.all_in === false &&
      spec.size_unit === expected &&
      typeof spec.size_value === 'number' &&
      Number.isFinite(spec.size_value) &&
      spec.size_value > 0
    );
  }
  return spec.all_in === false && spec.size_unit === 'none' && spec.size_value === null;
}

function rowIsValid(
  row: GtoPostflopV31Row,
  allowedStates: ReadonlySet<GtoV31SourceSeal['dataset_state']>
): boolean {
  const allowedPositions = TABLE_POSITIONS[row?.table_size];
  if (
    !row ||
    !['flop', 'turn', 'river'].includes(row.street) ||
    !['cash', 'spin', 'tourney_ev', 'tourney_icm'].includes(row.game_family) ||
    !objectiveMatchesFamily(row.game_family, row.objective) ||
    !UTILITY_CONTEXTS.has(row.utility_context) ||
    !utilityMatchesObjective(row) ||
    !Number.isInteger(row.table_size) ||
    row.table_size < 2 ||
    row.table_size > 10 ||
    !POT_TYPES.has(row.pot_type) ||
    !POSITIONS.has(row.hero_position) ||
    !POSITIONS.has(row.opponent_position) ||
    !allowedPositions?.has(row.hero_position) ||
    !allowedPositions?.has(row.opponent_position) ||
    row.hero_position === row.opponent_position ||
    !DEPTHS.has(row.depth_bucket) ||
    typeof row.texture_class !== 'string' ||
    !TEXTURE_CLASS.test(row.texture_class) ||
    !contextIsCoherent(row) ||
    !sealIsValid(row, allowedStates) ||
    !row.hand_matrix ||
    typeof row.hand_matrix !== 'object' ||
    Array.isArray(row.hand_matrix) ||
    !row.action_specs ||
    typeof row.action_specs !== 'object' ||
    Array.isArray(row.action_specs)
  ) {
    return false;
  }
  const actionIds = Object.keys(row.action_specs);
  if (
    actionIds.length < 2 ||
    actionIds.some((id) => !id || !actionSpecIsValid(row.action_specs[id]))
  ) {
    return false;
  }
  const families = new Set(actionIds.map((id) => row.action_specs[id].family));
  if (OPEN_ROLES.has(row.node_role)) {
    if (
      !families.has('check') ||
      [...families].some((family) => ['fold', 'call', 'raise'].includes(family))
    ) {
      return false;
    }
  } else {
    if (!families.has('fold') || !families.has('call')) return false;
    if (families.has('check') || families.has('bet')) return false;
    if (
      row.node_role === 'all_in' &&
      [...families].some((family) => family !== 'fold' && family !== 'call')
    ) {
      return false;
    }
  }

  const hands = Object.entries(row.hand_matrix);
  if (hands.length === 0) return false;
  const policyEvs = row.policy_ev_matrix;
  const actionEvs = row.action_ev_matrix;
  if (
    !policyEvs ||
    typeof policyEvs !== 'object' ||
    Array.isArray(policyEvs) ||
    !actionEvs ||
    typeof actionEvs !== 'object' ||
    Array.isArray(actionEvs) ||
    Object.keys(policyEvs).length !== hands.length ||
    Object.keys(actionEvs).length !== hands.length
  ) {
    return false;
  }
  for (const [handKey, mix] of hands) {
    if (!canonicalHandKey(handKey)) return false;
    if (!mix || typeof mix !== 'object' || Array.isArray(mix)) return false;
    const entries = Object.entries(mix);
    if (
      entries.length !== actionIds.length ||
      entries.some(([id]) => !row.action_specs[id]) ||
      actionIds.some((id) => !(id in mix))
    ) {
      return false;
    }
    const values = entries.map(([, value]) => value);
    if (
      values.some(
        (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1
      )
    ) {
      return false;
    }
    const sum = values.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - 1) > 0.002) return false;

    const policyEv = policyEvs[handKey];
    const handActionEvs = actionEvs[handKey];
    if (
      typeof policyEv !== 'number' ||
      !Number.isFinite(policyEv) ||
      !handActionEvs ||
      typeof handActionEvs !== 'object' ||
      Array.isArray(handActionEvs) ||
      Object.keys(handActionEvs).length !== actionIds.length ||
      actionIds.some(
        (id) => typeof handActionEvs[id] !== 'number' || !Number.isFinite(handActionEvs[id])
      )
    ) {
      return false;
    }
    // The database validates policy EV = frequency-weighted action EV for
    // every source combo before compaction. At compact hand-class level,
    // policy EV, frequencies, and counterfactual action EVs are each
    // reach-weighted aggregates. Their product is not algebraically required
    // to equal the separately averaged source policy EV when frequency and EV
    // covary across suits/runouts. Reapplying the source identity here rejects
    // valid sealed cells; completeness and finiteness remain mandatory.
  }
  if (
    Object.keys(policyEvs).some((handKey) => !(handKey in row.hand_matrix)) ||
    Object.keys(actionEvs).some((handKey) => !(handKey in row.hand_matrix))
  ) {
    return false;
  }
  return true;
}

function sealOf(row: GtoPostflopV31Row): GtoV31SourceSeal {
  return {
    dataset_id: row.dataset_id,
    dataset_key: row.dataset_key,
    dataset_checksum: row.dataset_checksum,
    solver_version: row.solver_version,
    solver_binary_checksum: row.solver_binary_checksum,
    pipeline_commit: row.pipeline_commit,
    pipeline_bundle_checksum: row.pipeline_bundle_checksum,
    manifest_version: row.manifest_version,
    manifest_checksum: row.manifest_checksum,
    source_artifact_checksum: row.source_artifact_checksum,
    source_combo_order_checksum: row.source_combo_order_checksum,
    range_bundle_checksum: row.range_bundle_checksum,
    icm_model_checksum: row.icm_model_checksum,
    input_bundle_checksum: row.input_bundle_checksum,
    cell_key_checksum: row.cell_key_checksum,
    cell_payload_checksum: row.cell_payload_checksum,
    lineage_checksum: row.lineage_checksum,
    quality_status: row.quality_status,
    dataset_state: row.dataset_state,
    dataset_cells: row.dataset_cells,
    source_rows: row.source_rows,
    train_source_rows: row.train_source_rows,
    holdout_source_rows: row.holdout_source_rows,
    invalid_rows: row.invalid_rows,
    audited_at: row.audited_at,
  };
}

function validatedStore(
  rows: GtoPostflopV31Row[],
  allowedStates: ReadonlySet<GtoV31SourceSeal['dataset_state']>
): Store {
  if (!Array.isArray(rows)) throw new Error('v31_certified_rows_not_array');
  const next = new Map<string, StoredCell>();
  let datasetId: string | null = null;
  let datasetChecksum: string | null = null;
  let datasetCells: number | null = null;
  let datasetSeal: string | null = null;
  for (const row of rows) {
    if (!rowIsValid(row, allowedStates)) throw new Error('v31_uncertified_or_malformed_cell');
    if (datasetId && datasetId !== row.dataset_id) throw new Error('v31_multiple_active_datasets');
    if (datasetChecksum && datasetChecksum !== row.dataset_checksum) {
      throw new Error('v31_dataset_checksum_mismatch');
    }
    if (datasetCells !== null && datasetCells !== row.dataset_cells) {
      throw new Error('v31_dataset_cell_count_mismatch');
    }
    const sealKey = datasetSealKey(row);
    if (datasetSeal !== null && datasetSeal !== sealKey) {
      throw new Error('v31_dataset_seal_mismatch');
    }
    datasetId = row.dataset_id;
    datasetChecksum = row.dataset_checksum;
    datasetCells = row.dataset_cells;
    datasetSeal = sealKey;
    const cellKey = key({
      street: row.street,
      family: row.game_family,
      objective: row.objective,
      utilityContext: row.utility_context,
      tableSize: row.table_size,
      potType: row.pot_type,
      heroPosition: row.hero_position,
      opponentPosition: row.opponent_position,
      depth: row.depth_bucket,
      texture: row.texture_class,
      nodeRole: row.node_role,
      facingKind: row.facing_kind,
      facingSizeBucket: row.facing_size_bucket,
    });
    if (next.has(cellKey)) throw new Error(`v31_duplicate_cell:${cellKey}`);
    next.set(cellKey, {
      matrix: structuredClone(row.hand_matrix),
      actions: structuredClone(row.action_specs),
      policyEvs: structuredClone(row.policy_ev_matrix ?? {}),
      actionEvs: structuredClone(row.action_ev_matrix ?? {}),
      seal: sealOf(row),
      role: row.node_role,
    });
  }
  if (datasetCells !== null && next.size !== datasetCells) {
    throw new Error(`v31_incomplete_dataset:expected=${datasetCells}:actual=${next.size}`);
  }
  return { cells: next, datasetId, datasetChecksum };
}

/** Validate every row, then atomically replace the active in-memory snapshot. */
export function replaceGtoPostflopV31(rows: GtoPostflopV31Row[]): number {
  const next = validatedStore(rows, new Set(['active']));
  activeStore.cells = next.cells;
  activeStore.datasetId = next.datasetId;
  activeStore.datasetChecksum = next.datasetChecksum;
  return activeStore.cells.size;
}

/**
 * Load one sealed candidate into an isolated benchmark-only store.
 *
 * Candidate rows can never replace the active snapshot. Callers must name the
 * exact immutable dataset checksum on every lookup, so a benchmark cannot
 * accidentally exercise whatever candidate happened to load last.
 */
export function replaceGtoPostflopV31Evaluation(rows: GtoPostflopV31Row[]): number {
  const next = validatedStore(rows, new Set(['evaluating', 'candidate']));
  if (!next.datasetChecksum || !next.datasetId || next.cells.size === 0) {
    throw new Error('v31_evaluation_dataset_empty');
  }
  evaluationStores.set(next.datasetChecksum, next);
  return next.cells.size;
}

/** Backward-compatible test seam; production uses replaceGtoPostflopV31. */
export function setGtoPostflopV31(rows: GtoPostflopV31Row[]): number {
  return replaceGtoPostflopV31(rows);
}

export function boardFlushSuit(board: Card[]): number {
  if (!board || board.length === 0) return -1;
  const counts = [0, 0, 0, 0];
  for (const card of board) {
    const index = SUIT_INDEX[card?.suit as string];
    if (index !== undefined) counts[index]++;
  }
  let best = -1;
  let bestCount = 1;
  for (let index = 0; index < counts.length; index++) {
    if (counts[index] > bestCount) {
      bestCount = counts[index];
      best = index;
    }
  }
  return best;
}

export function v31HandKey(hand: string, holeCards: Card[], board: Card[]): string | null {
  if (!hand || !holeCards || holeCards.length !== 2) return null;
  const flushSuit = boardFlushSuit(board);
  let count = 0;
  if (flushSuit >= 0) {
    for (const card of holeCards) if (SUIT_INDEX[card?.suit as string] === flushSuit) count++;
  }
  return `${hand}:${count}`;
}

export function gtoStreetAdviceV31(input: {
  street: 'flop' | 'turn' | 'river';
  family: GtoV31GameFamily;
  objective: GtoV31Objective;
  utilityContext: GtoV31UtilityContext;
  tableSize: number;
  potType: GtoV31PotType;
  heroPosition: GtoV31Position;
  opponentPosition: GtoV31Position;
  stackBB: number;
  board: Card[];
  hand: string | null;
  holeCards: Card[];
  nodeRole: GtoV31NodeRole;
  facingKind: GtoV31FacingKind;
  facingSizeBucket: GtoV31SizeBucket;
  /** Benchmark-only exact candidate selector. Omit on every live action. */
  datasetChecksum?: string;
}): GtoV31Lookup {
  const selected = input.datasetChecksum
    ? evaluationStores.get(input.datasetChecksum)?.cells
    : activeStore.cells;
  if (!selected || selected.size === 0) return { hit: false, miss: 'empty_store' };
  if (!input.hand) return { hit: false, miss: 'no_hand' };
  const texture = textureClass(input.board);
  if (!texture) return { hit: false, miss: 'no_texture' };
  const handKey = v31HandKey(input.hand, input.holeCards, input.board);
  if (!handKey) return { hit: false, miss: 'no_hand' };
  for (const depth of depthCandidates(input.stackBB)) {
    const cellKey = key({ ...input, depth, texture });
    const cell = selected.get(cellKey);
    if (!cell) continue;
    const mix = cell.matrix[handKey];
    if (!mix) return { hit: false, miss: 'hand_not_in_cell' };
    return {
      hit: true,
      mix,
      actions: cell.actions,
      policyEvBb: cell.policyEvs[handKey] ?? null,
      actionEvsBb: cell.actionEvs[handKey] ?? null,
      cell: cellKey,
      sourceSeal: cell.seal,
      nodeRole: cell.role,
      depthBucket: depth,
    };
  }
  return { hit: false, miss: 'no_cell' };
}

/**
 * Certified open-node matrix used only by V32's explicitly derived fallback.
 * It requires both positions and the exact open-line role; it never searches
 * response nodes or substitutes a tournament objective.
 */
export function gtoV31CellMatrix(args: {
  street: 'flop' | 'turn' | 'river';
  family: GtoV31GameFamily;
  objective: GtoV31Objective;
  utilityContext: GtoV31UtilityContext;
  tableSize: number;
  potType: GtoV31PotType;
  heroPosition: GtoV31Position;
  opponentPosition: GtoV31Position;
  stackBB: number;
  texture: string;
  nodeRole: Extract<GtoV31NodeRole, 'open' | 'cbet' | 'probe' | 'delayed_cbet' | 'barrel'>;
}): Record<string, Record<string, number>> | null {
  for (const depth of depthCandidates(args.stackBB)) {
    const cell = activeStore.cells.get(
      key({
        ...args,
        depth,
        facingKind: 'none',
        facingSizeBucket: 'none',
      })
    );
    if (cell) return cell.matrix;
  }
  return null;
}

export function gtoPostflopV31Count(): number {
  return activeStore.cells.size;
}

export function gtoPostflopV31EvaluationCount(datasetChecksum: string): number {
  return evaluationStores.get(datasetChecksum)?.cells.size ?? 0;
}

export function gtoPostflopV31Dataset(): { id: string; checksum: string } | null {
  return activeStore.datasetId && activeStore.datasetChecksum
    ? { id: activeStore.datasetId, checksum: activeStore.datasetChecksum }
    : null;
}

/** Test seam. */
export function _clearGtoPostflopV31(): void {
  activeStore.cells = new Map<string, StoredCell>();
  activeStore.datasetId = null;
  activeStore.datasetChecksum = null;
  evaluationStores.clear();
}
