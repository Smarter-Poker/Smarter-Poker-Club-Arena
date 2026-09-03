# 2026-09-03 — Player Stats page: the money is exact and the numbers are live

Branch `fix/stats-page-full-audit`. Full audit of `/hub/club-arena/stats`, every
tab and every panel, run as a live E2E against production data with the SQL
probed inside rolled-back transactions before anything was applied.

## What was wrong, measured

Screenshot account (`kingfish`, 1,353 lifetime hands, 750 analysed):

| Readout                        | Page showed                  | Truth                                            | Why                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cash Profit                    | **-22,526.91**               | -1,328.54 (engine settlement, 484 matched hands) | `ca_hand_player_facts` summed `actions[].amount` as increments. bet/raise/all_in are raise-TO levels; the `return` verb was never subtracted. One hand read -9,752 where the engine paid +149 (all-in 10,000, 9,851 returned). |
| BB/100                         | -645.55                      | about -175                                       | same arithmetic                                                                                                                                                                                                                |
| Worst Losses                   | -71,330 (a freeroll)         | cash hands only                                  | `ca_player_hands` ranked tournament chips with the same broken sum                                                                                                                                                             |
| Hands Played                   | 1,353, last hand Sep 2 07:06 | 17 h stale, falling behind                       | `ca_refresh_hand_player_index` capped itself at 3,000 hands/run = 12k/h against 28,191 hands/h intake                                                                                                                          |
| "Snapshot" through 1:15 PM     | 15-minute cron               | not live                                         | the live tail was removed 2026-08-31 because it was unbounded                                                                                                                                                                  |
| Tournaments tab under "7 Days" | lifetime entries/ROI         | windowed                                         | block ignored `p_days`                                                                                                                                                                                                         |

## What shipped

**Database** (`supabase/migrations/20260903190000_stats_page_money_is_exact_and_live.sql`,
applied to production 19:27 UTC and recorded in `schema_migrations`):

1. `ca_hand_player_facts` reconstructs money with the engine's semantics
   (street-committed differencing, `return` subtracted, blind posts/antes/
   straddles read from the log, blinds seeded from position for pre-2026-08-27
   rows, uncalled bets inferred for logs that predate recorded returns with
   `pot_size` arbitrating, exactly as `src/utils/handReplay.ts`). Probe on the
   screenshot account: 469/484 hands within one blind of exact settlement; the
   15 remaining are hands whose stored `button_seat` disagrees with the action
   order. Non-money columns bit-identical to the stored rows (1,000/1,000).
2. **Live.** `trg_ca_stats_live_from_hand` AFTER INSERT on `hand_history` writes
   the `ca_hand_player_idx` and `ca_hand_player_stat` rows for that hand in the
   same transaction. It never raises. Verified after apply: last hand
   19:28:39.577, last stat row 19:28:39.577, last idx row 19:28:39.577.
3. `ca_player_stats_full` drops the rollup ceiling, overlays `ca_hand_facts`
   (engine-written, cent-exact) per hand where a row exists, reports
   `exact_cash_hands`, adds `three_bet_opps` per position, windows the
   tournament block. `ca_player_stats_overview_v2` now MEASURES
   `cash_money_source` (exact / mixed / reconstructed) and sets
   `live_tail_included: true`.
4. `ca_player_hands` ranks by the same money; biggest modes are cash only.
5. `ca_refresh_hand_player_index` loops in 3,000-hand chunks under a 90 s
   budget (measured 475 hands/s, so ~40k per cron run; the 480k backlog clears
   in ~3 hours, and the trigger keeps it current after that).
6. `ca_roll_hand_stats_forward` prunes by who has rows in the window (its
   `RETURNING user_id` prune keyed on rows it inserted, which is now nobody).
7. `ca_repair_hand_player_stat_money` recomputes existing rows in bounded
   batches; pg_cron `ca-stats-money-repair` every 3 minutes, self-unschedules
   when done. Hands already past the 7-day horse retention are skipped.
8. `ca_hand_player_idx` joins the realtime publication with an owner-only
   SELECT policy so the page can hear its own hands from any tab.

Result for the screenshot account after apply: Cash Profit **-2,393.47**,
source `mixed` (351 of 353 cash hands exact; the two remaining rows repair in
the cron pass), `live_tail_included: true`.

**Frontend** (`src/pages/PlayerStatsPage.tsx` and `src/components/stats/*`):

- Realtime subscription on `ca_hand_player_idx` INSERTs for the signed-in
  player, feeding the existing single debouncer.
- Money-source notice says how many hands are exact instead of a blanket
  warning; status pill reads Live.
- `PanelBoundary` resets on range/user change and offers Try Again.
- `StatsFactsService` payloads carry `error` on a failed read; EVLuckChart,
  NemesisPanel, HoleCardHeatmap, BenchmarkPanel render a retryable error state
  instead of "not gathered yet".
- EVLuckChart's band is the space between the two lines, green above / red
  below per point (it filled from y=0 to the gap value, one colour from the
  final sign).
- PositionWinRates, SessionHistory, BankrollTracker, AdvancedStatsSummary are
  pure presentation over the page's range-scoped payload: their dead lifetime
  fetches, localStorage caches, bus listeners and second range selectors are
  gone. PositionWinRates no longer drops LJ/HJ, labels 3-bet per opportunity,
  and stops painting a wall of "Leak" zeros before data arrives. Bankroll
  counts sessions, not "days", inside the window only. Session amounts are
  chips, not dollars.
- PositionalRadar plots 3-bet per opportunity against its per-opportunity
  reference; SVG/table rows are keyboard-activatable.
- TrophyRoom reads the all-time payload (fetched lazily through the same memo
  when the range is not All) and the lifetime index count; the three "over N
  hands" trophies gated on the 750-hand window and could never unlock.
- StatsShareCard draws the window it covers on the card.
- Intelligence brief's trend item honours the window and says which days.
- Notable hands labels say Cash; empty state says tournament chips are not
  ranked.
- DownlineRakePanel footer describes weighted attribution (it said "split
  evenly", the retired method), guards a NaN commission rate, labels the
  unfiltered summary while a search is active, warns at the 500-row cap.
- PlayerStatisticsPage (club member view) separates a failed read from "Member
  Not Found" and offers Try Again.
- CSS: `stats-section-loading` and the loading deck classes defined; print
  hides only loading fallbacks (the `.hand-empty` explanations print); hero
  sub-labels stay visible on phones; recharts axes print dark.

## Tests

`tests/stats-money-exact-and-live.test.ts` pins every load-bearing part above.
`tests/components/stats-panels-render.test.tsx` mock updated for the
`{ rows, error? }` distribution shape; `tests/stats-v2-foundation.test.ts` pins
the measured-source notice wording.

## Still open (not in this PR)

- Position derivation trusts `hand_history.button_seat`; ~3% of hands have a
  button that disagrees with the action order, so seat labels and the
  position-implied blind are wrong on those. Exact settlement covers the money;
  the label is a separate fix.
- `PerformanceTrends`, `StakeLevelComparison`, `PlayerStyleRadar`, `LeakPanel`,
  `StatsExportButton` are exported and rendered nowhere; PlayerStyleRadar's
  axes are fabricated. Left untouched here (deleting them touches an
  identity-vault test and the barrel); they should go.
- The hand write's `pg_stat_statements` mean was 57.6 ms before the trigger;
  re-measure after an hour.
