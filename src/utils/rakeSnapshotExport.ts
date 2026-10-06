import type {
  RakeAgentRow,
  RakeBreakdownRow,
  RakeClubRow,
  RakeDownlineRow,
  RakeScope,
  RakeSnapshot,
  RakeSortKey,
} from '../services/ClubRakeSnapshotService';
import {
  fetchClubDataExport,
  type ClubDataExportProgress,
  type ClubDataExportRpc,
} from './clubDataExport';
import { csvEscape } from './downloadCsv';

// Match the page door's native default so a ceiling-size 20,000-row export
// needs 20 round trips rather than 100, while staying below its 2,000 hard cap.
const RAKE_EXPORT_PAGE_SIZE = 1000;
const RAKE_EXPORT_MAX_ROWS = 20_000;
export const RAKE_EXPORT_SEARCH_MAX_LENGTH = 160;

type RakeBreakdownKind = Exclude<RakeSnapshot['breakdown_kind'], 'none'>;

export interface RakeExportMetadata {
  schema_version: 1;
  kind: 'rake';
  scope_type: RakeScope;
  scope_id: string;
  club_id: string | null;
  union_id: string | null;
  agent_user_id: string | null;
  date_from: string;
  date_to: string;
  search: string | null;
  sort: RakeSortKey;
  generated_at: string;
  scope_label: string;
  breakdown_kind: RakeBreakdownKind;
  breakdown_total: number;
  commission_total: number | null;
  contains_admin_commission: boolean;
}

export interface RakeExportReceipt {
  exportId: string;
  totalRows: number;
  totalAmount: number;
  expiresAt: string;
  metadataFingerprint: string;
  metadata: RakeExportMetadata;
}

export interface RakeSnapshotExportResult extends RakeExportReceipt {
  rows: RakeBreakdownRow[];
}

export interface FetchRakeSnapshotExportOptions {
  rpc: ClubDataExportRpc;
  scope: RakeScope;
  scopeId: string;
  start: string;
  end: string;
  /** The concrete target. A top-level Downline export targets the viewer. */
  agentUserId?: string | null;
  viewerUserId: string;
  search?: string | null;
  sort?: RakeSortKey | null;
  requestId: string;
  signal: AbortSignal;
  onProgress?: (progress: ClubDataExportProgress) => void;
  pageSize?: number;
}

interface ExpectedRakeExportIdentity {
  scope: RakeScope;
  scopeId: string;
  start: string;
  end: string;
  agentUserId: string | null;
  search: string | null;
  sort: RakeSortKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function containsHorseIdentity(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => /horse/i.test(key));
}

function breakdownKindForScope(scope: RakeScope): RakeBreakdownKind {
  return scope === 'union' ? 'club' : scope === 'club' ? 'agent' : 'downline';
}

function normalizeRakeExportSort(scope: RakeScope, sort?: RakeSortKey | null): RakeSortKey {
  const requested = sort ?? 'rake';
  const allowed: readonly RakeSortKey[] =
    scope === 'club' ? ['rake', 'name', 'cost', 'players'] : ['rake', 'name', 'hands'];
  return allowed.includes(requested) ? requested : 'rake';
}

function normalizeRakeExportSearch(value?: string | null): string | null {
  return value?.trim().slice(0, RAKE_EXPORT_SEARCH_MAX_LENGTH) || null;
}

function shiftUtcDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Mirrors the Rake start door's UTC/two-year date normalization. */
function normalizeRakeExportRange(start: string, end: string): { start: string; end: string } {
  if (!isIsoDate(start) || !isIsoDate(end)) {
    throw new Error('The Rake export date range is invalid.');
  }
  const today = new Date().toISOString().slice(0, 10);
  const normalizedEnd = end > today ? today : end;
  const earliest = shiftUtcDate(normalizedEnd, -730);
  let normalizedStart = start < earliest ? earliest : start;
  if (normalizedStart > normalizedEnd) normalizedStart = normalizedEnd;
  return { start: normalizedStart, end: normalizedEnd };
}

