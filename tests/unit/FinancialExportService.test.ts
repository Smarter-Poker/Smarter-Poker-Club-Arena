/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — FinancialExportService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests CSV generation and file naming:
 * - CSV header and data formatting
 * - Double-quote escaping
 * - Null/undefined handling
 * - Filename generation
 * - Unknown export type error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () => Promise.resolve({ data: [], error: null }),
        }),
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
          gte: () => ({
            lte: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { FinancialExportService } from '../../src/services/FinancialExportService';

describe('FinancialExportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CSV GENERATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('generateCSV', () => {
    it('should generate CSV with headers and data rows', () => {
      const headers = ['Name', 'Amount', 'Status'];
      const rows = [
        { name: 'Alice', amount: 100, status: 'paid' },
        { name: 'Bob', amount: 200, status: 'pending' },
      ];

      const csv = FinancialExportService.generateCSV(headers, rows);
      const lines = csv.split('\n');

      expect(lines).toHaveLength(3); // 1 header + 2 data
      expect(lines[0]).toBe('"Name","Amount","Status"');
      expect(lines[1]).toBe('"Alice","100","paid"');
      expect(lines[2]).toBe('"Bob","200","pending"');
    });

    it('should escape double quotes in values', () => {
      const headers = ['Description'];
      const rows = [{ description: 'He said "hello"' }];

      const csv = FinancialExportService.generateCSV(headers, rows);
      const lines = csv.split('\n');

      // Double quotes should be doubled per CSV spec
      expect(lines[1]).toBe('"He said ""hello"""');
    });

    it('should handle null and undefined values', () => {
      const headers = ['Field1', 'Field2'];
      const rows = [{ field1: null, field2: undefined }];

      const csv = FinancialExportService.generateCSV(headers, rows);
      const lines = csv.split('\n');

      expect(lines[1]).toBe('"",""');
    });

    it('should handle empty rows array', () => {
      const headers = ['A', 'B'];
      const csv = FinancialExportService.generateCSV(headers, []);
      const lines = csv.split('\n');

      expect(lines).toHaveLength(1); // Header only
      expect(lines[0]).toBe('"A","B"');
    });

    it('should handle numeric and boolean values', () => {
      const headers = ['Num', 'Bool'];
      const rows = [{ num: 42.5, bool: true }];

      const csv = FinancialExportService.generateCSV(headers, rows);
      const lines = csv.split('\n');

      expect(lines[1]).toBe('"42.5","true"');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FILENAME GENERATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('getFilename', () => {
    it('should include export type in filename', () => {
      const filename = FinancialExportService.getFilename({ type: 'settlement_club' });
      expect(filename).toContain('settlement_club');
    });

    it('should include date in filename', () => {
      const filename = FinancialExportService.getFilename({ type: 'rake_records' });
      // Format: club_arena_rake_records_YYYY-MM-DD.csv
      expect(filename).toMatch(/club_arena_rake_records_\d{4}-\d{2}-\d{2}\.csv/);
    });

    it('should end with .csv extension', () => {
      const filename = FinancialExportService.getFilename({ type: 'wallet_transactions' });
      expect(filename).toMatch(/\.csv$/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DATA FETCHING ERROR HANDLING
  // ─────────────────────────────────────────────────────────────────────────

  describe('fetchData routing', () => {
    it('should throw for unknown export type', async () => {
      await expect(
        FinancialExportService.fetchData({ type: 'unknown_type' as any })
      ).rejects.toThrow('Unknown export type');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EXPORT CSV (INTEGRATION)
  // ─────────────────────────────────────────────────────────────────────────

  describe('exportCSV', () => {
    it('should return error when no data found', async () => {
      // Mock returns empty data
      const result = await FinancialExportService.exportCSV({ type: 'settlement_club' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('No data found for export');
    });
  });
});
