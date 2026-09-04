/**
 * Stats Page Programme, phase 2: one lazy chunk per tab, dead code out, the
 * coach wired in, the inline section colours gone.
 *
 * The behavioural half of this phase is covered by
 * tests/components/player-stats-page-renders.test.tsx (the page still renders
 * with the tabs behind lazy()) and tests/stats-charts-stay-lazy.test.ts (the
 * recharts split survives). This file pins the structure so the next agent
 * cannot quietly fold a tab back into the page or resurrect a retired panel.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE = strip(read('src/pages/PlayerStatsPage.tsx'));
const TAB_DIR = join(ROOT, 'src', 'pages', 'stats');
const TABS = [
  'RakeTab',
  'OverviewTab',
  'PerformanceTab',
  'PositionsTab',
  'HandsTab',
  'TrophiesTab',
  'TournamentsTab',
  'AnalysisTab',
] as const;

describe('one lazy chunk per tab', () => {
  it.each(TABS.map((t) => [t]))(
    '%s exists, default-exports a component, and is lazy in the page',
    (tab) => {
      const src = read(`src/pages/stats/${tab}.tsx`);
      expect(src).toMatch(new RegExp(`export default function ${tab}\\(`));
      expect(PAGE).toMatch(
        new RegExp(`const ${tab}\\s*=\\s*lazy\\(\\(\\)\\s*=>\\s*import\\('./stats/${tab}'\\)\\)`)
      );
      expect(PAGE).toMatch(new RegExp(`<${tab}[\\s/]`));
    }
  );

  it('the page is under 2,000 lines and holds no tab markup', () => {
    const lines = read('src/pages/PlayerStatsPage.tsx').split('\n').length;
    expect(lines).toBeLessThan(2000); // 2,809 before the split
    for (const marker of [
      '<StatRow',
      '<NemesisPanel',
      '<BenchmarkPanel',
      '<StatsShareCard',
      '<EVLuckChart',
      '<PositionalRadar',
      '<PositionWinRates',
      '<HoleCardHeatmap',
      '<TrophyRoom',
      '<StatsCharts',
      '<SessionHistory',
      '<BankrollTracker',
      '<AdvancedStatsSummary',
      '<DownlineRakePanel',
    ]) {
      expect(PAGE, marker).not.toContain(marker);
    }
  });

  it('the gating conditions stayed in the page, where printing can override them', () => {
    // Owner-only tabs keep their privacy gate on the page side of the boundary.
    expect(PAGE).toMatch(/showTab\('hands'\) && isOwnProfile && hasData && \(\s*<HandsTab/);
    expect(PAGE).toMatch(/showTab\('trophies'\) && isOwnProfile && hasData && \(\s*<TrophiesTab/);
    expect(PAGE).toMatch(/showTab\('rake'\) && \(\s*<RakeTab/);
    expect(PAGE).toMatch(
      /const showTab = useCallback\(\s*\(t: StatCategory\) => printing \|\| category === t/
    );
  });

  it('shared pieces live beside the tabs, once', () => {
    expect(existsSync(join(TAB_DIR, 'types.ts'))).toBe(true);
    expect(existsSync(join(TAB_DIR, 'format.ts'))).toBe(true);
    expect(existsSync(join(TAB_DIR, 'StatRow.tsx'))).toBe(true);
    const types = read('src/pages/stats/types.ts');
    for (const t of [
      'OverallStats',
      'FullStats',
      'TournamentSummary',
      'HandRow',
      'SessionRow',
      'PositionRow',
    ]) {
      expect(types).toMatch(new RegExp(`export interface ${t} `));
    }
    expect(types).toMatch(/export const RANGES/);
    expect(types).toMatch(/export const num = /);
    // ... and not also in the page.
    expect(PAGE).not.toMatch(/^interface OverallStats /m);
    expect(PAGE).not.toMatch(/^const RANGES/m);
    expect(PAGE).not.toMatch(/^function StatRow\(/m);
  });

  it('the Trophy Room still reads the all-time payload and the tab receives it from the page', () => {
    const trophies = read('src/pages/stats/TrophiesTab.tsx');
    expect(trophies).toMatch(/overall=\{allTimeStats\.overall\}/);
    expect(PAGE).toMatch(/allTimeStats=\{allTimeStats\}/);
  });
});

describe('dead code out (programme section 3)', () => {
  it.each([
    ['PerformanceTrends'],
    ['StakeLevelComparison'],
    ['PlayerStyleRadar'],
    ['StatsExportButton'],
  ])('%s is gone from disk, the barrel, and every import', (name) => {
    expect(existsSync(join(ROOT, 'src', 'components', 'stats', `${name}.tsx`))).toBe(false);
    expect(existsSync(join(ROOT, 'src', 'components', 'stats', `${name}.css`))).toBe(false);
    expect(read('src/components/stats/index.ts')).not.toMatch(new RegExp(`from './${name}'`));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && strip(readFileSync(p, 'utf8')).includes(`/${name}'`))
          offenders.push(p);
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });

  it('their localStorage prefixes are still reaped, so a player is left clean', () => {
    const reaper = read('src/utils/staleCacheReaper.ts');
    for (const prefix of ['psr_cache_', 'pt_cache_', 'slc_cache_'])
      expect(reaper).toContain(prefix);
  });
});

describe('the coach is wired in', () => {
  it('AnalysisTab renders LeakPanel from the overall rates and per-position counts the page already holds', () => {
    const analysis = strip(read('src/pages/stats/AnalysisTab.tsx'));
    expect(analysis).toMatch(/import LeakPanel from '\.\.\/\.\.\/components\/stats\/LeakPanel'/);
    expect(analysis).toMatch(
      /<LeakPanel overall=\{overall\} positions=\{full\?\.positions\} still=\{printing\} \/>/
    );
    // It is the first section on the tab: what to do before what the numbers are.
    expect(analysis.indexOf('<LeakPanel')).toBeLessThan(analysis.indexOf('<AdvancedStatsSummary'));
    expect(analysis).toMatch(/<PanelBoundary name="What To Work On"/);
  });

  it('findLeaks keeps its sample gate and stays pure', () => {
    const leaks = read('src/components/stats/findLeaks.ts');
    expect(leaks).toMatch(/export const LEAK_MIN_HANDS = 500;/);
    expect(leaks).not.toMatch(/supabase|fetch\(/);
  });
});

describe('inline section colours are gone', () => {
  it('no tab and no page carries an <h3 style={{ color }}>', () => {
    const sources = [PAGE, ...TABS.map((t) => strip(read(`src/pages/stats/${t}.tsx`)))];
    for (const src of sources) expect(src).not.toMatch(/<h3 style=\{\{ color:/);
  });

  it('the section title colour is set once, in the stylesheet', () => {
    const css = read('src/pages/PlayerStatsPage.css');
    expect(css).toMatch(/\.stats-section-header h3 \{[^}]*color: #e9eef3;/);
  });
});