function isRakeBreakdownRow(value: unknown, kind: RakeBreakdownKind): value is RakeBreakdownRow {
  if (!isRecord(value) || containsHorseIdentity(value)) return false;

  if (kind === 'club') {
    return (
      isNonEmptyString(value.club_id) &&
      isNonEmptyString(value.name) &&
      isNullableString(value.code) &&
      isNullableString(value.avatar_url) &&
      isFiniteNumber(value.fee) &&
      isFiniteNumber(value.cash_fee) &&
      isFiniteNumber(value.mtt_fee) &&
      isFiniteNumber(value.winnings) &&
      isNonNegativeInteger(value.hands) &&
      isNonNegativeInteger(value.games) &&
      isOptionalBoolean(value.can_drill)
    );
  }

  if (kind === 'agent') {
    return (
      (value.agent_user_id === null || isNonEmptyString(value.agent_user_id)) &&
      isNonEmptyString(value.name) &&
      isNullableString(value.avatar_url) &&
      isNonEmptyString(value.role) &&
      isNullableFiniteNumber(value.commission_rate) &&
      isNonNegativeInteger(value.direct_players) &&
      isNonNegativeInteger(value.direct_active) &&
      isFiniteNumber(value.direct_rake) &&
      isNonNegativeInteger(value.direct_hands) &&
      isNonNegativeInteger(value.network_players) &&
      isFiniteNumber(value.network_rake) &&
      isNonNegativeInteger(value.sub_agents) &&
      typeof value.is_unassigned === 'boolean' &&
      isNullableFiniteNumber(value.commission_earned) &&
      isNullableFiniteNumber(value.commission_outstanding) &&
      isNullableFiniteNumber(value.commission_settled) &&
      isOptionalBoolean(value.is_residual) &&
      isOptionalBoolean(value.can_drill)
    );
  }

  return (
    isNonEmptyString(value.player_id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.role) &&
    isNonNegativeInteger(value.depth) &&
    value.depth > 0 &&
    isNullableString(value.upline_user_id) &&
    isNullableString(value.upline_name) &&
    isFiniteNumber(value.rake) &&
    isNonNegativeInteger(value.hands) &&
    (value.last_hand_at === null || isTimestamp(value.last_hand_at)) &&
    isNonNegativeInteger(value.downline_players) &&
    isFiniteNumber(value.downline_rake)
  );
}

function rakeBreakdownIdentity(row: RakeBreakdownRow, kind: RakeBreakdownKind): string {
  if (kind === 'club') return `club:${(row as RakeClubRow).club_id}`;
  if (kind === 'downline') return `player:${(row as RakeDownlineRow).player_id}`;
  const agent = row as RakeAgentRow;
  return agent.agent_user_id
    ? `agent:${agent.agent_user_id}`
    : `synthetic:${agent.is_unassigned ? 'unassigned' : 'residual'}:${agent.name}`;
}

function metadataIdentity(metadata: RakeExportMetadata): string {
  return JSON.stringify([
    metadata.schema_version,
    metadata.kind,
    metadata.scope_type,
    metadata.scope_id,
    metadata.club_id,
    metadata.union_id,
    metadata.agent_user_id,
    metadata.date_from,
    metadata.date_to,
    metadata.search,
    metadata.sort,
    metadata.generated_at,
    metadata.scope_label,
    metadata.breakdown_kind,
    metadata.breakdown_total,
    metadata.commission_total,
    metadata.contains_admin_commission,
  ]);
}

export function parseRakeExportMetadata(
  value: unknown,
  expected: ExpectedRakeExportIdentity
): RakeExportMetadata | null {
  if (!isRecord(value) || containsHorseIdentity(value)) return null;
  const expectedKind = breakdownKindForScope(expected.scope);
  const expectedClubId = expected.scope === 'union' ? null : expected.scopeId;
  const expectedUnionId = expected.scope === 'union' ? expected.scopeId : null;
  const expectedAgentId = expected.scope === 'agent' ? expected.agentUserId : null;

  if (
    value.schema_version !== 1 ||
    value.kind !== 'rake' ||
    value.scope_type !== expected.scope ||
    value.scope_id !== expected.scopeId ||
    value.club_id !== expectedClubId ||
    value.union_id !== expectedUnionId ||
    value.agent_user_id !== expectedAgentId ||
    value.date_from !== expected.start ||
    value.date_to !== expected.end ||
    value.search !== expected.search ||
    value.sort !== expected.sort ||
    value.breakdown_kind !== expectedKind ||
    !isIsoDate(value.date_from) ||
    !isIsoDate(value.date_to) ||
    value.date_from > value.date_to ||
    !isTimestamp(value.generated_at) ||
    !isNonEmptyString(value.scope_label) ||
    !isFiniteNumber(value.breakdown_total) ||
    !isNullableFiniteNumber(value.commission_total) ||
    typeof value.contains_admin_commission !== 'boolean' ||
    (expected.scope !== 'club' &&
      (value.commission_total !== null || value.contains_admin_commission))
  ) {
    return null;
  }

  return value as unknown as RakeExportMetadata;
}

