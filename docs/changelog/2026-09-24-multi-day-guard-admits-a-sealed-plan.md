# Multi-Day Release R6: The Unbuilt Guard Admits A Sealed Plan

Assignment CA-PRODUCT-COMPLETION-2026-09-22, R6 lane. Design:
`docs/handoffs/club-arena-product-completion/MULTI-DAY-DESIGN.md` sections 2
(exact changes for Option A), 3, 9 (R6) and 11.

## What changed

Migration `supabase/migrations/20260924232849_multi_day_guard_admits_a_sealed_plan.sql`
(one transaction, `SET LOCAL lock_timeout = '5s'`, no table, trigger, column
or grant added):

- **`fn_tournaments_refuse_unbuilt_multi_day` is replaced; its trigger is not.**
  `trg_tournaments_refuse_unbuilt_multi_day` keeps its seven columns (the
  install checks them and refuses if they differ).
  - The five structure columns (`day_number > 1`, `parent_tournament_id`,
    `survivors_advance_to`, `flight_number`, `flight_end_chips_snapshot`) stay
    refused unconditionally (`MULTI_DAY_STRUCTURE_COLUMN_REFUSED`, 0A000).
    Option A runs every day on one row, so nothing ever writes them.
  - `is_multi_day` / `total_days` are admitted only when the row has a sealed
    `tournament_stage_plans` row, `total_days` equals its `stage_count` with
    `is_multi_day` true, and `fn_capability_available(plan.capability_id)` is
    true. A row with a sealed plan may carry no other badge value, and a row
    without one keeps `(false, 1)` (`MULTI_DAY_BADGE_REFUSED (<reason>)`, 0A000,
    reasons `no_sealed_plan`, `badge_differs_from_plan`,
    `capability_unavailable`).
  - The function becomes `SECURITY DEFINER` with
    `search_path = pg_catalog, public, pg_temp` (like the R3 doors), because it
    now reads the service-role-only plan table and asks
    `fn_capability_available`, which anon cannot execute, for whichever role
    writes a tournament. It returns `trigger`, so it is not callable as an RPC
    and needs no definer allowlist entry.
- **The seal writes the badge.** `fn_seal_tournament_stage_plan` (the one
  service-role seal; the operator door `fn_operator_seal_stage_plan` delegates
  to it and keeps no second copy of any rule) now sets
  `is_multi_day = true, total_days = <stage count>` in the same transaction
  as the plan, after the plan, the stages and the seal receipt. It is edited
  by exact text replacement at one anchor; every refusal, the capability gate,
  the replay (which writes nothing) and the grants are unchanged. The existing
  contract capture trigger records the badge as a new contract revision, which
  is the honest lobby promise.
- **`fn_uncollected_entry_check`**: only its description (`COMMENT ON
FUNCTION`) now says the later-day exemption is unreachable by design. The
  in-body note ("Delete this note in that commit; the exemption becomes live")
  sits inside `prosrc` of a money check and was left unchanged; it is now
  stale in its last sentence only.

## Why

Until R6 the old guard refused every multi-day column, so no event could be
badged even with a sealed plan. The design keeps the structure columns
refused for ever and lets the badge through only as the exact image of a
sealed plan whose capability is available.

## Install order and preimages

Install after `20260924025555`, `20260924043217`, `043224`, `043232`,
`043239` and `20260924063656` (all live). Never at :50 to :03 UTC.

Before installing, confirm the live sources:

```sql
SELECT p.proname, md5(p.prosrc) FROM pg_proc p
 WHERE p.oid IN ('public.fn_tournaments_refuse_unbuilt_multi_day()'::regprocedure,
                 'public.fn_seal_tournament_stage_plan(uuid,jsonb)'::regprocedure);
SELECT count(*) FROM public.tournament_stage_plans;   -- must be 0
```

| Function                                  | pre `md5(prosrc)`                  | post `md5(prosrc)`                 |
| ----------------------------------------- | ---------------------------------- | ---------------------------------- |
| `fn_tournaments_refuse_unbuilt_multi_day` | `428b31045fc54a32e6207a6c15200cf5` | `e6d43459c396f7e2b9ad4103d8a0ab21` |
| `fn_seal_tournament_stage_plan`           | `7d41b8e3b192cf4d9ec4f13ed34a72f1` | `6c562ca24eb23ee3a9c1b8b00c1e3983` |

The guard's pre md5 equals the `source_md5` captured from production in
`scripts/ci/fixtures/satellite-qualifiers/current-terminal-triggers-20260917.json`
(its `pg_get_functiondef` md5 there is `c52fa39e800b18f319a8171cb52ab637`,
because production carries a later `search_path` setting; that is why the pin
is on `prosrc`). The migration refuses with `MULTI_DAY_R6_SOURCE_DRIFT`,
`MULTI_DAY_R6_TRIGGER_DRIFT` or `MULTI_DAY_R6_PLAN_SEALED_BEFORE_THE_BADGE`
and changes nothing if production differs or a plan was sealed before R6.

Still inert: `tournament.multi_day.single_flight` is `planned`, so the seal
refuses before the badge write and the guard admits no badge until the owner
moves the capability to deployed.

## Evidence

`scripts/ci/test-multi-day-guard-r6.py` (12 cases, real PostgreSQL, imports
the foundation and stage view harnesses and carries the production money-RPC
registry guard): before R6 the badge write is refused and the seal writes no
badge; R6 refuses a pre-R6 plan, guard drift, seal drift and trigger drift,
changing nothing; after R6 a badge without a plan is refused (update and
insert), a different day count is refused, a withdrawn capability is refused,
the exact plan badge is admitted, the structure columns are refused with and
without a plan; the seal (service role, two days) and the operator door
(three days) write the badge in the plan's own transaction (row `xmin` equals
the plan's `transaction_id`), and replay writes nothing; the full two-day run
(bag, reschedule, resume, 55,000 chips conserved) passes with R6 installed.
CI step beside the foundation and stage view steps; `ci.yml` repinned in
`scripts/qualification/cash-native-hosted.manifest.json`
(`multiDayGuardR6Integration`).

## Pending

- Installation by the owner, after the preimage confirmation above.
- Client: `DetailOverviewTab` prints `Day {day_number} of {total_days}`, and
  `day_number` stays 1 by design, so a badged event on Day 2 would read
  "Day 1 of 2". The day shown must come from `fn_tournament_stage_view`.
- The client's creation payload still never sends the badge
  (`tournamentFromTableConfig.ts`, `TableConfigPage.tsx`); that stays right,
  but their comments saying "delete these lines when Day 2 is built" are now
  stale. The restart-every copy in `ScheduledTournamentService` copies
  `is_multi_day`/`total_days` into a new row, which the guard refuses (no plan),
  so a multi-day event cannot use restart-every until the seal accounts for it.
