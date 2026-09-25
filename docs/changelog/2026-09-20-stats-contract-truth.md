# 2026-09-20 - Stats contract truth: the page says what it measured, and what it could not read

Phase 2 of the Stats programme. Six demonstrated defects where the Player Stats
page stated something its data did not support. Each is fixed where it starts,
and each has a regression test that fails on the old code.

## Shipped

- **A failed rake read is no longer an empty ledger.** `StatsFactsService.getRakeStats`
  has returned `ScopedRead.error` since 2026-09-03, so a caller can tell "nothing
  is there" from "the database could not be asked". `PlayerStatsPage` never read
  it: a failure arrived as the zeroed fallback, its `.catch` stored `null`, and
  `RakeTab` rendered both as "Rake Ledger Empty / No Rake In This Window". The
  effect now reads the error, reports it as
  `PlayerStatsPage.rpc_ca_player_rake_stats`, and holds `rakeError`. `RakeTab`
  renders the page's own unavailable readout (`Readout Unavailable`,
  `Couldn't Load Your Rake`, `Try Again`), and the empty state now needs a read
  that succeeded. Try Again bumps a reload counter in the effect's dependencies,
  so it really refetches.
- **A failed agent-roles read no longer removes the Downline section.**
  `AgentRakeService.getMyAgentRoles()` returned `[]` both for "no roles" and for
  "could not read". It now returns `{ roles, error? }`. Its only caller is the
  Stats page, and the lossy form is gone rather than kept beside the new one.
  The page reports `PlayerStatsPage.rpc_fn_my_agent_roles` and keeps
  `agentRoles` as `null` (unknown), never `[]`. `RakeTab` keeps the Downline
  section on screen as `Couldn't Load Your Downline Rake` with its own Try Again.
  A failure never produces a role, and the tab never claims an empty ledger
  while the roles are unknown.
- **A rate over an empty sample now says Not Yet Measured.** A new pure helper,
  `ratioOrUnmeasured(value, sample, format)` in `src/pages/stats/format.ts` (with
  `NOT_YET_MEASURED`), prints the phrase when the denominator is empty or not
  finite and the formatted value otherwise. A real zero over a real sample still
  prints `0.00`. `num()` is unchanged. It is applied to:
  - BB/100 over cash hands (Overview, Performance and the hero tile, which also
    loses its green or red when unmeasured);
  - Showdown Win % over showdowns (Overview and Performance). The page's
    `showdownWinRate` used to be `'0'` with a `%` added by each tab. It is now
    display-ready: it includes the `%` or reads `Not Yet Measured`;
  - ITM % over entries and ROI over buy-ins (Tournaments). An unmeasured ROI gets
    the neutral slate colour instead of a winning green;
  - Aggression Factor over hands scored (Overview and Performance). This fix is
    partial; see below;
  - the hero hands-won gauge. `null` now means no hand was scored, and the gauge
    shows a neutral ring with `Not Yet Measured` instead of a red `0%`.
- **Grids that mix populations now label every row.** `StatRow` takes an
  optional `scope`, and every row on Overview and Performance is tagged `Cash`
  or `All Games`. The split comes from `ca_player_stats_full`, which
  `ca_player_stats_overview_v2` wraps. The money aggregates and bb/100 are
  `FILTER (WHERE is_cash)`. VPIP, PFR, 3-bet, fold to 3-bet, c-bet, WTSD, the
  showdown split, aggression factor, hands won and lost, and hours played count
  every scored hand, tournament hands included. A row whose label already names
  its population (Cash Hands, Tournament Hands, Cash Profit) is not tagged a
  second time. The tag reuses the existing `hero-stat-sub` caption class, and no
  CSS was added.
- **The hero hand count says when it is lifetime.** The tile prints
  `max(lifetime, analysed)`. When the all-time count is the larger, that is the
  number shown on a range-scoped page, so the label now reads `Lifetime Hands`
  (it was `Hands Played`). When the analysed count is the larger (the lifetime
  index is still catching up), the number is the window's figure and the label
  stays `Total Hands`.
- **Notable Hands says All Time.** `ca_player_hands_v2` takes no window
  argument, and the section header now carries an `All Time` caption.

## Tests

- `tests/unit/statsRatioOrUnmeasured.test.ts` covers the helper's contract and
  checks that the printed words are Title Case, ASCII and dash-free.
