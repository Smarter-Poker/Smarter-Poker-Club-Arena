# 2026-09-20 - Stats cinematic surfaces recovered onto current main

## Shipped

- The two substantive commits from the stale branch
  `agent/codex-stats-console-v3/fix/stats-club-arena-console` (PR #4518,
  376 commits behind main) were cherry-picked onto a fresh worktree cut from
  `origin/main` at `57768b69`. The only file main had also moved was
  `src/pages/PlayerStatsPage.tsx`; the auto-merge was clean and every newer
  main behaviour (retryFetch, pulse, cache labels, agent rake roles) survived.
- Primitive decorative glyphs (`$`, `!`, `○`, `♠`, `▲`, `▼`, `✓`, `✗`, arrows)
  are gone from every active Stats surface. Empty and error states now print a
  semantic status line (`Awaiting Hand Ledger`, `Rake Ledger Empty`,
  `Readout Unavailable`, `Private Data Boundary`) instead of a glyph.
- Nested panels were given distinct frame treatments (brass ledger for
  benchmarks, split red/green rivalry for nemesis, red diagnostic docket for
  leaks, blue analytical grid for hole cards, violet instrument for EV/Luck,
  brass achievement ledger for trophies). Generic `backdrop-filter` blur,
  `999px` pills and large soft radii were removed from the Stats stylesheets.
- `StatsShareCard` draws a chamfered rail with an etched grid via
  `chamferRect`; the rounded-rectangle helper is gone.
- A dead `icon` prop on `components/stats/StatCard` and retired
  `motion`/`useReducedMotion` imports in `PositionalRadar` were removed.
- `tests/stats-visual-authority.test.ts` pins all of the above: the two
  approved master images exist, exceed a minimum size and differ from each
  other; active Stats TSX carries no primitive glyphs or icon classes; Stats
  CSS carries no `backdrop-filter`, no `999px` pills and no large generic
  radii; the share graphic uses chamfered geometry.

## Verified on this exact candidate

- `tsc --noEmit` clean; ESLint clean on every touched file.
- `check-title-case`, `check-painted-text-case`, `check-nav-title-case`,
  `check-ui-text` all pass.
- `find-generic-surfaces.mjs`: PlayerStatsPage, PlayerStatisticsPage,
  BenchmarkPanel, NemesisPanel, LeakPanel, StatsShareCard all score 0.
- 11 Stats test files green (visual authority, experience contract, casino
  realism pages, page render, panel render, statsContract, v2 foundation,
  phase 3 live-and-exact, money exact-and-live, rollup contract, cinematic
  route families).
- `npm run build` succeeds (PlayerStatsPage chunk 42 KB, share card 5.5 KB).
- Rendered before/after at 393 px and 1280 px through the console skill
  harness for Overview, Performance, Positions, Analysis, Trophies, Rake
  (empty), Benchmark, Nemesis, share card and the empty state.

## Deliberately not changed

- `PlayerStatsPage` and `PlayerStatisticsPage` stay in the cinematic route
  family (`images/stats/`, `--realism-*`, `RewardsSurfaceHeader`). They are an
  approved exception to the SpadeConsole chassis and were not flattened onto it.
- Per-club scoping is untouched here. The `historical_club_breakdown_available`
  flag is still hard-coded `false` in `ca_player_stats_overview_v2`, and the
  "Owner-Only All-Clubs Total" notice still prints. The reason is structural:
  `ca_hand_player_stat` and `ca_hand_player_idx` carry no `club_id` because
  projection 4 of `fn_project_hand_side_effects_after_post_commit_20260908`
  discards `v_club`, even though `ca_hand_facts` and `ca_hand_transfers`
  already carry it. That is the next phase's migration, not a CSS change.
- The Overview and Performance tile stacks are visually the same composition
  as before; this delivery is the foundation, not the cinematic rebuild.
- `components/table/MiniStatsCard` (scanner score 18, zero importers) is not a
  Stats surface and was not touched to move a global score.
- PR #4518 is superseded by this branch and will be closed with a pointer here.
