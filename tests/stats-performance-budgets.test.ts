import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');

describe('Stats performance budgets', () => {
  it('gates the overview route plus every lazy Stats tab and chart from measured output', () => {
    const config = JSON.parse(read('scripts/ci/stats-performance-budgets.json'));
    expect(config.measurement).toContain('production Vite build');
    expect(config.overviewRoute.chunks).toEqual(['PlayerStatsPage', 'OverviewTab']);
    for (const name of [
      'OverviewTab',
      'PerformanceTab',
      'PositionsTab',
      'HandsTab',
      'RakeTab',
      'TrophiesTab',
      'TournamentsTab',
      'AnalysisTab',
      'StatsCharts',
      'EVLuckChart',
      'BankrollTracker',
      'PositionWinRates',
      'PositionalRadar',
    ]) {
      expect(config.chunks[name]?.baselineGzipKb, name).toBeGreaterThan(0);
      expect(config.chunks[name]?.maxGzipKb, name).toBeGreaterThan(
        config.chunks[name].baselineGzipKb
      );
    }
    const script = read('scripts/ci/check-stats-performance-budgets.mjs');
    expect(script).toContain('gzipSync');
    expect(script).toContain('expected exactly one output chunk');
    expect(read('.github/workflows/ci.yml')).toContain('npm run check:stats-budgets');
  });
});
