/** Bounded authenticated record exports. No export writes money or certifies full history. */
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { captureWeeklyAccountingAccount, readClubWeeklyStatements, CLUB_WEEKLY_EXPORT_LIMIT } from './ClubWeeklyAccountingReader';
import { exportUUID, exportTimestamp, exportWindow, exportInstant, exportRecord, exportRefusal,
  validateExportRow, generateExportCSV, sumExportDecimals, type ExportColumn, type ExportRow } from './FinancialExportContract';
export type { ExportColumn } from './FinancialExportContract';

export type ExportType = 'settlement_club' | 'settlement_agent' | 'agent_commissions' |
  'wallet_transactions' | 'rake_records' | 'cashout_history' | 'settlement_invoices';
export const EXPORT_REPRESENTATIONS = {
  settlement_club: 'club_weekly_summaries', settlement_agent: 'own_agent_accrual_records',
  agent_commissions: 'own_agent_page_subtotals', wallet_transactions: 'own_wallet_records',
  rake_records: 'club_raw_rake_records', cashout_history: 'own_player_cashout_requests',
  settlement_invoices: 'own_agent_credit_invoice_records',
} as const;
export type ExportCutoffBasis = 'caller_supplied_cutoff' | 'client_requested_cutoff';
export interface ExportCursor { createdAt: string; id: string; cutoff: string; cutoffBasis: ExportCutoffBasis; scopeKey: string; }
export interface ExportOptions {
  type: ExportType; clubId?: string; agentId?: string; userId?: string;
  periodStart?: string; periodEnd?: string; limit?: number;
  expectedActorId?: string; representation?: typeof EXPORT_REPRESENTATIONS[ExportType];
  isCurrent?: () => boolean; cursor?: ExportCursor;
}
export interface ExportCoverage {
  representation: string; actorId: string; clubId: string | null; subjectId: string;
  createdAtFrom: string | null; createdAtThrough: string; cutoffBasis: ExportCutoffBasis;
  pageSize: number; sourceRowCount: number; snapshot: 'not_established';
  continuation: 'possible' | 'range_empty_at_read'; nextCursor: ExportCursor | null;
}
export interface FinancialExportPage { rows: ExportRow[]; columns: ExportColumn[]; headers: string[]; coverage: ExportCoverage; }
type Context = { options: ExportOptions; actorId: string; clubId: string | null; agentId: string | null;
  subjectId: string; from: string | null; through: string; cutoffBasis: ExportCutoffBasis; limit: number; scopeKey: string;
  cursor: ExportCursor | null; check: () => void; };
const col = (key: string, label: string, kind: ExportColumn['kind'], extra: Partial<ExportColumn> = {}): ExportColumn => ({ key, label, kind, ...extra });
const id = (key: string, label: string, nullable = false) => col(key, label, 'uuid', { nullable });
const text = (key: string, label: string, nullable = false) => col(key, label, 'text', { nullable });
const time = (key: string, label: string, nullable = false) => col(key, label, 'timestamp', { nullable });
const decimal = (key: string, label: string, scale?: number, integralDigits?: number, nullable = false, positive = false) =>
  col(key, label, 'decimal', { scale, integralDigits, nullable, positive });
const COMMISSION = [id('id', 'Record ID'), id('club_id', 'Recorded Club ID'), id('user_id', 'Agent User ID'),
  decimal('amount', 'Recorded Accrual'), decimal('commission_rate', 'Recorded Rate', undefined, undefined, true),
  text('source_type', 'Recorded Source Type', true), id('source_id', 'Recorded Source ID', true),
  text('notes', 'Notes', true), time('created_at', 'Created At'), time('settled_at', 'Recorded Settled At (Not Payment Proof)', true)];
const WALLET = [id('id', 'Record ID'), id('user_id', 'User ID'), text('wallet_type', 'Wallet Type'),
  decimal('amount', 'Recorded Amount', 2, 13), text('type', 'Record Type'), text('category', 'Category'),
  text('description', 'Description', true), id('related_entity_id', 'Related Entity ID', true),
  id('table_id', 'Table ID', true), id('hand_id', 'Hand ID', true), time('created_at', 'Created At')];
const RAKE = [id('id', 'Record ID'), id('table_id', 'Table ID', true), id('hand_id', 'Hand ID', true),
  id('club_id', 'Recorded Host/Bank Club ID'), col('is_tournament', 'Recorded Tournament Flag', 'boolean'),
  id('tournament_id', 'Recorded Tournament ID', true), text('source', 'Recorded Source', true),
  text('rake_method', 'Recorded Rake Method'), decimal('pot_size', 'Raw Pot', 4, 14, true),
  decimal('rake_amount', 'Raw Rake', 4, 14), decimal('bbj_contribution', 'Raw BBJ', 4, 14, true), time('created_at', 'Created At')];
