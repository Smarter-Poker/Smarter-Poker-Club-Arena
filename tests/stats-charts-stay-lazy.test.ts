/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RECHARTS STAYS OFF THE STATS CRITICAL PATH
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED 2026-08-25 on a production build, gzipped:
 *
 *   PlayerStatsPage chunk         39.4 KB
 *   recharts, eagerly imported   120.0 KB   (CartesianChart alone is 96.6 KB)
 *   -------------------------------------
 *   critical path               159.4 KB  ->  31.2 KB after this split
 *
 * Three quarters of what a Stats visitor downloaded was a charting library for
 * charts on the ANALYSIS tab, while the default tab is Overview. Someone
 * opening their stats to check a win rate paid for all of it.
 *
 * The regression is silent and one import away: adding `import { LineChart }
 * from 'recharts'` to PlayerStatsPage.tsx, or un-lazying any of the three chart
 * components, puts 120 KB back on first paint and nothing in the build output
 * complains. Hence a test.
 *
 * The three recharts consumers this page renders, all lazy:
 *   StatsCharts      the profit/daily/position charts (Analysis)
 *   EVLuckChart      EV vs actual (Performance, own profile only)
 *   BankrollTracker  bankroll over sessions (Analysis)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../src/pages/PlayerStatsPage.tsx');
const PAGE = readFileSync(PAGE_PATH, 'utf8');

/**
 * ONE LAZY CHUNK PER TAB (Stats Page Programme phase 2, 2026-09-04). The tab
 * markup moved out of the page into src/pages/stats/<Tab>Tab.tsx, each loaded
 * with lazy(); the per-panel lazies live inside the tab that draws them. So
 * the pins below read the page for what the page owns (the tab lazies, the
 * print preload, no static chart imports) and the WHOLE graph, page plus
 * tabs, for what used to be pinned on the page alone.
 */
const TAB_NAMES = [
  'RakeTab',
  'OverviewTab',
  'PerformanceTab',
  'PositionsTab',
  'HandsTab',
  'TrophiesTab',
  'TournamentsTab',
  'AnalysisTab',
] as const;
const TABS = TAB_NAMES.map((t) =>
  readFileSync(resolve(__dirname, `../src/pages/stats/${t}.tsx`), 'utf8')
);
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Page source with block and line comments stripped, so prose cannot satisfy a match. */
const PAGE_CODE = strip(PAGE);
/** The page and every tab chunk, comments stripped. */
const CODE = [PAGE_CODE, ...TABS.map(strip)].join('\n');