- `tests/components/stats-contract-truth.test.tsx` has tab-level render tests
  for Overview, Performance, Tournaments, Analysis (Notable Hands) and Rake. It
  derives the scope tags from the SQL of the most recent migration that creates
  `ca_player_stats_full`, so a tag that stops matching the SQL fails. Every
  Overview and Performance row has to be mapped to a payload field, so a new row
  cannot ship without a scope decision.
- `tests/components/player-stats-contract-truth.test.tsx` mounts the real page
  and drives:
  - rake and roles failures, both as a resolved error and as a throw;
  - the page-level `reportError` contexts;
  - Try Again refetch counts;
  - the honest empty ledger for a player with no roles;
  - the hero lifetime label in its three cases;
  - the hero gauge and BB/100 when no hands and when no cash hands have been
    scored.
- In `tests/components/player-stats-page-renders.test.tsx`, the
  `getMyAgentRoles` mock now returns the `{ roles }` shape, changed in the same
  commit as the contract.
- I checked the new tests against the old consumers, keeping the new helpers so
  that the imports resolve. 21 of the 32 fail, covering all six defects. The 11
  that pass are deliberate controls.

## Deliberately not changed

- **Aggression Factor is only partly fixed, and this is the one gap left
  open.** The SQL computes
  `CASE WHEN call_actions > 0 THEN aggro/call ELSE aggro_actions END`, and the
  payload does not include `call_actions`. The client can therefore only prove
  the empty sample of no hands scored. A player who has hands but no calls still
  sees the raw aggressive-action count printed as a ratio. The fix belongs in
  the SQL: return `NULL` there, or include `call_actions` in the payload. This
  PR changes no `ca_*` SQL, so it is left for the DB agent.
- `num()` in `src/pages/stats/types.ts` is unchanged because it has too many
  consumers. The RPC still writes 0 for an empty denominator, and the honesty
  fix happens at the display boundary.
- VPIP, PFR, WTSD, 3-bet, fold to 3-bet and c-bet over an empty sample are the
  same shape of problem but were not in this defect list. Their opportunity
  denominators are not in the payload, and the grids render only when the
  player has data. Left for a follow-up.
- Hero Cash Profit is a sum, not a rate. Zero profit over zero cash hands is a
  true sum.
- The stale-bundle branch of the rake effect (`getRakeStats` missing from the
  service) still falls back to the empty state, as the existing comment in that
  effect requires. It is a deploy artifact, not a failed read, and a retry
  cannot fix it.
- The service already reports the failures under its own context, so each one
  is now reported twice: once by the service and once by the page, under the
  page's context. The page report was specified, and HorseBugReporter
  fingerprints by context. It records that a player-facing surface fell back to
  its unavailable state.
- These areas belong to other agents and were not touched: CSS, art,
  migrations, `ca_*` SQL, and club scoping (`p_club_id`). The scope tags and the
  All Time caption use `hero-stat-sub`, so the visuals rebuild can restyle them
  in one place.
- `PlayerStatsPage.tsx` was not restructured. It is 1,989 lines, under the
  2,000-line ceiling pinned by `tests/stats-phase-2-one-chunk-per-tab.test.ts`,
  and the reasoning lives in the tabs, the helper and this file rather than in
  page comments.
- `ProfilePage`'s own showdown rate is on a different page and is not part of
  this programme.

## Verified on this exact candidate

- `node_modules/.bin/tsc --noEmit`: exit 0.
- The Stats vitest list from the brief plus the three new files: 15 files, 179
  tests, all pass. The list includes `classNamesResolve` and
  `discardedErrorReadRatchet`.
- `vitest related --run` on all nine changed source files: 27 files, 380 tests,
  all pass.
- Every test that reads these files as source text, which `related` cannot
  see, including the 2,000-line pin: 26 files, 646 tests, all pass.
- `check-title-case`, `check-painted-text-case`, `check-nav-title-case` and
  `check-ui-text` all pass.
- ESLint on the 13 touched files reports 0 errors and 0 warnings, and Prettier
  is clean.

## Not verified

- I did not view any of this on real hardware or in a browser. The scope tags
  and the gauge's `Not Yet Measured` caption at 375 and 393 px are reasoned from
  the stylesheet only: in `.row-label`'s flex row, a long label wraps onto two
  lines beside its tag rather than clipping. I have not seen it.
