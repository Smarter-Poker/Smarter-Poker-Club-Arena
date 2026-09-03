# The union earned nothing, and a debt was paid twice

**2026-09-02** - Midway Union economy, floor occupancy, multi-tabling caps.

Six production changes, four of them on money paths, plus two corrections to
claims made earlier in the same session.

## What was actually wrong

### 1. The seeder could not see the newest tables

`HorseFleetManager.seedAllTables()` read its open-table list with a bare
`.select()` - no ordering, no paging. PostgREST caps every response at
`db-max-rows` (1,000) and **does not error when it truncates**.

1,134 live non-tournament tables against a 1,000 cap: 134 invisible. Unordered
reads come back in physical order, which tracks insertion, so the truncated
tail is always the NEWEST tables - the worst possible ones to lose, because a
table nobody has sat at yet is exactly the one that needs seeding. All 45
Midway micro tables created that morning ranked 1090–1134 and not one was ever
offered a horse.

This is the same silent truncation fixed for the SEAT map on 2026-08-20, thirty
lines further down the same method, never applied to the query that feeds it.
The two fail in opposite directions, which is why the seat fix hid this one: a
truncated seat map makes an occupied seat read empty and fails LOUDLY
(~150,000 duplicate-key buy-ins a day), while a truncated table list makes a
table not exist at all and fails SILENTLY.

Fixed in PR #2655 (keyset-paged via `fetchAllRows`, fails closed).

### 2. Rake was earned by the table's owner, not the player's club

Every live Midway table is owned by the `Midway Union` club row, and
attribution followed `tables.club_id`. One hour of play credited **169.85 to
the union and 0.00 to either member club**, while 212 Club JAQK and 201 Shark
Club seats were live.

That removes the basis for the weekly 90% payback - there is nothing booked per
club to pay 90% _of_.

Two halves, and fixing one without the other would have looked fine and done
nothing:

- `atomic_distribute_rake` now stamps each attribution with the club of the
  SEAT, falling back to the table's club if no seat row exists (so the worst
  case is the status quo, never a NULL club on a money row).
- `fn_club_rake_rollup_day` - which builds the basis the 90% is 90% of -
  filtered on `rake_records.club_id`, the host. A rollup for JAQK matched zero
  rows and wrote a basis of zero. It now reads the corrected attributions.

Per-seat rather than re-owning tables, because one table seats players from
both clubs at once; rotating `tables.club_id` would credit one club for the
other's players on every mixed table.

Verified live, cutover at 17:13:29 UTC: union 0, JAQK 6.24, Shark 4.22, and
**31 of 31 hands reconcile exactly** against `rake_records`.

### 3. Four games means four

`atomic_table_buyin` allowed **6** concurrent cash seats while the engine's
seat picker and the client both capped at 4. The engine's filter is explicitly
advisory - computed from an in-memory map, raceable across seeding cycles - so
the database was the only cap that holds, and it was set two higher than the
rule it was backstopping. Now 4. Checked first: the busiest player held 2.

### 4. One shortfall, paid twice

Three repair paths make a short-paid player whole, and each builds its
idempotency key out of its OWN name:

```
tourney:<tid>:overlay_backpay:<uid>
tourney:<tid>:prize:<uid>:<place>:reconcile
```

Same debt, two names, so `uq_tournament_payouts_idempotency_key` cannot
collapse them and both pay. Over seven days: 57 completed events paid out more
prize money than their pool, **3,808.52 chips**, 56 obligations provably this
pattern.

`fn_tournament_double_paid_obligations` + a `FeeReconciler` audit now name the
tournament, place, player and the two paths. It reports and never repairs, and
deliberately does not block - a guard that can refuse a payout can strand a
player who is genuinely owed money (CLAUDE.md 11.5). PR #2686.

### 5. The weekly cycle would have reached backwards

`fn_union_weekly_rakeback_close_all` takes no period. It reads
`MAX(period_end)` from `union_rakeback_log` as a resume cursor - 2026-08-17 -
and walks forward closing every week to date. The first run would have closed
08-17 and 08-24 on the old all-to-the-union basis.

Dan: _"start clean with the first week."_ Attribution became correct at
2026-09-02 17:13 UTC, weeks run Monday to Monday, so the first fully clean week
is 2026-09-07. `union_settlement_floor` now holds that as DATA, and both the
resume cursor and a direct single-week call are guarded. Cursor verified moving
08-17 → 09-07.

## Two things this session got wrong and corrected

**Reading `ca_hand_facts` as a hand ledger.** The handoff that opened this
session concluded the entire cash engine was dead because that table was empty
for the Midway floor. It is a **per-user hole-card privacy table covering
humans only** - 6 rows for 6 human cash hands in 24 hours, a perfect 1:1 -
while `hand_history` recorded **2,382 hands in one hour** on that floor alone.
The engine had been dealing the whole time. Use `hand_history`.

**Blaming the prize audit for ignoring `bounty_pool`.** Arithmetic suggested
every bounty event's "excess" was just its bounty pool. It was not: bounty
credits `wallet_transactions.category = 'bounty'`, which the prize audit never
counts, and on the worst offender bounty reconciled exactly (1,020.00 against a
1,020.00 pool). The excess is genuinely in the prize category, and the real
cause is item 4 above.

## Left deliberately untouched

**Settlement is frozen.** Three `GLOBAL_SETTLEMENT_FREEZE` locks, one per club,
set 2026-08-26 13:38 UTC, reason _"EMERGENCY: PROFIT DRIFT INVESTIGATION"_,
`unlock_at` 2099-01-01. Still active. They are the reason the weekly cycle
stopped, not a missing scheduler, and they are doing their job - the drift they
were raised for was still firing today. Unfreezing is Dan's call.

Also his: whether the 3,808.52 chips of over-payment are clawed back, the
`union_club_terms` risk figures (deposit, stop-loss, stakes cap), and whether
the cash floor shrinks toward ~110 tables or the horse roster grows past 1,000.
1,134 live cash tables against roughly 365 cash-capable horses cannot reach the
75%-running target by any scheduling change; that is arithmetic.

## Also verified, not changed

`pendingRaisePlan` in `HorseLogic` is module-level state shared by every table,
and with horses on four games at once it was worth settling. It **cannot** leak:
the assignment sits at the top level of `decidePostflop` so it dominates every
postflop chip-in call, and both consume sites are guarded on
`gs.stage !== 'preflop'` while `decide()` routes preflop on exactly that. Pinned
by a mutation-verified test (PR #2667) rather than rewritten. Worth noting the
in-code comment justifying it is wrong - it cites the reason `difficultyHint`
is safe, which is a different reason.
