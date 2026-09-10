# 2026-09-10 (phase 2): five-agent swarm on per-hand cost, and the Spins that never launched

Follows `2026-09-10-cpu-alert-indexes-cron-cadence-seat-guards-and-2xl.md`.
Dan asked for the remaining work to be parallelised. Five read-only agents
(rolled-back probes only, no DDL) each took one workstream and returned a
report plus proposed SQL; the orchestrator applied the DB changes as two
migrations. Every agent report and SQL file is under
`docs/changelog/swarm-2026-09-10/` (A-freeze-guard, B-tournament-seats,
C-stuck-spins, D-outbox-notify, E-tick-horse-lobby).

## Applied: migration 20260910034411 (one transaction, one reload)

| change | measured before | after |
|---|---|---|
| B: `trg_lock_and_validate_tournament_live_seat` proof-open EXISTS `t.id = ANY(v_ids)` -> `(t.id = v_old OR t.id = v_new)` | 0.83-0.99 ms per tournament seat write, re-planned on every call (array parameter never adopts the generic plan); 55-60% of steady-state trigger time on a tournament seat stack write | 0.026 ms once the generic plan is adopted; ~-4.9 ms per tournament hand |
| A1: `fn_active_maintenance_release_boundary` OFFSET 0 fence | `shifted ?& <14 keys>` evaluated first over all 167 thaws rows on every fn_platform_frozen() call: 229 us | 32 us; fn_platform_frozen ~300 -> ~100 us |
| E: RLS `poker_arena_tournament_access` on tournaments rewritten to a hashed subplan over clubs | per-row plpgsql call over 135,616 rows for a union member: 66,700 ms; 148 statement timeouts (8 s) in 70 min never visible in pg_stat_statements | 340 ms, ~14 ms with the index below |
| E: `idx_cash_seat_moves_cancelled_player` (player_id, created_at) WHERE cancelled | 110k-row seq scan per candidate seat in the cash-cluster tick (496 ms / 88k buffers for one open seat) | 2-page index |
| E: `idx_tables_cluster_open` (cluster_id, role, main_index, created_at) WHERE lifecycle<>'closed' | every per-cluster statement discarded ~97% closed tables; fn_cash_clusters_to_tick EXISTS seq-scanned 206k rows (78 ms) per pass | 137-row index |
| E: `idx_tables_cluster_closed_status_drift` | status_followed_lifecycle repair scanned each cluster every tick | 2-row index |
| E: `idx_tournaments_updated_at` (CONCURRENTLY, separate statement) | top-N sort over 130k rows for the lobby ORDER BY | ordered backward scan |

A's headline finding: the "frozen-check-first" reorder of
`fn_refuse_while_frozen` that phase 1 planned is a net LOSS and was not
applied. The exemption chain costs 30-70 us; the cost is `fn_platform_frozen()`
itself, which only non-exempt callers pay. Putting it first would charge every
engine (service_role) write 0.06 -> 0.35 ms. Measured, so the plan changed.

## Applied: migration 20260910034412 (money path, its own transaction)

**Root cause of the 106 stuck Spins (C):** `tournaments.spin_multiplier` has
DEFAULT 0 and the seat-first creator omits the column, so every Spin since
09-08 carried 0; the atomic draw function refused `IS NOT NULL` as "projected
without funding proof". Its proof harness used a bare table with no default,
so 36 checks passed. Zero Spins had launched since 09-09 11:44 UTC;
`spin_draw_receipts` was empty. A second defect (D2) meant fixing D1 alone
would have moved money and stalled one step later (the tournament row was
never stamped, and the ladder trigger refuses the engine's presentation patch
on an unstamped row).

**Proof before apply:** the new body was created in a transaction that ended in
RAISE; inside it a live stuck Spin drew, funded, receipted, stamped, replayed
idempotently, and passed 14 conservation assertions. Rolled back, no reload.

**Result:** the engine's existing loop launched all 106 within three minutes
of the apply (03:51-03:54 UTC): 106 receipts, 106 RUNNING, 163 Spin hands in
the first three minutes, prizes 6,952 chips (57x2, 37x3, 6x4, 4x5, 1x10, 1x25)
funded from the reserve pools exactly, 106 prize legs, retry loop stopped.
7,872 chips of buy-ins from 243 wallets (all horses, treated as players) are
in play instead of frozen. No refunds, no hand-written wallet rows.

## Not applied, with reasons