function parseRakeExportReceipt(
  value: Readonly<Record<string, unknown>>,
  expected: ExpectedRakeExportIdentity
): RakeExportReceipt | null {
  const metadata = parseRakeExportMetadata(value.metadata, expected);
  if (
    value.kind !== 'rake' ||
    value.status !== 'ready' ||
    !isNonEmptyString(value.export_id) ||
    !isNonNegativeInteger(value.total_rows) ||
    value.total_rows > RAKE_EXPORT_MAX_ROWS ||
    !isFiniteNumber(value.total_amount) ||
    !isTimestamp(value.expires_at) ||
    !isNonEmptyString(value.metadata_fingerprint) ||
    !metadata ||
    value.total_amount !== metadata.breakdown_total ||
    Date.parse(value.expires_at) <= Date.parse(metadata.generated_at)
  ) {
    return null;
  }
  return {
    exportId: value.export_id,
    totalRows: value.total_rows,
    totalAmount: value.total_amount,
    expiresAt: value.expires_at,
    metadataFingerprint: value.metadata_fingerprint,
    metadata,
  };
}

function rakePageMatchesReceipt(
  page: Readonly<Record<string, unknown>>,
  receipt: RakeExportReceipt,
  expected: ExpectedRakeExportIdentity
): boolean {
  const metadata = parseRakeExportMetadata(page.metadata, expected);
  return Boolean(
    page.kind === 'rake' &&
    page.total_rows === receipt.totalRows &&
    page.expires_at === receipt.expiresAt &&
    page.metadata_fingerprint === receipt.metadataFingerprint &&
    metadata &&
    metadataIdentity(metadata) === metadataIdentity(receipt.metadata)
  );
}

/**
 * Downloads the full immutable Rake result, independent of the interactive
 * panel's browse ceiling. Nothing is returned unless every announced ordinal
 * is present once and every page repeats the preparation receipt.
 */
export async function fetchRakeSnapshotExport(
  options: FetchRakeSnapshotExportOptions
): Promise<RakeSnapshotExportResult> {
  const range = normalizeRakeExportRange(options.start, options.end);
  const sort = normalizeRakeExportSort(options.scope, options.sort);
  const search = normalizeRakeExportSearch(options.search);
  const agentUserId =
    options.scope === 'agent' ? (options.agentUserId ?? options.viewerUserId) : null;
  const expected: ExpectedRakeExportIdentity = {
    scope: options.scope,
    scopeId: options.scopeId,
    start: range.start,
    end: range.end,
    agentUserId,
    search,
    sort,
  };
  let receipt: RakeExportReceipt | null = null;

  const rows = await fetchClubDataExport<RakeBreakdownRow>({
    rpc: options.rpc,
    startRpc: 'ca_rake_export_start',
    startArgs: {
      p_scope_type: options.scope,
      p_scope_id: options.scopeId,
      p_start: options.start,
      p_end: options.end,
      p_agent_user_id: options.scope === 'agent' ? (options.agentUserId ?? null) : null,
      p_search: search,
      p_sort: sort,
    },
    requestId: options.requestId,
    signal: options.signal,
    validateReceipt: (value) => {
      const parsed = parseRakeExportReceipt(value, expected);
      if (!parsed) return false;
      receipt = parsed;
      return true;
    },
    validatePage: (page) => Boolean(receipt && rakePageMatchesReceipt(page, receipt, expected)),
    validateRow: (row): row is RakeBreakdownRow =>
      isRakeBreakdownRow(row, breakdownKindForScope(options.scope)),
    rowKey: (row) => rakeBreakdownIdentity(row, breakdownKindForScope(options.scope)),
    onProgress: options.onProgress,
    pageSize: options.pageSize ?? RAKE_EXPORT_PAGE_SIZE,
    requireFullPages: true,
  });

  const preparedReceipt = receipt as RakeExportReceipt | null;
  if (!preparedReceipt) {
    throw new Error('The Rake export service returned no preparation receipt.');
  }
  return { ...preparedReceipt, rows };
}

