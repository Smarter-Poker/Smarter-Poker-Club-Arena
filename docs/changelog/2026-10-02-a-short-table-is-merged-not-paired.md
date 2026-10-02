# A short table is merged, not paired (2026-10-02)

Phase 2 of 9 (live game integrity): tournaments stuck one player per table.

## What was happening

At 20:00 UTC three running tournaments had their survivors spread one per table:

| Event                                     | Players | Tables |
| ----------------------------------------- | ------- | ------ |
| Midday Free Buy (NLH) (`b800c632`)        | 23      | 23     |
| Coffee Break Freeroll (PLO4) (`81775fa0`) | 14      | 14     |
| $100 Freeroll 12:00 PM (`4995e9aa`)       | 36      | 33     |

Most of Midday's tables had not dealt since 18:31 to 18:45. A table cannot deal to one player, so
those players sat waiting.

The breaks were not stuck. `tournament_seat_move_receipts` shows them landing: between 19:25 and
19:51, Midday's 13 breaks each moved one player onto another table that had one player. For
example, table `d9de7add` received a player at 19:44, 19:46 and 19:50. Each new pair played
heads-up until one player busted, which left a lone table again.

## Root cause

`TableBalancer.breakTable` sends a broken table's players to the least-full table that still has
a chair. That is right for a big break, where six players leaving should land evenly. It is wrong
for a short table: when every table holds one player, every other table is equally least full.

`checkTableBalance` (step 1) plans all of its breaks at once on one simulated board. So 23 lone
tables were planned into about a dozen heads-up pairs. The field then shrank only by players
busting, never by tables merging into a full one.

## What changed

`server/src/engine/TableBalancer.ts`:

- A source of `SHORT_TABLE_PLAYERS` (3) or fewer players now goes to the fullest table that still
  has a free chair. Ties go to the lower table id, so the plan is deterministic.
- A bigger break still spreads to the least-full tables, exactly as before.
- `shouldBreakTable` uses the same named threshold in place of a bare `3`.

Gap rebalancing (step 2) evens out the surviving tables once the breaks have landed. While a break
is pending, step 2 already skips every table it moves players to or from (`loadBalancerTables`), so
the two steps do not undo each other.

Planning the 23-lone-table board now gives tables of 9, 9 and 5.

Tests:

- `server/src/engine/aShortTableIsMergedNotPaired.law.test.ts`: the 23-table plan, the
  fullest-with-a-chair choice, the tie break, a short table's players staying together, and that a
  big break still spreads.
- `TableBalancer.reservedDestinations.test.ts`: its continuation fixture is updated to the new
  order. Its intent is unchanged: when the first usable table has only reserved chairs, the
  players continue to the next.

Every affected player was a horse (`profiles.is_horse`), and horses get exactly the same balancing
as humans (CLAUDE.md 10.5).

## Not changed here

Breaks are still worked about one per tournament admission. The 13 breaks Midday requested at
19:24 took 26 minutes to land. That throughput limit belongs to the elimination scheduler's work
budget (`visitTournamentBreakPage`, `SWEEP_WORK_BUDGET_MS`, one consolidation slot). This change
makes each break that lands build a full table instead of a heads-up pair, so the same number of
breaks now actually consolidates the field.
