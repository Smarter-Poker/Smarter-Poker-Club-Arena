# A rebuy is never seated on a table being broken

Fourth cause behind Dan's "276 entries and 9 rebuys" (2026-10-24), after the
45% share, the bounty place collision and the mystery pre-money refusal.

## Measured

- With the earlier fixes live (15:06-19:35 UTC), the largest remaining refusal
  of `process_tournament_rebuy` was `F06_SOURCE_EXCLUDED`: 192 (plus 60 that
  morning), ahead of late answers (112, fixed by #7911 at the next release).
- Every one is raised at `f06_source_guard` line 158 from
  `fn_ca_assign_tournament_player_seat_locked` line 231, a statement reached
  only when the seat came from `fn_ca_choose_tournament_seat_locked`, on a
  destination table with an F06 break in progress.
- Read live at 19:40 UTC: 3 tables were being broken, and in 2 of those 3
  events the breaking table was the one the chooser would pick.

## Root cause

The chooser seats at the table with the most free chairs. A table being broken
is the one whose players were just moved off, so it is usually the emptiest.
The guard refuses the write, the purchase rolls back, and every retry picks the
same table until the 30 second offer expires.

## Fix

Migration `20261024193700`: a table with an `f06_operations` row in any state
other than `acknowledged` / `withdrawn_before_manifest` (the `f06_one_source`
partial-index predicate) sorts last, before every existing key. It is a ranking,
not an exclusion: with no other legal chair the chooser behaves exactly as
before, so it can only remove refusals.

Proof: the live chooser was rebuilt md5-identical in a throwaway PostgreSQL.
Unpatched, all five scenarios chose the breaking table. Patched, it chose the
other table while a break was `park_requested` or `begun`, and was unchanged
for an acknowledged break, no break, or a full other table. The patched body
also compiled on production as a `pg_temp` copy in a self-aborting DO block.

## Damage already done

None to settle: each refused purchase rolled back whole.

Pinned by `tests/a-rebuy-is-never-seated-on-a-table-being-broken.law.test.ts`.

## Same PR: an authored 25/25 level can open a table

While reading the remaining rebuy refusals, `Tournament current blind level is
invalid` turned up 189 times in 24 hours: 180 late registrations and 9 rebuys.
The owner's October 20 Midway standard opens every scheduled event at 25/25
(220 events in a six-day window). `fn_ensure_late_registration_capacity`
refused `SB >= BB` before opening a new table, so in that opening level nothing
could be seated once the existing tables were full. The clause was written for a
degenerate clamped overflow level, which `fn_resolve_tournament_blinds` now
repairs itself. Migration `20261024194135` refuses `SB > BB` only. Tournament
tables are not subject to the cash-only blind rules in `tables_cash_needs_a_game`
or `fn_tables_creation_guard`, and the engine deals tournament tables from the
event's level. The patched body compiled on production as a `pg_temp` copy in a
self-aborting DO block. Pinned by
`tests/an-authored-equal-blind-level-can-open-a-table.law.test.ts`.
