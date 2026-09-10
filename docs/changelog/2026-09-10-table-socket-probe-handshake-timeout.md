# 2026-09-10 — table-socket-probe `handshake_timeout`, two root causes, one night

**Alert:** `CRITICAL /api/cron/table-socket-probe failed 3x in a row — handshake_timeout x3, HTTP 503` at 22:28 CDT (03:28 UTC).
**Player impact:** none seated (`humansSeatedTotal` was 0 for the whole window); the bot fleet stopped dealing twice.
**Status:** fixed and verified. Fleet stable through two hourly restarts; 16 consecutive green probes from 05:03 UTC.

## Timeline (UTC)

| when | what |
| --- | --- |
| 02:55 | scheduled break; container `1-e1790665` (build `1695880b`) starts |
| 03:05→03:13 | engine log fills with `table_lease_lost` / `lease_proof_expired` / `supabase_timeout`; hands/min falls from ~19k log lines/min to ~5k |
| 03:18, 03:23, 03:28 | probe: `handshake_timeout` (socket never opened in 15 s) |
| 03:33 | probe: `pick_table` finds no table that dealt a hand in 10 min |
| 03:34:18 | Docker healthcheck finally flips unhealthy; `sp-autoheal` restarts the container at 03:34:30 |
| 03:54 | **fix 1 applied**: `20260910035245_the_settlement_lane_is_per_tournament_not_platform_wide` |
| 04:00–04:11 | fleet ramps to ~1,000 hands/min on ~400 tables (best of the night) |
| 04:12→04:22 | tables bleed 400 → 55; DB idle, event loop p50 20 ms — not the lane |
| 04:23–04:43 | probe: `handshake_timeout` ×5 |
| 04:55 | scheduled break restarts; same bleed begins again at 05:05 |
| 05:13 | **fix 2 applied**: `20260910051125_the_seat_move_door_the_engine_calls_exists` |
| 05:15 | last `Could not find the function public.fn_move_tournament_player` in the log |
| 05:56 | scheduled break; new container passes the 12-minute mark at 922 hands/min / 356 tables and holds |

## Root cause 1 — a platform-wide lock convoy (fix: #4111)

`20260909042455` (the previous day) introduced one advisory lock, `ca:tournament-terminal-settlement:v1`, as a "single transaction lane" for tournament money operations. 28 functions take it **exclusive**. `fn_ca_commit_hand_settlement` — every hand on every table, cash included — took it **shared**. Spin bot seating (`fn_seat_horse_in_seat_first_game`, ~2,850/h at 357 ms) keeps the exclusive side continuously busy, and Postgres grants locks FIFO: one queued exclusive request stalls every later shared request behind it. Hand settlement averaged 239 ms (max 5.9 s); ~2,200 lock-wait lines in 15 minutes, all on that key. The engine's lease renewals share the same connection budget and starved; it read its own expired leases as "another engine instance".

**Fix.** Three keys instead of one, no authority loses its exclusion: G (unchanged, exclusive for all 28, still what the trigger guards verify), B `ca:hand-settlement-barrier:v1` (shared by every hand; exclusive after G for the 20 terminal/rare authorities — yesterday's exclusion, unchanged), T(tournament) (exclusive after G for the 8 rolling per-tournament authorities; shared by that tournament's hands only). Cash hands take B only. Lock order everywhere: G → B → T → `atomic-table:<id>` → rows. The migration rewrites the 30 bodies from `pg_get_functiondef` with counts asserted, so it cannot revert a concurrent edit.

**Measured:** hand settlement 69 ms avg (from 239); advisory-lock waits 73 per 5 min (from 1,239 on the *healthy* pre-fix engine).

## Root cause 2 — the engine called functions that did not exist (fix: #4108)

PR #3716 (09-09 20:10) shipped engine code calling `fn_move_tournament_player(7 args)` and carried the 5,500-line cutover migration `20260909014545`. The engine deployed at 20:55; **the migration was never applied**. `20260909230135` (23:01) then dropped the old mover `fn_ca_move_tournament_seat` assuming the cutover was in. From 23:01 production had no tournament seat-move function. Every seat move → `PGRST202` → quarantine → manager cannot stop ("retained an unresolved seat-move UUID") → the exception is thrown inside `runOwnershipLeaseRenewalLoop`, which renews **every** lease → cash-table leases starve too → fleet winds down ~12 minutes into each container. 17,853 occurrences in 24 h of logs.

**Fix.** Installed exactly the door the engine calls, verbatim by line range from the two merged migrations (both tables, opener/closer, receipt reader, mover, resolver), with two marked edits: close the authority with `require_consumed=false` (the consuming guard trigger is deliberately not installed — it would refuse every current exit path), and enter the lane via `fn_ca_lock_settlement_lane_for_tournament`. Nothing existing replaced, renamed or dropped. The full cutover still needs a planned, reconciled application: **#4130**.

## Follow-ups (fix: #4129)

- Swept every `/rest/v1/rpc` 404 in 24 h and every `rpc('…')` in `server/src` against `pg_proc`: the engine's surface is complete. One more mismatch found and fixed — `fn_raise_server_financial_alert` had no `p_entity_id` parameter, so four of six engine call sites (Stable Hand warnings) were silently 404ing: `20260910062115`.
- `.claude/skills/deploy-hetzner/SKILL.md` rewritten: it named a dead IP and manual `docker run` steps the release seal now reverts within a minute.

## Parked, with reasons

- `atomic_distribute_rake` row-lock deadlocks between two hands' post-commit obligations (1–9/hour all day, Postgres resolves, engine retries). Not lane-related; a row-order change in the rake path needs its own analysis.
- The cutover `20260909014545`: #4130 has the exact reconciliation checklist (12 of its 26 function bodies are already superseded by later migrations; it drops a function cron 133 calls every minute; it needs a freeze).

## What would have prevented it

1. **Apply the migration before the engine that needs it deploys.** The skill now says so; a CI check that every `rpc('…')` name in `server/src` exists in the live catalog would make it mechanical.
2. **The healthcheck took 20 minutes to notice a fleet that had stopped dealing.** `dealRate.tablesExpectedDealing` was 0 in `/health` throughout; the probe saw it in 5. Worth wiring the probe's verdict, or `poker_cluster_pass_ticked`, into the container healthcheck.
3. **"Lost the lease to another engine instance"** was wrong all night — there was one instance. The message should say what it knows: the lease generation is not current.
