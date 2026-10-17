// tests/unit/horseFleetStatus.test.ts
import { describe, expect, it } from 'vitest';
import {
  KNOWN_FLEET_RUNS,
  calculateProgressBar,
  formatDuration,
  formatFleetTable,
  fetchRunStatus,
  fetchFleetStatus,
} from '../../scripts/ops/horse-fleet-status.mjs';

describe('Horse Fleet Status Dashboard', () => {
  describe('Fleet Definitions', () => {
    it('defines exactly 17 qualification league runs', () => {
      expect(KNOWN_FLEET_RUNS).toHaveLength(17);
    });

    it('contains all required phases and variants', () => {
      const phases = new Set(KNOWN_FLEET_RUNS.map((r) => r.phase));
      expect(Array.from(phases).sort()).toEqual([10, 11, 12, 13]);

      for (const entry of KNOWN_FLEET_RUNS) {
        expect(entry.phase).toBeGreaterThanOrEqual(10);
        expect(entry.phase).toBeLessThanOrEqual(13);
        expect(typeof entry.variant).toBe('string');
        expect(typeof entry.runId).toBe('string');
        expect(entry.runId).toMatch(/^\d+$/);
        expect(entry.expectedShards).toBeGreaterThan(0);
      }
    });

    it('contains all 9 Phase 13 joint league variants', () => {
      const phase13 = KNOWN_FLEET_RUNS.filter((r) => r.phase === 13);
      expect(phase13).toHaveLength(9);
      const variants = phase13.map((r) => r.variant);
      expect(variants).toContain('plo8');
      expect(variants).toContain('plo4');
      expect(variants).toContain('nlh');
      expect(variants).toContain('plo5');
      expect(variants).toContain('plo6');
      expect(variants).toContain('flo8');
      expect(variants).toContain('flh');
      expect(variants).toContain('pineapple');
      expect(variants).toContain('short_deck');
    });
  });

  describe('Progress Bar Calculation', () => {
    it('formats 0% progress', () => {
      expect(calculateProgressBar(0, 100, 10)).toBe('[░░░░░░░░░░]   0%');
    });

    it('formats 50% progress', () => {
      expect(calculateProgressBar(50, 100, 10)).toBe('[█████░░░░░]  50%');
    });

    it('formats 100% progress', () => {
      expect(calculateProgressBar(100, 100, 10)).toBe('[██████████] 100%');
    });

    it('handles 0 or negative total safely', () => {
      expect(calculateProgressBar(0, 0, 10)).toBe('[          ]   0%');
    });
  });

  describe('Duration Formatting', () => {
    it('returns hyphen for missing createdAt', () => {
      expect(formatDuration(null)).toBe('-');
      expect(formatDuration(undefined)).toBe('-');
    });

    it('formats minutes and hours accurately', () => {
      const start = '2026-10-17T12:00:00Z';
      const endSameHour = '2026-10-17T12:35:00Z';
      expect(formatDuration(start, endSameHour)).toBe('35m');

      const endMultiHour = '2026-10-17T15:20:00Z';
      expect(formatDuration(start, endMultiHour)).toBe('3h 20m');
    });
  });

  describe('Table Formatting', () => {
    it('renders a formatted table with headers, rows, and footer', () => {
      const mockFleet = [
        {
          phase: 11,
          variant: 'plo6',
          runId: '38988218988',
          status: 'in_progress',
          conclusion: null,
          shardsCompleted: 215,
          shardsTotal: 244,
          inProgress: 8,
          queued: 21,
          failed: 0,
          duration: '11h 35m',
          verdict: 'running',
          progressBar: calculateProgressBar(215, 244, 10),
        },
      ];

      const table = formatFleetTable(mockFleet);
      expect(table).toContain('Phase');
      expect(table).toContain('Variant');
      expect(table).toContain('Run ID');
      expect(table).toContain('Progress');
      expect(table).toContain('Verdict');
      expect(table).toContain('P11');
      expect(table).toContain('plo6');
      expect(table).toContain('38988218988');
      expect(table).toContain('Total Fleet: 17 Leagues');
    });
  });

  describe('Status Fetching with Mock Binary', () => {
    it('handles CLI execution errors gracefully without throwing', () => {
      const result = fetchRunStatus('999999999', { ghBin: 'non-existent-gh-bin-test' });
      expect(result.status).toBe('error');
      expect(result.conclusion).toBe('error');
      expect(result.completed).toBe(0);
      expect(result.duration).toBe('-');
    });

    it('fetches fleet status with error fallbacks', () => {
      const fleet = fetchFleetStatus({
        runs: [{ phase: 10, variant: 'plo4', runId: '12345', expectedShards: 111 }],
        ghBin: 'non-existent-gh-bin-test',
      });
      expect(fleet).toHaveLength(1);
      expect(fleet[0].phase).toBe(10);
      expect(fleet[0].variant).toBe('plo4');
      expect(fleet[0].shardsTotal).toBe(111);
      expect(fleet[0].verdict).toBe('-');
    });

    it('falls back to completed status for previously qualified archived runs when API is unreachable', () => {
      const fleet = fetchFleetStatus({
        runs: [
          {
            phase: 10,
            variant: 'plo4',
            runId: '38936316718',
            expectedShards: 111,
            initialVerdict: 'qualified',
          },
        ],
        ghBin: 'non-existent-gh-bin-test',
      });
      expect(fleet).toHaveLength(1);
      expect(fleet[0].status).toBe('completed');
      expect(fleet[0].shardsCompleted).toBe(111);
      expect(fleet[0].shardsTotal).toBe(111);
      expect(fleet[0].verdict).toBe('qualified');
      expect(fleet[0].progressBar).toContain('100%');
    });
  });
});
