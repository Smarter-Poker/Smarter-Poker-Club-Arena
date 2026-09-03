/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — HorseBugReporter
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - report: creates bug report with auto-generated id, timestamp, resolved=false
 * - validateChips: detects NaN, negative stack, suspicious win amount
 * - validatePot: detects NaN pot, pot/bets mismatch
 * - getReports: filtering by severity/category/resolved
 * - getStats: correct aggregation of severity/category
 * - resolve/clear: state management
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { horseBugReporter } from '../../src/services/HorseBugReporter';

describe('HorseBugReporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    horseBugReporter.clear();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REPORT
  // ─────────────────────────────────────────────────────────────────────────

  describe('report', () => {
    it('should create a report with generated id and timestamp', () => {
      horseBugReporter.report({
        horseName: 'TestHorse',
        horseId: 'h1',
        tableId: 't1',
        tableName: 'Table 1',
        handNumber: 42,
        category: 'chip_integrity',
        severity: 'high',
        title: 'Test bug',
        description: 'Test description',
        context: {},
      });

      const reports = horseBugReporter.getReports();
      expect(reports.length).toBe(1);
      expect(reports[0].id).toMatch(/^bug_/);
      expect(reports[0].resolved).toBe(false);
      expect(reports[0].horseName).toBe('TestHorse');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VALIDATE CHIPS
  // ─────────────────────────────────────────────────────────────────────────

  describe('validateChips', () => {
    it('should detect NaN stack', () => {
      horseBugReporter.validateChips('H1', 'h1', 't1', 'T1', 1, 100, NaN, 'bet', 50);
      const reports = horseBugReporter.getReports();
      expect(reports.length).toBe(1);
      expect(reports[0].severity).toBe('critical');
      expect(reports[0].title).toContain('NaN');
    });

    it('should detect negative stack', () => {
      horseBugReporter.validateChips('H1', 'h1', 't1', 'T1', 1, 100, -50, 'bet', 150);
      const reports = horseBugReporter.getReports();
      expect(reports.length).toBe(1);
      expect(reports[0].severity).toBe('critical');
      expect(reports[0].title).toContain('Negative');
    });

    it('should detect suspicious win amount (> 100x stack)', () => {
      horseBugReporter.validateChips('H1', 'h1', 't1', 'T1', 1, 100, 20000, 'win', 20000);
      const reports = horseBugReporter.getReports();
      expect(reports.length).toBe(1);
      expect(reports[0].severity).toBe('high');
      expect(reports[0].title).toContain('Suspicious');
    });

    it('should NOT report normal chip movement', () => {
      horseBugReporter.validateChips('H1', 'h1', 't1', 'T1', 1, 1000, 950, 'bet', 50);
      const reports = horseBugReporter.getReports();
      expect(reports.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VALIDATE POT
  // ─────────────────────────────────────────────────────────────────────────

  describe('validatePot', () => {
    it('should detect NaN pot', () => {
      horseBugReporter.validatePot('t1', 'T1', 1, NaN, [
        { name: 'P1', bet: 50 },
        { name: 'P2', bet: 50 },
      ]);
      const reports = horseBugReporter.getReports();
      expect(reports.length).toBe(1);
      expect(reports[0].title).toContain('NaN');
    });

    it('should detect pot/bets mismatch', () => {
      horseBugReporter.validatePot('t1', 'T1', 1, 120, [
        { name: 'P1', bet: 50 },
        { name: 'P2', bet: 50 },
      ]);
      const reports = horseBugReporter.getReports();
      expect(reports.length).toBe(1);
      expect(reports[0].category).toBe('pot_mismatch');
    });

    it('should NOT report matching pot', () => {
      horseBugReporter.validatePot('t1', 'T1', 1, 100, [
        { name: 'P1', bet: 50 },
        { name: 'P2', bet: 50 },
      ]);
      const reports = horseBugReporter.getReports();
      expect(reports.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getReports FILTERING
  // ─────────────────────────────────────────────────────────────────────────

  describe('getReports', () => {
    it('should filter by severity', () => {
      horseBugReporter.report({
        horseName: 'H1',
        horseId: 'h1',
        tableId: 't1',
        tableName: 'T1',
        handNumber: 1,
        category: 'chip_integrity',
        severity: 'critical',
        title: 'A',
        description: '',
        context: {},
      });
      horseBugReporter.report({
        horseName: 'H1',
        horseId: 'h1',
        tableId: 't1',
        tableName: 'T1',
        handNumber: 2,
        category: 'chip_integrity',
        severity: 'low',
        title: 'B',
        description: '',
        context: {},
      });

      const crit = horseBugReporter.getReports({ severity: 'critical' });
      expect(crit.length).toBe(1);
      expect(crit[0].title).toBe('A');
    });

    it('should filter by category', () => {
      horseBugReporter.report({
        horseName: 'H1',
        horseId: 'h1',
        tableId: 't1',
        tableName: 'T1',
        handNumber: 1,
        category: 'pot_mismatch',
        severity: 'medium',
        title: 'Pot',
        description: '',
        context: {},
      });
      horseBugReporter.report({
        horseName: 'H1',
        horseId: 'h1',
        tableId: 't1',
        tableName: 'T1',
        handNumber: 2,
        category: 'rpc_error',
        severity: 'high',
        title: 'RPC',
        description: '',
        context: {},
      });

      const rpc = horseBugReporter.getReports({ category: 'rpc_error' });
      expect(rpc.length).toBe(1);
      expect(rpc[0].title).toBe('RPC');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getStats
  // ─────────────────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('should aggregate correctly', () => {
      horseBugReporter.report({
        horseName: 'H1',
        horseId: 'h1',
        tableId: 't1',
        tableName: 'T1',
        handNumber: 1,
        category: 'chip_integrity',
        severity: 'critical',
        title: 'A',
        description: '',
        context: {},
      });
      horseBugReporter.report({
        horseName: 'H1',
        horseId: 'h1',
        tableId: 't1',
        tableName: 'T1',
        handNumber: 2,
        category: 'pot_mismatch',
        severity: 'high',
        title: 'B',
        description: '',
        context: {},
      });

      const stats = horseBugReporter.getStats();
      expect(stats.total).toBe(2);
      expect(stats.bySeverity.critical).toBe(1);
      expect(stats.bySeverity.high).toBe(1);
      expect(stats.byCategory['chip_integrity']).toBe(1);
      expect(stats.byCategory['pot_mismatch']).toBe(1);
      expect(stats.unresolvedCount).toBe(2);
    });

    it('should return 0 total when empty', () => {
      const stats = horseBugReporter.getStats();
      expect(stats.total).toBe(0);
      expect(stats.lastReportTime).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RESOLVE / CLEAR
  // ─────────────────────────────────────────────────────────────────────────

  describe('resolve', () => {
    it('should mark report as resolved', () => {
      horseBugReporter.report({
        horseName: 'H1',
        horseId: 'h1',
        tableId: 't1',
        tableName: 'T1',
        handNumber: 1,
        category: 'chip_integrity',
        severity: 'critical',
        title: 'A',
        description: '',
        context: {},
      });
      const id = horseBugReporter.getReports()[0].id;
      horseBugReporter.resolve(id);
      expect(horseBugReporter.getStats().unresolvedCount).toBe(0);
    });
  });

  describe('clear', () => {
    it('should empty all reports', () => {
      horseBugReporter.report({
        horseName: 'H1',
        horseId: 'h1',
        tableId: 't1',
        tableName: 'T1',
        handNumber: 1,
        category: 'chip_integrity',
        severity: 'critical',
        title: 'A',
        description: '',
        context: {},
      });
      horseBugReporter.clear();
      expect(horseBugReporter.getStats().total).toBe(0);
    });
  });
});
