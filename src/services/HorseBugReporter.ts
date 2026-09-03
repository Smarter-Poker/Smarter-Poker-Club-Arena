/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HORSE BUG REPORTER — Mini-Agent Automated QA System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Horses act as automated QA mini-agents during gameplay. As they play hands
 * across all cash games and tournaments, they detect, capture, and report:
 *
 * - Runtime errors (uncaught exceptions, promise rejections)
 * - Gameplay anomalies (impossible chip amounts, negative stacks, NaN values)
 * - UI rendering failures (missing cards, broken avatars, display glitches)
 * - Action handler failures (raise rejected, fold when not needed, timeouts)
 * - Pot calculation mismatches (expected vs actual pot)
 * - Wallet sync failures (debit without credit, balance mismatches)
 * - Tournament lifecycle bugs (registration failures, blind level skips)
 * - Supabase RPC errors (function not found, permission denied)
 *
 * Reports are stored in-memory + persisted to Supabase `horse_bug_reports` table.
 * A dashboard component displays live bug reports for the admin.
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type BugSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type BugCategory =
  | 'runtime_error'
  | 'gameplay_anomaly'
  | 'ui_render'
  | 'action_failure'
  | 'pot_mismatch'
  | 'wallet_sync'
  | 'tournament_bug'
  | 'rpc_error'
  | 'chip_integrity'
  | 'state_desync'
  | 'performance'
  | 'missing_data';

