# Stats Page Programme, Phase 2: one chunk per tab, dead code out, the coach in

Branch `fix/stats-phase-2-split`. Programme:
`docs/STATS-PAGE-PROGRAMME-2026-09-03.md` (section 8, phase 2; section 3).
Client-only; no database change.

## What shipped

### 1. `PlayerStatsPage.tsx` is split into one lazy chunk per tab

The page was 2,809 lines with all eight tabs inline. Each tab is now its own
module under `src/pages/stats/` (`RakeTab`, `OverviewTab`, `PerformanceTab`,
`PositionsTab`, `HandsTab`, `TrophiesTab`, `TournamentsTab`, `AnalysisTab`),
loaded with `lazy()` by the page. The page keeps what is the page's: the
data load, the range, the realtime subscription, the header and hero, the
tab strip, the print flow, and the gating conditions (`showTab`, `hasData`,
`isOwnProfile`), so `printing` can still override them for the dossier and
the owner-only privacy gates on Hands and Trophies stay on the page side of
the boundary.

The markup moved verbatim. The types, `RANGES`, `num`/`str`, `StatRow` and
the hand formatters moved beside the tabs (`types.ts`, `format.ts`,
`StatRow.tsx`) so a tab can type its props without importing the page. The
per-panel `lazy()` from the 2026-08-25 chart split lives on inside the tab
that draws each panel, and the print preload awaits the tab chunks as well,
or the dossier would print "Loading Section..." where a tab should be.

Measured on the production build: the page chunk is 40.6 KB and Overview
5.8 KB, so a default-tab visit downloads 46 KB against 55 KB before, with the
other seven tabs (28 KB) deferred until opened. The page is 1,941 lines.

### 2. Dead code out (programme section 3)

`PerformanceTrends`, `StakeLevelComparison`, `PlayerStyleRadar` and
`StatsExportButton` were exported from the barrel and rendered nowhere;
`PlayerStyleRadar` plotted six derived "personality" axes that no measured
stat backed. Deleted with their stylesheets. Their localStorage prefixes are
still reaped by `staleCacheReaper` so a player's storage is left clean.

### 3. The coach is wired in

`findLeaks` and `LeakPanel` were built, tested (261 lines of pins) and
exported on 2026-08-25, and then never rendered. The programme said delete
them with the other dead panels unless something reused them. Something
should: it is a pure function over the overall rates and the per-position
counts the page already holds, declares a minimum sample per rule, ranks by
cost and says the consequence rather than the statistic. `LeakPanel` now
heads the Analysis tab ("What To Work On"), fed straight from the page's
payload, with `still={printing}` for the dossier.

### 4. Inline section colours out

The ten `<h3 style={{ color: '#...' }}>` section titles (purple, amber,
green, blue) are plain `<h3>`; the colour is set once in the stylesheet.
The section header bar in phase 6 replaces the element.

### 5. Programme 1.2: the hand write, re-measured

Between 16:52 and 17:10 UTC, with the live stat trigger on every hand and the
money repair running every two minutes, the engine's `hand_history` insert
averaged **38.2 ms** over 1,938 hands (`pg_stat_statements` delta), against
57.6 ms before the trigger existed on 2026-09-03 and 267 ms during the first
repair pass. The trigger costs nothing visible; the 267 was the repair's IO
before the facts split. The repair itself has walked 2.02M hands and
changed 5,657 rows, is about 30 minutes from its ceiling, and unschedules
itself.

## Tests

- `tests/components/player-stats-page-renders.test.tsx` (+1): renders the
  page with a payload, clicks Analysis, and the lazily loaded tab shows "What
  To Work On" from that payload while the Overview markup is gone.
- `tests/stats-phase-2-one-chunk-per-tab.test.ts` (21): every tab exists and
  is lazy in the page; the page holds no tab markup and stays under 2,000
  lines; the gates stayed in the page; the shared pieces live once; the four
  dead panels are gone from disk, barrel and every import; the coach is
  wired; no inline `h3` colours remain.
- `tests/stats-charts-stay-lazy.test.ts` (37) and
  `tests/stats-money-exact-and-live.test.ts` (26): the source pins that read
  the page now read the tab that owns the markup, with the same intent.
- tsc clean, 929 test files, production build ok.

## Phase 1 engine cutover, confirmed here

Phase 1's engine half (`StatsHealthMonitor`) merged as `6ed5576cf` at 16:56
UTC, one minute after the 16:55 gate, so it rides the 17:55 gate. Verified in
the phase 2 verification pass (see the end of this file).
