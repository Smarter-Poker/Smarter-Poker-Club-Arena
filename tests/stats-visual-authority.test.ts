import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');

const OWNER_PAGE = read('src/pages/PlayerStatsPage.tsx');
const CLUB_PAGE = read('src/pages/PlayerStatisticsPage.tsx');

const ACTIVE_STATS_VIEWS = [
  'src/pages/PlayerStatsPage.tsx',
  'src/pages/PlayerStatisticsPage.tsx',
  'src/pages/stats/RakeTab.tsx',
  'src/components/stats/AdvancedStatsSummary.tsx',
  'src/components/stats/BankrollTracker.tsx',
  'src/components/stats/BenchmarkPanel.tsx',
  'src/components/stats/EVLuckChart.tsx',
  'src/components/stats/HoleCardHeatmap.tsx',
  'src/components/stats/LeakPanel.tsx',
  'src/components/stats/NemesisPanel.tsx',
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
    expect(statSync(resolve(__dirname, '../public', ownerAsset)).size).toBeGreaterThan(50_000);
    expect(statSync(resolve(__dirname, '../public', clubAsset)).size).toBeGreaterThan(50_000);
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
});