const CASHOUT = [id('id', 'Request ID'), id('player_id', 'Player User ID'), id('agent_id', 'Assigned Agent User ID'),
  id('club_id', 'Club ID'), decimal('amount', 'Requested Amount', 2, 13, false, true), text('status', 'Recorded Request State (Not Payment Proof)'),
  text('player_note', 'Player Note', true), time('created_at', 'Created At'), time('completed_at', 'Recorded Completed At', true)];
const CREDIT = [id('id', 'Credit Invoice ID'), id('agent_id', 'Agent Profile ID'), time('period_start', 'Recorded Period Start'),
  time('period_end', 'Recorded Period End'), decimal('debt_owed', 'Recorded Debt'), decimal('amount_paid', 'Recorded Paid Field'),
  decimal('amount_remaining', 'Recorded Remaining Field'), text('status', 'Recorded Status'),
  time('due_date', 'Due Date'), time('created_at', 'Created At')];
const METADATA = [text('export_representation', 'Export Representation'), id('export_actor_id', 'Export Actor ID'),
  id('export_subject_id', 'Export Subject ID'), id('export_club_id', 'Exact Source Club ID', true),
  text('export_cutoff_basis', 'Requested Cutoff Provenance'),
  time('export_created_from', 'Created At From (Inclusive)', true), time('export_created_through', 'Requested Created At Cutoff (Inclusive)'),
  col('export_page_size', 'Requested Page Size', 'integer'), col('export_source_rows', 'Source Rows In This Page', 'integer'),
  text('export_coverage', 'Coverage'), text('export_null_fields', 'Source Fields Recorded Null'), text('export_text_encoding', 'Text Cell Escape')];