function metadataCsv(result: RakeSnapshotExportResult): string[] {
  return [
    [
      'schema_version',
      'kind',
      'scope_type',
      'scope_id',
      'club_id',
      'union_id',
      'agent_user_id',
      'date_from',
      'date_to',
      'search',
      'sort',
      'generated_at',
      'scope_label',
      'breakdown_kind',
      'total_rows',
      'breakdown_total',
      'commission_total',
      'contains_admin_commission',
      'complete',
    ].join(','),
    [
      result.metadata.schema_version,
      result.metadata.kind,
      result.metadata.scope_type,
      result.metadata.scope_id,
      result.metadata.club_id,
      result.metadata.union_id,
      result.metadata.agent_user_id,
      result.metadata.date_from,
      result.metadata.date_to,
      result.metadata.search,
      result.metadata.sort,
      result.metadata.generated_at,
      result.metadata.scope_label,
      result.metadata.breakdown_kind,
      result.totalRows,
      result.metadata.breakdown_total,
      result.metadata.commission_total,
      result.metadata.contains_admin_commission,
      true,
    ]
      .map(csvEscape)
      .join(','),
  ];
}

export function rakeSnapshotExportToCsv(result: RakeSnapshotExportResult): string {
  const lines = metadataCsv(result);
  lines.push('');

  if (result.metadata.breakdown_kind === 'club') {
    lines.push(
      [
        'club_id',
        'name',
        'code',
        'avatar_url',
        'games',
        'hands',
        'fee',
        'cash_fee',
        'mtt_fee',
        'winnings',
        'can_drill',
      ].join(',')
    );
    for (const row of result.rows as RakeClubRow[]) {
      lines.push(
        [
          row.club_id,
          row.name,
          row.code,
          row.avatar_url,
          row.games,
          row.hands,
          row.fee,
          row.cash_fee,
          row.mtt_fee,
          row.winnings,
          row.can_drill ?? false,
        ]
          .map(csvEscape)
          .join(',')
      );
    }
  } else if (result.metadata.breakdown_kind === 'agent') {
    lines.push(
      [
        'agent_user_id',
        'name',
        'avatar_url',
        'role',
        'commission_rate',
        'direct_players',
        'direct_active',
        'direct_hands',
        'direct_rake',
        'sub_agents',
        'network_players',
        'network_rake',
        'commission_earned',
        'commission_outstanding',
        'commission_settled',
        'is_unassigned',
        'is_residual',
        'can_drill',
      ].join(',')
    );
    for (const row of result.rows as RakeAgentRow[]) {
      lines.push(
        [
          row.agent_user_id,
          row.name,
          row.avatar_url,
          row.role,
          row.commission_rate,
          row.direct_players,
          row.direct_active,
          row.direct_hands,
          row.direct_rake,
          row.sub_agents,
          row.network_players,
          row.network_rake,
          row.commission_earned,
          row.commission_outstanding,
          row.commission_settled,
          row.is_unassigned,
          row.is_residual ?? false,
          row.can_drill ?? false,
        ]
          .map(csvEscape)
          .join(',')
      );
    }
  } else {
    lines.push(
      [
        'player_id',
        'name',
        'role',
        'depth',
        'upline_user_id',
        'upline_name',
        'hands',
        'rake',
        'last_hand_at',
        'downline_players',
        'downline_rake',
      ].join(',')
    );
    for (const row of result.rows as RakeDownlineRow[]) {
      lines.push(
        [
          row.player_id,
          row.name,
          row.role,
          row.depth,
          row.upline_user_id,
          row.upline_name,
          row.hands,
          row.rake,
          row.last_hand_at,
          row.downline_players,
          row.downline_rake,
        ]
          .map(csvEscape)
          .join(',')
      );
    }
  }
  return lines.join('\n');
}

function exportError(error: unknown): { code: string; message: string } {
  const value = isRecord(error) ? error : {};
  return {
    code: typeof value.code === 'string' ? value.code : '',
    message:
      error instanceof Error
        ? error.message
        : typeof value.message === 'string'
          ? value.message
          : String(error ?? ''),
  };
}

export function isRakeExportAuthorizationError(error: unknown): boolean {
  return exportError(error).code === '42501';
}

export function isRakeExportUnavailable(error: unknown): boolean {
  const { code, message } = exportError(error);
  return (
    code === '55000' &&
    /export.*(?:expired|unavailable|not found|no longer available)/i.test(message)
  );
}

export function isRakeExportBusy(error: unknown): boolean {
  const { code, message } = exportError(error);
  return code === '55000' && /another Club Data export/i.test(message);
}

export function isRakeExportEntitlementChanged(error: unknown): boolean {
  const { code, message } = exportError(error);
  return (
    code === '55000' &&
    /permissions changed|permission-sensitive|metadata is invalid|prepare a new export/i.test(
      message
    )
  );
}
