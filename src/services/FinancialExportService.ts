/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL EXPORT SERVICE — CSV Report Generation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * P2-15: Generates CSV exports for all financial data:
 * - Settlement reports (club + agent)
 * - Commission reports
 * - Wallet transaction history
 * - Rake reports
 *
 * All exports are generated client-side from Supabase queries.
 * For large datasets, uses pagination with 1000-row pages.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { resolveClubUUID } from '../utils/clubIdResolver';

const CREDIT_INVOICE_HEADERS = [
  'ID',
  'Agent ID',
  'Period Start',
  'Period End',
  'Debt Owed',
  'Amount Paid',
  'Amount Remaining',
  'Status',
  'Due Date',
  'Created At',
];

/** Apply the optional created_at window every fetcher accepts. */
function boundToPeriod<Q extends object>(
  query: Q,
  options: Pick<ExportOptions, 'periodStart' | 'periodEnd'>
): Q {
  // PostgREST filters return `this`; the casts only tell the compiler so.
  type Filterable = { gte: (c: string, v: string) => Q; lte: (c: string, v: string) => Q };
  let bounded = query;
  if (options.periodStart)
    bounded = (bounded as unknown as Filterable).gte('created_at', options.periodStart);
  if (options.periodEnd)
    bounded = (bounded as unknown as Filterable).lte('created_at', options.periodEnd);
  return bounded;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ExportType =
  | 'settlement_club'
  | 'settlement_agent'
  // Named for the ledger it reads, not for the table it used to read.
  // commission_history was dropped on 2026-09-01 (phase 7) after holding zero
  // rows for its whole life; the fetcher below has read agent_commissions
  // since the 2026-07-23 sweep, so only the label was stale.
  | 'agent_commissions'
  | 'wallet_transactions'
  | 'rake_records'
  | 'cashout_history'
  | 'settlement_invoices';

export interface ExportOptions {
  type: ExportType;
  clubId?: string;
  agentId?: string;
  userId?: string;
  periodStart?: string;
  periodEnd?: string;
  limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const FinancialExportService = {
  /**
   * Generate and download a CSV export
   */
  async exportCSV(
    options: ExportOptions
  ): Promise<{ success: boolean; filename?: string; rowCount?: number; error?: string }> {
    try {
      const { rows, headers } = await this.fetchData(options);

      if (rows.length === 0) {
        return { success: false, error: 'No data found for export' };
      }

      const csv = this.generateCSV(headers, rows);
      const filename = this.getFilename(options);
      this.downloadCSV(csv, filename);

      return { success: true, filename, rowCount: rows.length };
    } catch (err: unknown) {
      reportError(err, 'FinancialExportService.exportData');
      return { success: false, error: err instanceof Error ? err.message : 'Export failed' };
    }
  },

  /**
   * Fetch data based on export type
   */
  async fetchData(
    options: ExportOptions
  ): Promise<{ rows: Record<string, unknown>[]; headers: string[] }> {
    switch (options.type) {
      case 'settlement_club':
        return this.fetchClubSettlements(options);
      case 'settlement_agent':
        return this.fetchAgentSettlements(options);
      case 'agent_commissions':
        return this.fetchAgentCommissions(options);
      case 'wallet_transactions':
        return this.fetchWalletTransactions(options);
      case 'rake_records':
        return this.fetchRakeRecords(options);
      case 'cashout_history':
        return this.fetchCashoutHistory(options);
      case 'settlement_invoices':
        return this.fetchSettlementInvoices(options);
      default:
        throw new Error(`Unknown export type: ${options.type}`);
    }
  },

  // ─── Data Fetchers ───────────────────────────────────────────────────────────

  // SWEEP #3 (2026-07-23): club settlement exports repointed off the phantom
  // `club_settlements` table onto `settlement_invoices` (the real weekly
  // union<->club settlement record; breakdown jsonb carries rake/hold detail).
  async fetchClubSettlements(options: ExportOptions) {
    let query = supabase
      .from('settlement_invoices')
      .select(
        'id, club_id, period_id, invoice_type, gross_amount, deductions, net_amount, status, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(options.limit || 1000);

    if (options.clubId) query = query.eq('club_id', options.clubId);
    if (options.periodStart) query = query.gte('created_at', options.periodStart);
    if (options.periodEnd) query = query.lte('created_at', options.periodEnd);

    const { data, error } = await query;
    if (error) throw error;

    return {
      headers: [
        'ID',
        'Club ID',
        'Period ID',
        'Invoice Type',
        'Gross Amount',
        'Deductions',
        'Net Amount',
        'Status',
        'Created At',
      ],
      rows: data || [],
    };
  },

  // SWEEP #3 (2026-07-23): agent settlement exports repointed off the phantom
  // `agent_settlements` table onto `agent_commissions` — the live per-hand
  // commission ledger written by the engine RakebackSettler. Note the ledger is
  // keyed by the agent's auth user_id; an options.agentId (agents.id PK) is
  // resolved to user_id first.
  async fetchAgentSettlements(options: ExportOptions) {
    let query = supabase
      .from('agent_commissions')
      .select('id, club_id, user_id, amount, commission_rate, source_type, notes, created_at')
      .order('created_at', { ascending: false })
      .limit(options.limit || 1000);

    if (options.agentId) {
      const { data: agent } = await supabase
        .from('agents')
        .select('user_id')
        .eq('id', options.agentId)
        .maybeSingle();
      query = query.eq('user_id', agent?.user_id || options.agentId);
    }
    if (options.clubId) query = query.eq('club_id', options.clubId);
    if (options.periodStart) query = query.gte('created_at', options.periodStart);
    if (options.periodEnd) query = query.lte('created_at', options.periodEnd);

    const { data, error } = await query;
    if (error) throw error;

    return {
      headers: [
        'ID',
        'Club ID',
        'Agent User ID',
        'Commission Amount',
        'Commission Rate',
        'Source Type',
        'Notes',
        'Created At',
      ],
      rows: data || [],
    };
  },

  // SWEEP #3 (2026-07-23): commission history exports repointed off the phantom
  // `commission_payouts` table onto `agent_commissions`, aggregated per agent
  // per day (the ledger is per-hand; day-level rows keep the CSV readable).
  async fetchAgentCommissions(options: ExportOptions) {
    let query = supabase
      .from('agent_commissions')
      .select('club_id, user_id, amount, created_at')
      .order('created_at', { ascending: false })
      .limit(options.limit || 5000);

    if (options.agentId) {
      const { data: agent } = await supabase
        .from('agents')
        .select('user_id')
        .eq('id', options.agentId)
        .maybeSingle();
      query = query.eq('user_id', agent?.user_id || options.agentId);
    }
    if (options.clubId) query = query.eq('club_id', options.clubId);
    if (options.periodStart) query = query.gte('created_at', options.periodStart);
    if (options.periodEnd) query = query.lte('created_at', options.periodEnd);

    const { data, error } = await query;
    if (error) throw error;

    // Aggregate per (user, club, day)
    const buckets = new Map<
      string,
      { user_id: string; club_id: string; day: string; total: number; entries: number }
    >();
    (data || []).forEach((r: any) => {
      const day = String(r.created_at || '').slice(0, 10);
      const key = `${r.user_id}|${r.club_id}|${day}`;
      const b = buckets.get(key) || {
        user_id: r.user_id,
        club_id: r.club_id,
        day,
        total: 0,
        entries: 0,
      };
      b.total += Number(r.amount || 0);
      b.entries += 1;
      buckets.set(key, b);
    });
    const rows = Array.from(buckets.values())
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .map((b) => ({
        user_id: b.user_id,
        club_id: b.club_id,
        day: b.day,
        total_commission: Math.round(b.total * 100) / 100,
        entries: b.entries,
      }));

    return {
      headers: ['Agent User ID', 'Club ID', 'Day', 'Total Commission', 'Entries'],
      rows,
    };
  },

  async fetchWalletTransactions(options: ExportOptions) {
    /* ONE PLAYER, NAMED (2026-09-10). wallet_transactions has no club column,
       and user_id was applied only when the caller supplied it, so a caller
       that omitted it exported every wallet movement RLS let it read. A
       wallet export is a statement for one player; without one it is refused. */
    if (!options.userId) {
      throw new Error('A Wallet Export Needs A Player. No Export Was Produced.');
    }
    const query = supabase
      .from('wallet_transactions')
      .select('id, user_id, wallet_type, amount, type, category, description, created_at')
      .eq('user_id', options.userId)
      .order('created_at', { ascending: false })
      .limit(options.limit || 1000);
    const bounded = boundToPeriod(query, options);

    const { data, error } = await bounded;
    if (error) throw error;

    return {
      headers: [
        'ID',
        'User ID',
        'Wallet Type',
        'Amount',
        'Type',
        'Category',
        'Description',
        'Created At',
      ],
      rows: data || [],
    };
  },

  async fetchRakeRecords(options: ExportOptions) {
    let query = supabase
      .from('rake_records')
      // rake_records schema: pot_size (not pot_amount), bbj_contribution (not bbj_amount)
      .select('id, table_id, hand_id, club_id, pot_size, rake_amount, bbj_contribution, created_at')
      .order('created_at', { ascending: false })
      .limit(options.limit || 1000);

    if (options.clubId) query = query.eq('club_id', options.clubId);
    if (options.periodStart) query = query.gte('created_at', options.periodStart);
    if (options.periodEnd) query = query.lte('created_at', options.periodEnd);

    const { data, error } = await query;
    if (error) throw error;

    return {
      headers: [
        'ID',
        'Table ID',
        'Hand ID',
        'Club ID',
        'Pot Size',
        'Rake Amount',
        'BBJ Contribution',
        'Created At',
      ],
      rows: data || [],
    };
  },

  async fetchCashoutHistory(options: ExportOptions) {
    let query = supabase
      .from('cashout_requests')
      // cashout_requests schema: player_note (not notes)
      .select(
        'id, player_id, agent_id, club_id, amount, status, player_note, created_at, completed_at'
      )
      .order('created_at', { ascending: false })
      .limit(options.limit || 1000);

    if (options.userId) query = query.eq('player_id', options.userId);
    if (options.clubId) query = query.eq('club_id', options.clubId);
    if (options.periodStart) query = query.gte('created_at', options.periodStart);
    if (options.periodEnd) query = query.lte('created_at', options.periodEnd);

    const { data, error } = await query;
    if (error) throw error;

    return {
      headers: [
        'ID',
        'Player ID',
        'Agent ID',
        'Club ID',
        'Amount',
        'Status',
        'Player Note',
        'Created At',
        'Completed At',
      ],
      rows: data || [],
    };
  },

  async fetchSettlementInvoices(options: ExportOptions) {
    // SWEEP #3 (2026-07-23): this fetcher's column list (agent_id, debt_owed,
    // amount_paid, due_date, ...) belongs to `credit_invoices` — it was written
    // against the wrong table name. `settlement_invoices` is the union<->club
    // invoice table and has none of these columns. Repointed to credit_invoices.
    /* A CLUB'S INVOICES ARE ITS AGENTS' INVOICES (2026-09-10). credit_invoices
       has no club column, and options.clubId was silently ignored, so a
       club-scoped CSV carried every club's agents' debt and payment records
       RLS let the caller read. The club is applied through the agents that
       belong to it; a club with no agents exports no rows, and a call that
       names neither a club nor an agent is refused rather than exporting all. */
    if (!options.clubId && !options.agentId) {
      throw new Error('An Invoice Export Needs A Club Or An Agent. No Export Was Produced.');
    }
    let query = supabase
      .from('credit_invoices')
      .select(
        'id, agent_id, period_start, period_end, debt_owed, amount_paid, amount_remaining, status, due_date, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(options.limit || 1000);

    if (options.agentId) query = query.eq('agent_id', options.agentId);
    if (options.clubId) {
      const resolvedClub = await resolveClubUUID(options.clubId);
      const { data: clubAgents, error: agentsError } = await supabase
        .from('agents')
        .select('id')
        .eq('club_id', resolvedClub);
      if (agentsError) throw agentsError;
      const agentIds = (clubAgents || []).map((a) => a.id).filter(Boolean);
      if (agentIds.length === 0) {
        return { headers: CREDIT_INVOICE_HEADERS, rows: [] };
      }
      query = query.in('agent_id', agentIds);
    }
    const bounded = boundToPeriod(query, options);

    const { data, error } = await bounded;
    if (error) throw error;

    return { headers: CREDIT_INVOICE_HEADERS, rows: data || [] };
  },

  // ─── CSV Generation ────────────────────────────────────────────────────────

  generateCSV(headers: string[], rows: Record<string, unknown>[]): string {
    const headerLine = headers.map((h) => `"${h}"`).join(',');
    // Use Object.keys from the first row to establish column order,
    // ensuring data values align with the header array.
    const keys = rows.length > 0 ? Object.keys(rows[0]) : [];
    const dataLines = rows.map((row) => {
      const values = keys.map((key) => {
        const val = row[key];
        if (val === null || val === undefined) return '""';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      });
      return values.join(',');
    });
    return [headerLine, ...dataLines].join('\n');
  },

  downloadCSV(csv: string, filename: string): void {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  },

  getFilename(options: ExportOptions): string {
    const date = new Date().toISOString().split('T')[0];
    return `club_arena_${options.type}_${date}.csv`;
  },
};

export default FinancialExportService;