async function context(input: ExportOptions): Promise<Context> {
  if (input.cursor !== undefined) exportRecord(input.cursor);
  const options = { ...input, cursor: input.cursor ? { ...input.cursor } : undefined };
  if (!Object.prototype.hasOwnProperty.call(EXPORT_REPRESENTATIONS, options.type)) exportRefusal('unknown_export_type');
  if (options.representation !== EXPORT_REPRESENTATIONS[options.type] &&
      !(options.type === 'settlement_club' && options.representation === undefined)) exportRefusal('explicit_export_representation_required');
  if (options.type !== 'settlement_club' && !options.expectedActorId) exportRefusal('export_actor_required');
  if (options.type !== 'settlement_club' && typeof options.isCurrent !== 'function') exportRefusal('export_view_guard_required');
  if (options.isCurrent !== undefined && typeof options.isCurrent !== 'function') exportRefusal('export_view_guard_required');
  const account = captureWeeklyAccountingAccount(options.expectedActorId ?? (options.type === 'settlement_club' ? options.userId : undefined));
  const check = () => { if (!account.isCurrent() || (options.isCurrent && options.isCurrent() !== true)) exportRefusal('export_account_or_view_changed'); };
  check();
  const actorId = exportUUID(account.userId);
  const limit = options.limit === undefined ? (options.type === 'settlement_club' ? CLUB_WEEKLY_EXPORT_LIMIT : 100) : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) exportRefusal('export_page_size_invalid');
  const from = options.periodStart === undefined ? null : exportWindow(options.periodStart);
  const through = exportWindow(options.periodEnd !== undefined ? options.periodEnd :
    options.cursor ? options.cursor.cutoff : new Date().toISOString());
  const cutoffBasis = options.cursor ? options.cursor.cutoffBasis :
    (options.periodEnd === undefined ? 'client_requested_cutoff' : 'caller_supplied_cutoff');
  if (!['caller_supplied_cutoff', 'client_requested_cutoff'].includes(cutoffBasis)) exportRefusal('export_cursor_cutoff_provenance_invalid');
  if (from && exportInstant(from) > exportInstant(through)) exportRefusal('export_window_invalid');
  if (options.userId !== undefined && exportUUID(options.userId) !== actorId) exportRefusal('export_own_account_required');
  const personal = ['wallet_transactions', 'cashout_history'].includes(options.type);
  if (personal && options.userId === undefined) exportRefusal('export_subject_required');
  const agentMode = ['settlement_agent', 'agent_commissions', 'settlement_invoices'].includes(options.type);
  const agentId = options.agentId === undefined ? null : exportUUID(options.agentId);
  if (agentMode !== Boolean(agentId)) exportRefusal('export_agent_scope_invalid');
  const needsClub = !['wallet_transactions', 'settlement_invoices'].includes(options.type);
  if (!needsClub && options.clubId !== undefined) exportRefusal(options.type === 'settlement_invoices' ? 'historical_credit_invoice_club_unproven' : 'wallet_has_no_club_scope');
  if (needsClub && !options.clubId) exportRefusal('export_club_required');
  let clubId: string | null = null;
  if (needsClub) { clubId = exportUUID(await resolveClubUUID(options.clubId!)); check(); }
  if (agentId) {
    check();
    const { data, error } = await supabase.from('agents').select('id,user_id,club_id').eq('id', agentId).maybeSingle();
    check(); if (error || !data) exportRefusal('export_agent_identity_unavailable');
    const agent = exportRecord(data);
    if (exportUUID(agent.id) !== agentId || exportUUID(agent.user_id) !== actorId ||
        (clubId && exportUUID(agent.club_id) !== clubId)) exportRefusal('export_agent_identity_mismatch');
    exportUUID(agent.club_id); // Current profile scope is evidence, never an invoice's historical club.
  }
  const subjectId = agentId ?? (options.type === 'settlement_club' || options.type === 'rake_records' ? clubId! : actorId);
  const scopeKey = JSON.stringify([1, options.type, EXPORT_REPRESENTATIONS[options.type], actorId, clubId, subjectId, from, through, cutoffBasis, limit]);
  let cursor: ExportCursor | null = null;
  if (options.cursor) {
    cursor = { ...options.cursor, createdAt: exportTimestamp(options.cursor.createdAt), id: exportUUID(options.cursor.id) };
    if (cursor.scopeKey !== scopeKey || exportInstant(exportWindow(cursor.cutoff)) !== exportInstant(through) ||
        exportInstant(cursor.createdAt) > exportInstant(through) || (from && exportInstant(cursor.createdAt) < exportInstant(from))) exportRefusal('export_cursor_scope_mismatch');
  }
  check(); return { options, actorId, clubId, agentId, subjectId, from, through, cutoffBasis, limit, scopeKey, cursor, check };
}
function projection(columns: ExportColumn[]): string { return columns.map(c => c.key + (c.kind === 'decimal' ? '::text' : '')).join(','); }
function compare(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  const at = exportInstant(a.createdAt), bt = exportInstant(b.createdAt);
  return at < bt ? -1 : at > bt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function page(c: Context, sourceRows: ExportRow[], columns: ExportColumn[], output = sourceRows): FinancialExportPage {
  const seen = new Set<string>(); let previous = c.cursor;
  for (const r of sourceRows) {
    const tuple = { createdAt: exportTimestamp(r.created_at), id: exportUUID(r.id) };
    if (seen.has(tuple.id) || (previous && compare(tuple, previous) >= 0) ||
        exportInstant(tuple.createdAt) > exportInstant(c.through) || (c.from && exportInstant(tuple.createdAt) < exportInstant(c.from))) exportRefusal('export_page_order_or_window_mismatch');
    seen.add(tuple.id); previous = { ...tuple, cutoff: c.through, cutoffBasis: c.cutoffBasis, scopeKey: c.scopeKey };
  }
  const last = sourceRows[sourceRows.length - 1];
  const coverage: ExportCoverage = { representation: EXPORT_REPRESENTATIONS[c.options.type], actorId: c.actorId,
    clubId: c.clubId, subjectId: c.subjectId, createdAtFrom: c.from, createdAtThrough: c.through,
    cutoffBasis: c.cutoffBasis, pageSize: c.limit, sourceRowCount: sourceRows.length, snapshot: 'not_established',
    continuation: last ? 'possible' : 'range_empty_at_read', nextCursor: last ? { createdAt: String(last.created_at), id: String(last.id), cutoff: c.through, cutoffBasis: c.cutoffBasis, scopeKey: c.scopeKey } : null };
  const rows = output.map(r => ({ ...r, export_representation: coverage.representation, export_actor_id: c.actorId,
    export_subject_id: c.subjectId, export_club_id: c.clubId, export_cutoff_basis: c.cutoffBasis, export_created_from: c.from, export_created_through: c.through,
    export_page_size: c.limit, export_source_rows: sourceRows.length,
    export_coverage: 'Authenticated visible bounded page; no immutable snapshot, complete day, entitlement or payment proof',
    export_null_fields: Object.keys(r).filter(key => r[key] === null).join(';'),
    export_text_encoding: 'Leading formula/whitespace/control/apostrophe text prefixed with apostrophe; import decimals as text for exact precision' }));
  c.check(); return { rows, columns: [...columns, ...METADATA], headers: [...columns, ...METADATA].map(v => v.label), coverage };
}
async function fetchRecords(c: Context): Promise<FinancialExportPage> {
  const type = c.options.type;
  const columns = type === 'wallet_transactions' ? WALLET : type === 'rake_records' ? RAKE : type === 'cashout_history' ? CASHOUT : type === 'settlement_invoices' ? CREDIT : COMMISSION;
  const table = type === 'settlement_agent' || type === 'agent_commissions' ? 'agent_commissions' : type === 'cashout_history' ? 'cashout_requests' : type === 'settlement_invoices' ? 'credit_invoices' : type;
  // One explicit identity scope in both reads. Credit's joined current owner is
  // checked in the same statement; no list of RLS-visible agents is inferred.
  const scoped = (selection: string) => {
    let q = supabase.from(table).select(selection + (type === 'settlement_invoices' ? ',agent:agents!inner(id,user_id,club_id)' : ''));
    if (c.clubId) q = q.eq('club_id', c.clubId);
    if (type === 'wallet_transactions' || type === 'settlement_agent' || type === 'agent_commissions') q = q.eq('user_id', c.actorId);
    if (type === 'cashout_history') q = q.eq('player_id', c.actorId);
    if (type === 'settlement_invoices') q = q.eq('agent_id', c.agentId!).eq('agent.id', c.agentId!).eq('agent.user_id', c.actorId);
    return q;
  };
  c.check();
  const undated = await scoped('id').is('created_at', null).limit(1);
  c.check(); if (undated.error || !Array.isArray(undated.data) || undated.data.length) exportRefusal('export_undated_history_unavailable');
  let query = scoped(projection(columns)).lte('created_at', c.through);
  if (c.from) query = query.gte('created_at', c.from);
  if (c.cursor) {
    // Both interpolated fields have passed closed UUID/ISO grammars; column
    // names/operators are constants. No caller-supplied filter syntax enters.
    query = query.or(`created_at.lt.${c.cursor.createdAt},and(created_at.eq.${c.cursor.createdAt},id.lt.${c.cursor.id})`);
  }
  c.check(); const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(c.limit);
  c.check(); if (error || !Array.isArray(data) || data.length > c.limit) exportRefusal('export_records_unavailable');
  const rows = data.map((raw: unknown) => {
    const original = exportRecord(raw); const value = { ...original };
    if (type === 'settlement_invoices') {
      const a = exportRecord(value.agent);
      if (exportUUID(a.id) !== c.agentId || exportUUID(a.user_id) !== c.actorId) exportRefusal('export_agent_identity_mismatch');
      exportUUID(a.club_id); delete value.agent;
    }
    const r = validateExportRow(value, columns);
    if ((c.clubId && r.club_id !== c.clubId) || (r.user_id !== undefined && r.user_id !== c.actorId) ||
        (type === 'cashout_history' && r.player_id !== c.actorId) || (type === 'settlement_invoices' && r.agent_id !== c.agentId)) exportRefusal('export_returned_scope_mismatch');
    if (type === 'settlement_invoices' && exportInstant(String(r.period_start)) >= exportInstant(String(r.period_end))) exportRefusal('export_recorded_period_invalid');
    return r;
  });
  if (type !== 'agent_commissions') return page(c, rows, columns);
  const groups = new Map<string, ExportRow[]>();
  for (const row of rows) {
    const day = new Date(String(row.created_at)).toISOString().slice(0, 10);
    const group = groups.get(day) ?? []; group.push(row); groups.set(day, group);
  }
  const totals = [...groups].map(([day, entries]) => ({ user_id: c.actorId, club_id: c.clubId!, utc_day: day,
    page_subtotal: sumExportDecimals(entries.map(r => String(r.amount))), page_entries: entries.length,
    source_record_ids: entries.map(r => String(r.id)).join(';'), day_coverage: 'Not established; only this source page' }));
  return page(c, rows, [id('user_id', 'Agent User ID'), id('club_id', 'Recorded Club ID'), text('utc_day', 'UTC Created Date'),
    decimal('page_subtotal', 'Page Subtotal (Not Complete Day)'), col('page_entries', 'Entries In This Page', 'integer'),
    text('source_record_ids', 'Original Source IDs In This Page'), text('day_coverage', 'Day Coverage')], totals);
}
async function fetchWeekly(c: Context): Promise<FinancialExportPage> {
  c.check();
  const undated = await supabase.from('settlement_invoices').select('id')
    .eq('club_id', c.clubId!).eq('invoice_type', 'club_weekly_accounting').is('created_at', null).limit(1);
  c.check();
  if (undated.error || !Array.isArray(undated.data) || undated.data.length) exportRefusal('export_undated_history_unavailable');
  const { rows } = await readClubWeeklyStatements({ clubId: c.clubId!, userId: c.actorId, limit: c.limit,
    periodStart: c.from ?? undefined, periodEnd: c.through, isCurrent: () => { c.check(); return true; },
    cursor: c.cursor ? { createdAt: c.cursor.createdAt, id: c.cursor.id, clubId: c.clubId!, actorId: c.actorId } : undefined });
  c.check();
  const mapped = rows.map(r => ({ id: r.id, club_id: r.clubId, period_id: r.periodId, period_start: r.periodStart,
    period_end: r.periodEnd, rake_funding: r.rakeFunding, paid_by_club: r.paidByClub,
    retained_by_club: r.retainedByClub, created_at: r.createdAt }));
  return page(c, mapped, [id('id', 'Weekly Statement ID'), id('club_id', 'Club ID'), id('period_id', 'Period ID'),
    time('period_start', 'Period Start'), time('period_end', 'Period End'), decimal('rake_funding', 'Rake Funding (Chips)', 2, 10),
    decimal('paid_by_club', 'Paid By Club (Chips)', 2, 10), decimal('retained_by_club', 'Retained By Club (Chips)', 2, 10), time('created_at', 'Created At')]);
}
async function fetchData(options: ExportOptions): Promise<FinancialExportPage> {
  const c = await context(options); return c.options.type === 'settlement_club' ? fetchWeekly(c) : fetchRecords(c);
}
function downloadCSV(csv: string, filename: string, isCurrent?: () => boolean): void {
  if (!isCurrent || isCurrent() !== true) exportRefusal('export_account_or_view_changed');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  try {
    if (!isCurrent()) exportRefusal('export_account_or_view_changed');
    link.href = url; link.download = filename; link.style.visibility = 'hidden'; document.body.appendChild(link);
    if (!isCurrent()) exportRefusal('export_account_or_view_changed'); link.click();
  } finally { link.remove(); URL.revokeObjectURL(url); }
}
export const FinancialExportService = {
  async exportCSV(options: ExportOptions): Promise<{ success: boolean; filename?: string; rowCount?: number; coverage?: ExportCoverage; error?: string }> {
    try {
      const c = await context(options); const result = c.options.type === 'settlement_club' ? await fetchWeekly(c) : await fetchRecords(c);
      c.check();
      if (result.rows.length === 0) return { success: false, error: 'no_visible_export_records', coverage: result.coverage };
      const csv = generateExportCSV(result.columns, result.rows);
      const filename = `club_arena_${EXPORT_REPRESENTATIONS[c.options.type]}_${c.subjectId}_${c.through.slice(0, 10)}.csv`;
      downloadCSV(csv, filename, () => { c.check(); return true; });
      return { success: true, filename, rowCount: result.rows.length, coverage: result.coverage };
    } catch (error) { reportError(error, 'FinancialExportService.exportCSV'); return { success: false, error: error instanceof Error ? error.message : 'export_unavailable' }; }
  },
  fetchData,
  fetchClubSettlements: (options: ExportOptions) => fetchData({ ...options, type: 'settlement_club' }),
  fetchAgentSettlements: (options: ExportOptions) => fetchData({ ...options, type: 'settlement_agent' }),
  fetchAgentCommissions: (options: ExportOptions) => fetchData({ ...options, type: 'agent_commissions' }),
  fetchWalletTransactions: (options: ExportOptions) => fetchData({ ...options, type: 'wallet_transactions' }),
  fetchRakeRecords: (options: ExportOptions) => fetchData({ ...options, type: 'rake_records' }),
  fetchCashoutHistory: (options: ExportOptions) => fetchData({ ...options, type: 'cashout_history' }),
  fetchSettlementInvoices: (options: ExportOptions) => fetchData({ ...options, type: 'settlement_invoices' }),
  generateCSV: generateExportCSV, downloadCSV,
  getFilename(options: ExportOptions) { return `club_arena_${EXPORT_REPRESENTATIONS[options.type]}_${new Date().toISOString().slice(0, 10)}.csv`; },
};
export default FinancialExportService;
