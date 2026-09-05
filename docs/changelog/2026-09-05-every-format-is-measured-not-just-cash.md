# 2026-09-05: every format is measured, not just cash

Dan: "you need to fix the real time connection to the spins, heads up and
mtt's as well. not just the cash game tables."

## What was already true

Spins, SNGs, heads-up and MTTs share ONE `ServerTableEngine` hierarchy and
ONE table socket with cash. Every phase of the realtime programme reaches
them by construction. Two format-specific paths were verified live:

- **Table-balancing moves work.** `seat_moved` carries `to_table_id` on the
  old table's socket and `TablePage` follows it (`case 'SEAT_MOVED'`). I
  searched for the lower-case name first, found nothing, and nearly reported
  a false gap - it is upper-cased before the switch.
- **`TOURNAMENT_EVENT` is dead.** Emitted only by an internal-key route whose
  sole caller is a browser method sending a player JWT, which that route
  always rejects. `JOIN_TOURNAMENT` subscribes to a channel that never
  delivers. Queued for Phase 2, not fixed here.

## What was missing

The latency instrument carried only `audience=human|horse`, so a Spin, a
heads-up SNG, an MTT final table and a cash table were one number. Nobody
could ask whether Spins were slow.

## What changed

`poker_act_to_broadcast_ms` and `poker_actions_fleet_total` now carry
`format=cash|spin|hu_sng|mtt`, at all three observation sites (human HTTP
path, horse path, latency observation). Derived by `tableFormat()` from the
existing `TournamentBrainContext` - synchronous, cached, already warmed for
every tournament table the engine owns, so it is safe on the broadcast path.
Heads-up is derived from seats at one table, not a type string.

A tournament whose context has not loaded reports `mtt`, never `cash` -
falling back to cash would file Spins and MTTs under cash and hide the exact
thing the label exists to show.

`ActionLatencyDegraded` and `ActionLatencyCritical` now group by `format` and
name it in the summary, so a slow Spin alerts on its own p95 instead of
disappearing into a cash average. Four values, eight series with audience,
still never a `table_id`. promtool-clean against the live Prometheus.

Law: `theTableFeelIsMeasured` gains LAW 5 - the label at every site, the
no-cash-fallback rule, the real derivation separating spin / hu_sng / mtt,
and the alerts grouping by format.
