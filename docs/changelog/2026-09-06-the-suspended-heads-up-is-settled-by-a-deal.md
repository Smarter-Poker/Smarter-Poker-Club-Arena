# The suspended heads-up is settled by a chip-proportional deal (2026-09-06)

CLAUDE.md 10.9. One paragraph, then the record.

**PLO4 Heads-Up 25 (3e281f5c, JAQK, 23.75 + 1.25, pool 71.25)** took three
entrants into a heads-up format on 2026-09-03, dealt 37 hands, busted
f44d72f2 at 14:20 UTC (recorded as second, which for three entrants is
wrong), and was flipped to COMPLETING with two players still holding chips:
2e26ae7c with 2,000 and 00000000-...-0028 with 1,000 of the 3,000 in play.
No hand since, nothing paid, three days. The platform's own recovery refuses
that shape by design ("still being PLAYED when its engine died ... left in
COMPLETING for a live engine to resume or an operator to settle"). A revive
to RUNNING at 15:25 UTC today was not adopted by the running engine in
twenty minutes, and the boot-time stale sweep would have returned it to
COMPLETING at the next cutover. A suspended two-handed match is settled by
chip proportion, which for two players is the ICM figure and what
`fn_final_table_deal` computes: **2e26ae7c 47.50 (first), 00000000-...-0028
23.75 (second), f44d72f2 corrected to third with nothing.** Both survivors
are horses and were paid exactly as people would be (10.5). The rake of 3.75
was settled through `fn_settle_tournament_rake` and the event closed
COMPLETING -> COMPLETED with the engine's own guarded statement.

## The path (all five of 10.9)

1. **Read.** Chips 2,000 / 1,000 / 0, pool 71.25, `chip_ledger` holding three
   entries and no prize or rake, no `tournament_payouts` row. Asserted in the
   migration; it aborts if any of that moved.
2. **Paid once.** Two approved `ca_manual_adjustments` rows from
   `fn_ca_adjustment_under_10_9` (Phase 6.1's door for an agent), each naming
   this migration and the paragraph; `fn_settle_tournament_obligation` under
   kind `final_table_deal` with the adjustment id; `tournament_payouts` rows
   with source `final_table_deal` so the reconciler treats the event as
   chopped and never pays the structure on top.
3. **Nothing taken back.** The three entries stay where they were.
4. **Probed rolled back first** (psql, `BEGIN ... ROLLBACK`, 15:41 UTC): the
   ledger showed exactly 47.50 + 23.75 to the two players and 3.75 rake, the
   roster 1 / 2 / 3, zero live seats, status COMPLETED; after ROLLBACK the
   wallets read what they read before. Applied 15:41:36 UTC and recorded as
   `20260906153943`.
5. **The paragraph** is above, and is the `reason` on both adjustment rows.

`financial_alerts` carries a resolved `info` row naming the migration and
both adjustment ids.

## Why `fn_final_table_deal` was not used

It requires `final_table_deal_enabled`, which `fn_guard_managed_game_lifecycle`
refuses to change after a player has registered, and it only writes the
record - the engine settles the rows, and this event has no engine. The
numbers are the ones it would have produced.

## Also closed by hand, same hour

Five events paid their winners and settled rake, then deadlocked on the
COMPLETING -> COMPLETED update and were never recovered (see
`2026-09-06-a-finish-that-deadlocks-is-retried.md`): b88db8d6, 80fdff30,
db05ecf2, ab102e3d, 40102ace. Flipped with the engine's own guarded
statement; no chips moved. COMPLETING count at 15:43 UTC: 0.