describe('PlayerStatsPage does not import recharts', () => {
  it('has no recharts import statement at all', () => {
    // The page renders charts only through the three lazy components below.
    expect(CODE).not.toMatch(/from\s+['"]recharts['"]/);
  });

  it('does not statically import any recharts consumer', () => {
    for (const c of ['StatsCharts', 'EVLuckChart', 'BankrollTracker']) {
      expect(CODE).not.toMatch(new RegExp(`^import\\s+${c}\\s+from`, 'm'));
    }
  });
});

describe('every tab is its own lazy chunk', () => {
  it.each(TAB_NAMES.map((t) => [t]))(
    '%s is loaded with lazy(() => import(...)) by the page',
    (tab) => {
      expect(PAGE_CODE).toMatch(
        new RegExp(`const ${tab}\\s*=\\s*lazy\\(\\(\\)\\s*=>\\s*import\\('./stats/${tab}'\\)`)
      );
      expect(PAGE_CODE).not.toMatch(new RegExp(`^import\\s+${tab}\\s+from`, 'm'));
    }
  );

  it('the page no longer carries any tab markup', () => {
    for (const marker of [
      '<StatRow',
      '<NemesisPanel',
      '<StatsCharts',
      '<TrophyRoom',
      '<HoleCardHeatmap',
    ]) {
      expect(PAGE_CODE).not.toContain(marker);
    }
  });
});

describe('all three chart components are lazy, and wrapped in Suspense', () => {
  it.each([['StatsCharts'], ['EVLuckChart'], ['BankrollTracker']])(
    '%s is loaded with lazy(() => import(...))',
    (component) => {
      expect(CODE).toMatch(
        new RegExp(`const ${component}\\s*=\\s*lazy\\(\\(\\)\\s*=>\\s*import\\(`)
      );
    }
  );

  it('imports lazy and Suspense from react', () => {
    expect(CODE).toMatch(/import \{[^}]*\blazy\b[^}]*\} from 'react'/);
    expect(CODE).toMatch(/import \{[^}]*\bSuspense\b[^}]*\} from 'react'/);
  });

  it('renders a Suspense boundary for each of the three', () => {
    // Without one, React throws "A component suspended while responding to
    // synchronous input" and the whole tab goes to the error boundary.
    expect((CODE.match(/<Suspense/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('off-tab work stays off the Overview critical path', () => {
  const OFF_TAB_COMPONENTS = [
    'PositionWinRates',
    'PositionalRadar',
    'HoleCardHeatmap',
    'NemesisPanel',
    'BenchmarkPanel',
    'TrophyRoom',
    'StatsShareCard',
    'SessionHistory',
    'AdvancedStatsSummary',
    'DownlineRakePanel',
  ];

  it.each(OFF_TAB_COMPONENTS)('%s is loaded with lazy(() => import(...))', (component) => {
    expect(CODE).not.toMatch(new RegExp(`^import\\s+${component}\\s+from`, 'm'));
    expect(CODE).toMatch(new RegExp(`const ${component}\\s*=\\s*lazy\\(\\(\\)\\s*=>\\s*import\\(`));
  });
});

describe('the extracted chart component owns the recharts dependency', () => {
  const CHARTS = readFileSync(
    resolve(__dirname, '../src/components/stats/StatsCharts.tsx'),
    'utf8'
  );

  it('is where recharts is imported instead', () => {
    expect(CHARTS).toMatch(/from 'recharts'/);
  });

  it('is presentational: it takes its data as props and fetches nothing', () => {
    // The memos stay on the page because the CSV exports read them too. If this
    // component starts fetching, the split stops being free.
    expect(CHARTS).not.toMatch(/supabase/);
    expect(CHARTS).not.toMatch(/useEffect/);
    expect(CHARTS).toMatch(/export default function StatsCharts\(/);
  });

  it('keeps the screen-reader summaries it was given', () => {
    // Added 2026-08-25: three SVGs with no text alternative closed the whole
    // "read your own results" workflow to a screen reader.
    for (const p of ['profitChartSummary', 'dailyChartSummary', 'positionChartSummary']) {
      expect(CHARTS).toContain(p);
    }
    expect((CHARTS.match(/className="sr-only"/g) ?? []).length).toBe(3);
  });
});

describe('the print dossier survives the lazy split', () => {
  it('awaits the three chart chunks before calling window.print', () => {
    /**
     * The whole point of the split is that these chunks are NOT loaded on the
     * default tab - so when the user presses "Print Or Save Dossier" they have
     * usually never been requested. The 1200ms budget was sized for a layout
     * pass, not a network round trip, so without this the PDF captured the
     * Suspense fallbacks: a "Charts" heading followed by "Loading Charts...".
     */
    expect(PAGE_CODE).toMatch(
      /await Promise\.all\(\[[\s\S]{0,700}StatsCharts[\s\S]{0,200}EVLuckChart[\s\S]{0,200}BankrollTracker/
    );
    // ... and, since phase 2, the tab chunks themselves, or the dossier prints
    // "Loading Section..." where a tab should be.
    for (const tab of TAB_NAMES) {
      expect(PAGE_CODE).toMatch(
        new RegExp(`await Promise\\.all\\(\\[[\\s\\S]{0,700}import\\('./stats/${tab}'\\)`)
      );
    }
    expect(PAGE_CODE).toMatch(/const printDossier = useCallback\(async \(\) =>/);
  });

  it('hands the charts `still` so recharts is not caught mid-draw', () => {
    // recharts animates its entrance over 1500ms; the print fires at 1200ms.
    expect(CODE).toMatch(/still=\{printing\}/);
  });

  it('has no beforeprint arm, which could never have worked', () => {
    // beforeprint is synchronous - a React state update scheduled inside it
    // cannot commit before pagination starts, and the lazy chunks now need a
    // network round trip a synchronous event cannot await.
    expect(CODE).not.toMatch(/addEventListener\('beforeprint'/);
  });
});

describe('the stats caches are reachable by sign-out', () => {
  it('keeps them in a leaf module, not in the page', () => {
    /**
     * clearUserCaches runs from the header. Importing PlayerStatsPage into it
     * would pull the whole Stats import graph into the sign-out chunk and undo
     * the lazy chart split entirely.
     */
    const PURGE = readFileSync(resolve(__dirname, '../src/utils/clearUserCaches.ts'), 'utf8');
    expect(PURGE).toMatch(/from '\.\.\/lib\/statsCache'/);
    expect(PURGE).not.toMatch(/from '\.\.\/pages\/PlayerStatsPage'/);
  });

  it('purges both the persisted payload and the in-memory memo', () => {
    const PURGE = readFileSync(resolve(__dirname, '../src/utils/clearUserCaches.ts'), 'utf8');
    expect(PURGE).toContain('STATS_CACHE_PREFIX');
    expect(PURGE).toMatch(/clearStatsRangeMemo\(\)/);
  });
});

describe('the stats RPC is asked for once per event, not five times', () => {
  it('uses ONE shared debounce window', () => {
    /**
     * ca_player_stats_full costs 2.6s warm and 15s cold against an 8s
     * statement_timeout. This used to be five independent subscribeDebounced
     * calls, and one completed hand emits HAND_COMPLETED, BALANCE_UPDATED and
     * CHIPS_DISTRIBUTED within milliseconds - three windows, three multi-second
     * scans of a 10GB table, per hand.
     */
    expect(CODE).not.toMatch(/subscribeDebounced/);
    expect(CODE).toMatch(/const REFRESH_EVENTS = \[/);
    expect(CODE).toMatch(/setTimeout\(\(\) => \{[\s\S]{0,200}loadRef\.current/);
  });

  it('replays through a ref, so a stale range cannot overwrite a newer one', () => {
    expect(CODE).toMatch(/loadRef\.current\?\.\(\{ fresh: true \}\)/);
  });

  it('lets a real change bypass the per-range memo', () => {
    // The memo makes the range pills instant; it must never make a bus event,
    // a tab return or an explicit retry serve a stale number.
    expect(CODE).toMatch(/clearStatsRangeMemo\(\)/);
    expect(CODE).toMatch(/useVisibilityRefresh\(\(\) => loadAllData\(\{ fresh: true \}\)\)/);
  });
});