- **fn_refuse_while_frozen reorder (A):** net negative, see above.
- **Horse seating `fn_seat_horse_in_seat_first_game` 1.1 s/call (E):** not a
  query problem. `fn_ca_lock_tournament_seat_acquisition` takes a GLOBAL
  exclusive advisory lock that conflicts with the shared lock every hand
  settlement holds; 90% of samples are lock waits, >=60% of calls are no-ops
  (already_seated / table_full) that still queue. No behavior-identical DB
  change exists. Fix is caller-side: the fleet checks `table_seats` for an
  existing live seat (indexed, lock-free) and skips the RPC.
- **Tournament-seat guards beyond B's one change:** `terminal_*`,
  `no_live_seat_on_finished_game`, `retired_club`, `cancelled_immutable` all
  do real work on a stack write (status lookups that refuse or vacate) and
  cost 0.06-0.35 ms each in steady state. Left alone.
- **`tables` RLS policy `poker_arena_table_access`:** identical per-row
  pattern to the tournaments one; rewrite is in E's SQL, commented. Apply
  after a day of the tournaments version.

## Engine work this phase produced but could not ship from here

1. **Spin launcher backoff (C):** TournamentManagerBase.ts:3312-3348 retries
   every non-ok reason 3x (250/500 ms) then sets running=false;
   GameServer.ts:6434-6560 `discoverSeatFirstStarts` (1 s) restarts the dead
   manager: ~87 RPC/s. Deterministic reasons
   (`projected_spin_draw_has_no_funding_proof`, `spin_rule_manifest_invalid`,
   `invalid_spin_contract`, `legacy_spin_rules_unproven`) must park the launch
   with exponential backoff (30 s -> 15 min) and raise ONE financial alert.
   D3: `fn_create_seat_first_game_atomic` must write the NULL it validated.
2. **hand_projection_outbox Realtime -> LISTEN/NOTIFY (D):** the engine's
   subscription (server/src/services/supabase/handProjection.ts:278-297 on
   origin/main) never reads the row payload; it only calls
   `wakeHandProjection()`. There is NO periodic poll; every locally committed
   hand already wakes the worker directly (handHistory.ts:717). Design: AFTER
   INSERT trigger `pg_notify('hand_projection_outbox', hand_id:table_id)`, a
   `HandOutboxListener` on one dedicated `pg` client (new dependency; engine
   has no direct Postgres connection today) with LISTEN + jittered reconnect +
   a 5 s poll fallback, both paths live with `poker_hand_projection_wakes_total{source}`
   for one :55 cycle, then `ALTER PUBLICATION supabase_realtime DROP TABLE
   public.hand_projection_outbox`. LISTEN needs a SESSION-mode connection: the
   direct host is IPv6-only and Hetzner is IPv4, so a new env var
   (`ENGINE_PG_LISTEN_URL`, session pooler on 5432) has to be set by Dan via
   `update-hetzner-env`; the SQL includes an optional LISTEN-only role.
   Realtime decoding was 5.2% of DB time in the 35 min after the restart.
3. **Outbox backlog (D, side finding):** `hand_projection_outbox` is 64,485
   rows deep (oldest 6.8 h). The drain is one serial PostgREST round-trip per
   hand (~300/min) against ~600/min daytime arrivals. NOTIFY does not change
   this; a per-table concurrent drain would (the DB already serialises per
   table with advisory locks). Hand side effects (stats, missions) are hours
   behind during peak.
4. **Settlement writes each tournament seat twice (B):**
   `fn_ca_settle_hand_stacks_absolute` updates stack, then
   `fn_ca_commit_hand_settlement` updates the two time-bank columns in the same
   transaction: a second full trigger pass plus three FK re-checks per seat
   per hand (~1.8 ms warm). Folding the time-bank columns into the stack
   UPDATE is the single biggest remaining per-hand win and is a settlement
   function edit, not a trigger edit.
5. **Signup wallet trigger (A, side finding):** `handle_new_user_v2_create_wallet`
   runs as supabase_auth_admin and now fails with 42501
   MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED from
   `fn_active_maintenance_release_boundary` (applied out of band, not in the
   repo). It writes `public.wallets`, which is the dead pool nothing reads
   (11.5), so signups still succeed (signup_errors id 9318, 03:06 UTC) - but the
   trigger should either be retired with the table or the auth admin role added
   to the trusted-actor list. Dan's call.

## Where the box is now (03:55 UTC, 2XL)

Average 4.4 backends busy across 8 cores since the 02:34 restart, and that
window includes the spin retry loop (0.6 core, now gone), the swarm's probes,
and the cold cache. Cash seat write ~2 ms of guards; tournament seat write
~0.85 ms. Lobby query no longer times out for union members.
