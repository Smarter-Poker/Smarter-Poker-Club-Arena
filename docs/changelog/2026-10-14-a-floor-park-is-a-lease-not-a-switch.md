# A floor park is a lease, not a switch

## What players saw

From 2026-10-13 13:15Z to 2026-10-14 23:03Z nobody could sit at any Midway Union cash table, and no tournament could be created for Club JAQK, Deep Stack Society, SHARK CLUB or Midway Union. The Diamond Arena kept dealing to the players already seated, but every new seat on the scoped floor was refused with `OPERATOR_FLOOR_PARKED` (32,202 refused `atomic_table_buyin` calls and 2,316 refused tournament inserts in the three hours before the resume alone).

## Root cause

`fn_ca_launch_operator_command(... 'park' ...)` wrote the single row of `ca_operator_floor_hold` (operation `a970faa8`, reason "Owner Authorized Scoped Launch Accounting Reset") at 13:15:28Z, `close_cash` closed 74 cash tables under it, and the accounting reset the park was taken for never ran (every `ca_launch_reset_*` table held zero rows 34 hours later). Nobody issued the `resume`. The hold row had no timestamp, no deadline and no monitor, so a program that parked the floor and died left it parked for ever, and not one alert fired.

## Fix

Resumed by hand at 23:03:41Z as the hold's own actor through the engine's service authority (`fn_ca_launch_operator_command(... 'resume' ..., p_owned_park => a970faa8)`, operation `523a2e84`): 74 resume receipts written, hold removed, 271 seats taken on 69 Midway tables and 43 tournaments created in the next two minutes.

## Hardening (migration 20261014231111)

- `ca_operator_floor_hold` carries `held_since` and `expires_at`; a trigger stamps a 60-minute lease on every park or pause without touching the pinned command functions.
- `fn_ca_operator_floor_hold_renew(actor, operation, reason)` lets the owning operation extend the lease, as `service_role` only, audited.
- `fn_ca_operator_floor_hold_watchdog()` runs every minute (`ca-operator-floor-hold-watchdog-1m`): a hold older than 10 minutes raises one critical `financial_alerts` row; a hold past its lease is released exactly as the owner's own resume would release it (scope row, resume command, receipts for every closed table), recorded in `ca_operator_floor_hold_releases`; a close the engine finishes after the release gets its receipt on the next tick; the alert resolves when nothing is refused any more.
- Qualified by `scripts/ci/test_operator_floor_hold_watchdog.py` against the exact production floor owners on a local PostgreSQL (`LC_ALL=C python3 -B scripts/ci/test_operator_floor_hold_watchdog.py --pgbin <pg bin> --scratch <dir>`; passed on the owner's Mac against PostgreSQL 17.11 on 2026-10-14 23:26Z). It is not wired into `ci.yml`, because that file and `classify-ci-changes.mjs` are hash-pinned inputs of the cash qualification manifests and moving them is another owner's reviewed change.

A program that needs the floor parked longer than an hour must now say so every hour. Silence means it is gone, and the floor comes back on its own.

## Still open, named here

Tournament `a38b88a9` (100 Chip Guarantee Freeroll, 2026-10-13 06:00 AM, 58 players) stays dark: its eight retained original hands failed their successor handoff on 2026-10-13 with `record "new" has no field "metadata"` (the scoped launch trigger defect repaired by 20261013133012) and spent their one-time claim. They are not among the 209 retained originals covered by 20261013163547 and need the same exact source-correction installation; `fn_ca_tournament_dark_while_running` has paged it since 13:38Z.
