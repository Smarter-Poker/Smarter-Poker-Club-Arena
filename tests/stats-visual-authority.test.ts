import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');

const OWNER_PAGE = read('src/pages/PlayerStatsPage.tsx');
const CLUB_PAGE = read('src/pages/PlayerStatisticsPage.tsx');

const ACTIVE_STATS_VIEWS = [
  'src/pages/PlayerStatsPage.tsx',
  'src/pages/PlayerStatisticsPage.tsx',
  'src/pages/stats/AnalysisTab.tsx',
  'src/pages/stats/HandsTab.tsx',
  'src/pages/stats/OverviewTab.tsx',
  'src/pages/stats/PerformanceTab.tsx',
  'src/pages/stats/PositionsTab.tsx',
  'src/pages/stats/RakeTab.tsx',
  'src/pages/stats/StatRow.tsx',
  'src/pages/stats/TournamentsTab.tsx',
  'src/pages/stats/TrophiesTab.tsx',
  'src/components/stats/AdvancedStatsSummary.tsx',
  'src/components/stats/BankrollTracker.tsx',
  'src/components/stats/BenchmarkPanel.tsx',
  'src/components/stats/EVLuckChart.tsx',
  'src/components/stats/ExactCashSessionsPanel.tsx',
  'src/components/stats/FinancialReportingPanel.tsx',
  'src/components/stats/HoleCardHeatmap.tsx',
  'src/components/stats/LeakPanel.tsx',
  'src/components/stats/NemesisPanel.tsx',
  'src/components/stats/PanelBoundary.tsx',
  'src/components/stats/PositionalRadar.tsx',
  'src/components/stats/PositionWinRates.tsx',
  'src/components/stats/SessionHistory.tsx',
  'src/components/stats/StatsCharts.tsx',
  'src/components/stats/StatsShareCard.tsx',
  'src/components/stats/TrophyRoom.tsx',
];

const MACHINED_PANEL_STYLES = [
  'src/components/stats/AdvancedStatsSummary.css',
  'src/components/stats/BankrollTracker.css',
  'src/components/stats/BenchmarkPanel.css',
  'src/components/stats/EVLuckChart.css',
  'src/components/stats/ExactCashSessionsPanel.css',
  'src/components/stats/FinancialReportingPanel.css',
  'src/components/stats/HoleCardHeatmap.css',
  'src/components/stats/LeakPanel.css',
  'src/components/stats/NemesisPanel.css',
  'src/components/stats/PositionalRadar.css',
  'src/components/stats/PositionWinRates.css',
  'src/components/stats/SessionHistory.css',
  'src/components/stats/StatsShareCard.css',
  'src/components/stats/TrophyRoom.css',
];

describe('Stats visual authority', () => {
  it('keeps the owner dossier and club instrument on distinct approved master art', () => {
    const ownerAsset = 'images/stats/player-intelligence-dossier-v2.webp';
    const clubAsset = 'images/club-members/player-instrument-felt-v1.webp';

    expect(OWNER_PAGE).toContain(ownerAsset);
    expect(CLUB_PAGE).toContain(clubAsset);
    expect(ownerAsset).not.toBe(clubAsset);
    const ownerPath = resolve(__dirname, '../public', ownerAsset);
    const clubPath = resolve(__dirname, '../public', clubAsset);
    expect(statSync(ownerPath).size).toBeGreaterThan(50_000);
    expect(statSync(clubPath).size).toBeGreaterThan(50_000);
    expect(readFileSync(ownerPath).equals(readFileSync(clubPath))).toBe(false);
  });

  it('does not use primitive glyphs as decorative Stats controls or status art', () => {
    const primitiveGlyph = /[♠♥♦♣▲▼▪✓✗○★☆⚠→←↑↓]/u;
    for (const file of ACTIVE_STATS_VIEWS) {
      const source = read(file);
      expect(source, file).not.toMatch(primitiveGlyph);
      expect(source, file).not.toContain('className="empty-icon"');
      expect(source, file).not.toContain('className="stat-icon"');
      expect(source, file).not.toContain('className="callout-icon"');
      expect(source, file).not.toContain('style.icon');
    }
  });

  it('uses sharp physical frames instead of the retired rounded glass panel recipe', () => {
    for (const file of MACHINED_PANEL_STYLES) {
      const css = read(file);
      expect(css, file).not.toContain('backdrop-filter');
      expect(css, file).not.toMatch(/border-radius:\s*(?:8|10|12|14|16)px/);
      expect(css, file).not.toContain('border-radius: 999px');
    }
  });

  it('exports a bespoke chamfered Stats graphic instead of generic rounded tiles', () => {
    const shareCard = read('src/components/stats/StatsShareCard.tsx');
    expect(shareCard).toContain('function chamferRect(');
    expect(shareCard).toContain('Etched drafting grid');
    expect(shareCard).not.toContain('function roundRect(');
  });

  it('gives money and exact-session ledgers distinct approved physical chassis', () => {
    const financial = read('src/components/stats/FinancialReportingPanel.tsx');
    const sessions = read('src/components/stats/ExactCashSessionsPanel.tsx');
    expect(financial).toContain('family="riveted"');
    expect(sessions).toContain('family="shark"');
    expect(financial).not.toContain('player-intelligence-dossier-v2.webp');
    expect(sessions).not.toContain('player-intelligence-dossier-v2.webp');
    expect(financial).not.toContain('stats-strategy-lab-v1.webp');
    expect(sessions).not.toContain('stats-strategy-lab-v1.webp');
    for (const asset of [
      'public/assets/club-buttons/console/riveted-console-v2/top.png',
      'public/assets/club-buttons/console/shark-console-v2/top.png',
    ]) {
      expect(statSync(resolve(__dirname, '..', asset)).size).toBeGreaterThan(10_000);
    }
  });
});
