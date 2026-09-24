# 2026-09-24 - kill pot table settings: the database refuses what the engine cannot honour

## What changed

- `supabase/migrations/20260924034010_kill_pot_table_settings.sql` adds
  `tables.kill_mode` (`off`, `half`, `full`, default `off`), `tables.kill_threshold_bb`
  (8, 10, 12 or 15, default 10) and `hand_history.kill_pot`. It also adds
  `zz_tables_kill_pot_guard`, which refuses (22023) any kill setting the engine cannot
  honour: a tournament table, a variant other than flh or flo8, bomb pots on, or a big
  blind that is not exact in minor units. When the kill is being turned on, it also
  refuses while `fn_capability_available('cash.fixed_limit.kill_pots')` is false. A
  row with kill `off` never runs the check.
- `fn_set_cash_game_kill_settings(game, mode, threshold)` is the owner door. It writes
  the setting into the cash game's ruleset snapshot and applies it through
  `fn_cash_apply_ruleset`, so every table of the game plays the same rules. It is
  audited in `table_settings_changes` and `cash_cluster_events`.
  `fn_cash_cluster_open_table` and `fn_cash_apply_ruleset` are extended by anchored
  replacement, each pinned by md5 first.
- Columns are added as metadata only and the CHECKs are NOT VALID, so the hot tables
  are not rewritten or scanned. No money moves and no existing row is rewritten.

## Why

Kill pots (rule manifest kill-v1) need a table setting that the database, not only the
client, keeps within what the engine can play. The setting also has to hold for every
table a cash game opens.

## Evidence

- `scripts/ci/test-kill-pot-table-settings.py` (new CI step): 71 cases passed on a local
  PostgreSQL 16 cluster, once with the harness's stub of `fn_capability_available`
  and once with the real registry migration from the capability registry candidate.
  CI runs it on 17.

## Pending

- Order: the migration refuses to install without `fn_capability_available`. It is
  applied only after the capability registry migration 20260924025555 is installed.
- Before installing, the owner confirms the two pinned md5(prosrc) values named in the
  migration header against production.
- The cash qualification pin for `.github/workflows/ci.yml` is updated
  (`killPotTableSettingsIntegration`).
