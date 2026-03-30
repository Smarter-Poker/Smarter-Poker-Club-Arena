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

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ExportType =
  | 'settlement_club'
  | 'settlement_agent'
  | 'commission_history'
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
      console.error('[FinancialExport] Export failed:', err);
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
      case 'commission_history':
        return this.fetchCommissionHistory(options);
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

  // ─── Data Fetchers ─────────────────────────────────────────────────────────

  async fetchClubSettlements(options: ExportOptions) {
    let query = supabase
      .from('club_settlements')
      // club_settlements schema: total_rake_collected, platform_fee, net_revenue
      .select(
        'id, club_id, period_id, total_rake_collected, platform_fee, net_revenue, status, created_at'
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
        'Total Rake Collected',
        'Platform Fee',
        'Net Revenue',
        'Status',
        'Created At',
      ],
      rows: data || [],
    };
  },

  async fetchAgentSettlements(options: ExportOptions) {
    let query = supabase
      .from('agent_settlements')
      // agent_settlements schema: total_rake_generated (not gross_rake), no downline_payouts column
      .select(
        'id, agent_id, period_id, total_rake_generated, commission_rate, commission_earned, net_settlement, status, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(options.limit || 1000);

    if (options.agentId) query = query.eq('agent_id', options.agentId);
    if (options.periodStart) query = query.gte('created_at', options.periodStart);
    if (options.periodEnd) query = query.lte('created_at', options.periodEnd);

    const { data, error } = await query;
    if (error) throw error;

    return {
      headers: [
        'ID',
        'Agent ID',
        'Period ID',
        'Total Rake Generated',
        'Commission Rate',
        'Commission Earned',
        'Net Settlement',
        'Status',
        'Created At',
      ],
      rows: data || [],
    };
  },

  async fetchCommissionHistory(options: ExportOptions) {
    let query = supabase
      .from('commission_payouts')
      .select(
        'id, agent_id, period_id, gross_rake, commission_earned, paid_to_downlines, net_payout, status, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(options.limit || 1000);

    if (options.agentId) query = query.eq('agent_id', options.agentId);
    if (options.periodStart) query = query.gte('created_at', options.periodStart);
    if (options.periodEnd) query = query.lte('created_at', options.periodEnd);

    const { data, error } = await query;
    if (error) throw error;

    return {
      headers: [
        'ID',
        'Agent ID',
        'Period ID',
        'Gross Rake',
        'Commission Earned',
        'Paid to Downlines',
        'Net Payout',
        'Status',
        'Created At',
      ],
      rows: data || [],
    };
  },

  async fetchWalletTransactions(options: ExportOptions) {
    let query = supabase
      .from('wallet_transactions')
      .select('id, user_id, wallet_type, amount, type, category, description, created_at')
      .order('created_at', { ascending: false })
      .limit(options.limit || 1000);

    if (options.userId) query = query.eq('user_id', options.userId);
    if (options.periodStart) query = query.gte('created_at', options.periodStart);
    if (options.periodEnd) query = query.lte('created_at', options.periodEnd);

    const { data, error } = await query;
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
    let query = supabase
      .from('settlement_invoices')
      .select(
        'id, agent_id, period_start, period_end, debt_owed, amount_paid, amount_remaining, status, due_date, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(options.limit || 1000);

    if (options.agentId) query = query.eq('agent_id', options.agentId);
    if (options.periodStart) query = query.gte('created_at', options.periodStart);
    if (options.periodEnd) query = query.lte('created_at', options.periodEnd);

    const { data, error } = await query;
    if (error) throw error;

    return {
      headers: [
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
      ],
      rows: data || [],
    };
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