export interface BugReport {
  id: string;
  timestamp: string;
  horseName: string;
  horseId: string;
  tableId: string;
  tableName: string;
  handNumber: number;
  category: BugCategory;
  severity: BugSeverity;
  title: string;
  description: string;
  context: Record<string, any>;
  stackTrace?: string;
  resolved: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUG REPORTER SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class HorseBugReporterService {
  private reports: BugReport[] = [];
  private maxReports = 500;
  private isCapturing = false;
  private originalConsoleError: typeof console.error;
  private errorListener: ((event: ErrorEvent) => void) | null = null;
  private rejectionListener: ((event: PromiseRejectionEvent) => void) | null = null;

  constructor() {
    this.originalConsoleError = console.error.bind(console);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────────

  /** Start capturing bugs globally */
  startCapturing(): void {
    if (this.isCapturing) return;
    this.isCapturing = true;

    // Intercept console.error
    console.error = (...args: any[]) => {
      this.originalConsoleError(...args);
      const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

      // Auto-categorize known error patterns
      if (msg.includes('RPC') || msg.includes('rpc') || msg.includes('function')) {
        this.reportFromConsole(msg, 'rpc_error', 'high');
      } else if (msg.includes('wallet') || msg.includes('Wallet') || msg.includes('balance')) {
        this.reportFromConsole(msg, 'wallet_sync', 'high');
      } else if (msg.includes('HandController') || msg.includes('performAction')) {
        this.reportFromConsole(msg, 'action_failure', 'medium');
      } else if (msg.includes('table_seats') || msg.includes('buy-in') || msg.includes('BuyIn')) {
        this.reportFromConsole(msg, 'gameplay_anomaly', 'medium');
      } else if (msg.includes('tournament') || msg.includes('Tournament')) {
        this.reportFromConsole(msg, 'tournament_bug', 'medium');
      }
    };

    // Global error handler
    this.errorListener = (event: ErrorEvent) => {
      this.report({
        horseName: 'GLOBAL',
        horseId: 'system',
        tableId: 'global',
        tableName: 'Global',
        handNumber: 0,
        category: 'runtime_error',
        severity: 'critical',
        title: `Uncaught Error: ${event.message}`,
        description: `${event.filename}:${event.lineno}:${event.colno}`,
        context: { filename: event.filename, lineno: event.lineno },
        stackTrace: event.error?.stack,
      });
    };
    window.addEventListener('error', this.errorListener);

    // Unhandled promise rejection handler
    this.rejectionListener = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      this.report({
        horseName: 'GLOBAL',
        horseId: 'system',
        tableId: 'global',
        tableName: 'Global',
        handNumber: 0,
        category: 'runtime_error',
        severity: 'high',
        title: `Unhandled Promise Rejection`,
        description: typeof reason === 'string' ? reason : reason?.message || 'Unknown Rejection',
        context: { reason: String(reason) },
        stackTrace: reason?.stack,
      });
    };
    window.addEventListener('unhandledrejection', this.rejectionListener);

    console.debug('[HorseBugReporter] Mini-agent QA system ACTIVE - capturing bugs');
  }

  /** Stop capturing */
  stopCapturing(): void {
    if (!this.isCapturing) return;
    this.isCapturing = false;
    console.error = this.originalConsoleError;
    if (this.errorListener) window.removeEventListener('error', this.errorListener);
    if (this.rejectionListener)
      window.removeEventListener('unhandledrejection', this.rejectionListener);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // REPORT METHODS — Called by horses during gameplay
  // ─────────────────────────────────────────────────────────────────────────

  /** Main report method */
  report(data: Omit<BugReport, 'id' | 'timestamp' | 'resolved'>): void {
    const report: BugReport = {
      ...data,
      id: `bug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      resolved: false,
    };

    this.reports.push(report);

    // Trim old reports
    if (this.reports.length > this.maxReports) {
      this.reports = this.reports.slice(-this.maxReports);
    }

    // Broadcast via MasterBus so dashboard can update
    masterBus.emit('HORSE_BUG_REPORT', { ...report } as Record<string, unknown>);

    // Persist critical/high/medium to Supabase (fire and forget)
    if (
      report.severity === 'critical' ||
      report.severity === 'high' ||
      report.severity === 'medium'
    ) {
      this.persistToSupabase(report).catch((e) =>
        reportError(e, 'HorseBugReporter.Failed_to_persist')
      );
    }

    // Log with severity color
    const colors: Record<BugSeverity, string> = {
      critical: '\x1b[31m', // red
      high: '\x1b[33m', // yellow
      medium: '\x1b[36m', // cyan
      low: '\x1b[37m', // white
      info: '\x1b[90m', // gray
    };
    // Use console.warn for info/low severity to avoid polluting error console
    const logFn =
      report.severity === 'info' || report.severity === 'low'
        ? console.warn.bind(console)
        : this.originalConsoleError;
    logFn(
      `${colors[report.severity]}[BUG:${report.severity.toUpperCase()}] [${report.horseName}@${report.tableName}] ${report.title}\x1b[0m`
    );
  }

  /** Quick report from console.error intercept */
  private reportFromConsole(msg: string, category: BugCategory, severity: BugSeverity): void {
    // Dedupe: skip if same message reported in last 5 seconds
    const recent = this.reports.filter(
      (r) => r.title === msg.slice(0, 120) && Date.now() - new Date(r.timestamp).getTime() < 5000
    );
    if (recent.length > 0) return;

    this.report({
      horseName: 'Console',
      horseId: 'console',
      tableId: 'unknown',
      tableName: 'Unknown',
      handNumber: 0,
      category,
      severity,
      title: msg.slice(0, 120),
      description: msg,
      context: { source: 'console.error' },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GAMEPLAY VALIDATORS — Called during horse play
  // ─────────────────────────────────────────────────────────────────────────

  /** Validate chip integrity after an action */
  validateChips(
    horseName: string,
    horseId: string,
    tableId: string,
    tableName: string,
    handNumber: number,
    stackBefore: number,
    stackAfter: number,
    action: string,
    amount: number
  ): void {
    // Check for NaN
    if (isNaN(stackAfter) || isNaN(stackBefore)) {
      this.report({
        horseName,
        horseId,
        tableId,
        tableName,
        handNumber,
        category: 'chip_integrity',
        severity: 'critical',
        title: `NaN Stack Detected After ${action}`,
        description: `Stack Went From ${stackBefore} To ${stackAfter} After ${action} Of ${amount}`,
        context: { stackBefore, stackAfter, action, amount },
      });
    }

    // Check for negative stack
    if (stackAfter < 0) {
      this.report({
        horseName,
        horseId,
        tableId,
        tableName,
        handNumber,
        category: 'chip_integrity',
        severity: 'critical',
        title: `Negative Stack: ${stackAfter} After ${action}`,
        description: `Stack Went From ${stackBefore} To ${stackAfter}. Player Should Never Have Negative Chips.`,
        context: { stackBefore, stackAfter, action, amount },
      });
    }

    // Check for impossible chip gain (more than pot)
    if (action === 'win' && amount > stackBefore * 100) {
      this.report({
        horseName,
        horseId,
        tableId,
        tableName,
        handNumber,
        category: 'chip_integrity',
        severity: 'high',
        title: `Suspicious Win Amount: ${amount} (Stack Was ${stackBefore})`,
        description: `Won More Than 100x Stack. Possible Pot Calculation Error.`,
        context: { stackBefore, stackAfter, action, amount },
      });
    }
  }

  /** Validate pot calculation */
  validatePot(
    tableId: string,
    tableName: string,
    handNumber: number,
    potAmount: number,
    playerBets: { name: string; bet: number }[]
  ): void {
    const totalBets = playerBets.reduce((sum, p) => sum + p.bet, 0);

    if (isNaN(potAmount)) {
      this.report({
        horseName: 'PotValidator',
        horseId: 'system',
        tableId,
        tableName,
        handNumber,
        category: 'pot_mismatch',
        severity: 'critical',
        title: 'NaN Pot Detected',
        description: `Pot Is NaN. Player Bets Total: ${totalBets}`,
        context: { potAmount, playerBets },
      });
    }

    if (Math.abs(potAmount - totalBets) > 0.01 && totalBets > 0) {
      this.report({
        horseName: 'PotValidator',
        horseId: 'system',
        tableId,
        tableName,
        handNumber,
        category: 'pot_mismatch',
        severity: 'medium',
        title: `Pot Mismatch: Pot=${potAmount} Vs Bets=${totalBets}`,
        description: `Pot Amount Doesn't Match Sum Of Player Bets. Difference: ${(potAmount - totalBets).toFixed(2)}`,
        context: { potAmount, totalBets, playerBets },
      });
    }
  }

  /** Report an action that was rejected */
  reportActionRejected(
    horseName: string,
    horseId: string,
    tableId: string,
    tableName: string,
    handNumber: number,
    action: string,
    amount: number | undefined,
    reason: string
  ): void {
    this.report({
      horseName,
      horseId,
      tableId,
      tableName,
      handNumber,
      category: 'action_failure',
      severity: 'medium',
      title: `Action Rejected: ${action}${amount ? ` (${amount})` : ''}`,
      description: reason,
      context: { action, amount, reason },
    });
  }

  /** Report a Supabase RPC failure */
  reportRPCError(functionName: string, error: any, context: Record<string, any> = {}): void {
    this.report({
      horseName: 'RPC',
      horseId: 'system',
      tableId: context.tableId || 'unknown',
      tableName: context.tableName || 'Unknown',
      handNumber: context.handNumber || 0,
      category: 'rpc_error',
      severity: 'high',
      title: `RPC Failed: ${functionName}`,
      description: error?.message || String(error),
      context: { functionName, ...context },
      stackTrace: error?.stack,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PERSISTENCE
  // ─────────────────────────────────────────────────────────────────────────

  /** Persist a bug report to Supabase */
  private async persistToSupabase(report: BugReport): Promise<void> {
    try {
      await supabase.from('horse_bug_reports').insert({
        id: report.id,
        horse_name: report.horseName,
        horse_id: report.horseId,
        table_id: report.tableId,
        table_name: report.tableName,
        hand_number: report.handNumber,
        category: report.category,
        severity: report.severity,
        title: report.title,
        description: report.description,
        context: report.context,
        stack_trace: report.stackTrace || null,
        resolved: false,
        created_at: report.timestamp,
      });
    } catch (err) {
      console.error('[HorseBugReporter] Error:', err);
      // Silently fail — table might not exist yet
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // QUERY
  // ─────────────────────────────────────────────────────────────────────────

  /** Get all in-memory reports */
  getReports(filter?: {
    severity?: BugSeverity;
    category?: BugCategory;
    resolved?: boolean;
  }): BugReport[] {
    let results = [...this.reports];
    if (filter?.severity) results = results.filter((r) => r.severity === filter.severity);
    if (filter?.category) results = results.filter((r) => r.category === filter.category);
    if (filter?.resolved !== undefined)
      results = results.filter((r) => r.resolved === filter.resolved);
    return results.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  /** Get summary stats */
  getStats(): {
    total: number;
    bySeverity: Record<BugSeverity, number>;
    byCategory: Record<string, number>;
    unresolvedCount: number;
    lastReportTime: string | null;
  } {
    const bySeverity: Record<BugSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    const byCategory: Record<string, number> = {};
    let unresolvedCount = 0;

    for (const r of this.reports) {
      bySeverity[r.severity]++;
      byCategory[r.category] = (byCategory[r.category] || 0) + 1;
      if (!r.resolved) unresolvedCount++;
    }

    return {
      total: this.reports.length,
      bySeverity,
      byCategory,
      unresolvedCount,
      lastReportTime:
        this.reports.length > 0 ? this.reports[this.reports.length - 1].timestamp : null,
    };
  }

  /** Mark a report as resolved */
  resolve(reportId: string): void {
    const report = this.reports.find((r) => r.id === reportId);
    if (report) report.resolved = true;
  }

  /** Clear all reports */
  clear(): void {
    this.reports = [];
  }
}

// Singleton
export const horseBugReporter = new HorseBugReporterService();
