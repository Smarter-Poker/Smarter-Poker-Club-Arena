# 2026-09-10 (phase 2): five-agent swarm on per-hand cost, and the Spins that never launched

Follows `2026-09-10-cpu-alert-indexes-cron-cadence-seat-guards-and-2xl.md`.
Dan asked for the remaining work to be parallelised. Five read-only agents
(rolled-back probes only, no DDL) each took one workstream and returned a
report plus proposed SQL; the orchestrator applied the DB changes as two
migrations. Every agent report and SQL file is under
`docs/changelog/swarm-2026-09-10/` (A-freeze-guard, B-tournament-seats,
C-stuck-spins, D-outbox-notify, E-tick-horse-lobby).

## Applied: migration 20260910034411 (one transaction, one reload)

| change                                                                                                                    | measured before                                                                                                                                                                        | after                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| B: `trg_lock_and_validate_tournament_live_seat` proof-open EXISTS `t.id = ANY(v_ids)` -> `(t.id = v_old OR t.id = v_new)` | 0.83-0.99 ms per tournament seat write, re-planned on every call (array parameter never adopts the generic plan); 55-60% of steady-state trigger time on a tournament seat stack write | 0.026 ms once the generic plan is adopted; ~-4.9 ms per tournament hand |
| A1: `fn_active_maintenance_release_boundary` OFFSET 0 fence                                                               | `shifted ?& <14 keys>` evaluated first over all 167 thaws rows on every fn_platform_frozen() call: 229 us                                                                              | 32 us; fn_platform_frozen ~300 -> ~100 us                               |
| E: RLS `poker_arena_tournament_access` on tournaments rewritten to a hashed subplan over clubs                            | per-row plpgsql call over 135,616 rows for a union member: 66,700 ms; 148 statement timeouts (8 s) in 70 min never visible in pg_stat_statements                                       | 340 ms, ~14 ms with the index below                                     |
| E: `idx_cash_seat_moves_cancelled_player` (player_id, created_at) WHERE cancelled                                         | 110k-row seq scan per candidate seat in the cash-cluster tick (496 ms / 88k buffers for one open seat)                                                                                 | 2-page index                                                            |
| E: `idx_tables_cluster_open` (cluster_id, role, main_index, created_at) WHERE lifecycle<>'closed'                         | every per-cluster statement discarded ~97% closed tables; fn_cash_clusters_to_tick EXISTS seq-scanned 206k rows (78 ms) per pass                                                       | 137-row index                                                           |
| E: `idx_tables_cluster_closed_status_drift`                                                                               | status_followed_lifecycle repair scanned each cluster every tick                                                                                                                       | 2-row index                                                             |
| E: `idx_tournaments_updated_at` (CONCURRENTLY, separate statement)                                                        | top-N sort over 130k rows for the lobby ORDER BY                                                                                                                                       | ordered backward scan                                                   |

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

## Phase 3 (05:00-05:40 UTC): the engine work, shipped as branches

Four more agents, each in its own worktree, each branch pushed through the
pre-push hook green (the hook runs tsc plus the tests covering the diff);
`agent-open-pr.yml` opened the pull requests and autopilot merges them when
the required checks pass. Nothing here was merged by hand.

| PR    | branch                                              | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #4107 | fix/spin-launch-terminal-reasons-backoff            | A terminal Spin draw refusal (9 deterministic reasons, confirmed against the live function body) parks the launch: 30 s doubling to a 15 min cap with jitter, ONE critical financial alert (`Tournament.spin_launch_parked`, keyed per tournament + reason), one warn. Transient reasons (`launch_lease_lost`, `launch_receipt_state_mismatch`, `entry_purchases_frozen`, transport errors) keep the 3 tries then a 5 s doubling park. `discoverSeatFirstStarts` and `ensureTournamentManagerAdmission` skip parked ids. Simulated three hours of a permanent refusal: 16 calls and 1 alert, versus ~3,000 calls before. 24 new tests; 3,859 server tests green. |
| #4112 | fix/horse-seat-first-skips-a-seat-it-already-has    | `topUpWithHorses` reuses the `table_seats` rows it already read and reads `tables.max_players` once, and calls `fn_seat_horse_in_seat_first_game` only for a horse the rows do not show seated on a table the rows do not show full; an RPC `table_full` marks the table full for the rest of the pass. Same RPC, same args, RPC still the authority, no is_horse filter. Log line `seat-first-precheck` per pass with skipped/called counts. Before: 1,533 calls / <=579 seats in 46 min, >=60% no-ops, 590 ms mean (global advisory lock convoy). 24 new tests.                                                                                                |
| #4115 | fix/hand-projection-wakes-by-notify-with-a-poll-net | `HandOutboxListener` (dedicated `pg` client, LISTEN hand_projection_outbox, jittered reconnect, heartbeat, resync wake) enabled only when `ENGINE_PG_LISTEN_URL` is set; a 5 s poll that fires only when no drain is running; `poker_hand_projection_wakes_total{source}`; Realtime subscription kept for the cutover. Migration `20260910052523_hand_projection_outbox_notifies_its_listener` (NOTIFY trigger) is APPLIED on production (05:32 UTC) and has no engine effect until the listener connects. 13 new tests; 2,778 server tests green.                                                                                                               |
| #4117 | fix/cpu-alert-2026-09-10-records                    | The four DB migrations from phases 1-2 (already applied and recorded), both changelogs, and the swarm reports. The definer-authorization gate asked for an explicit REVOKE/GRANT on `fn_spin_draw_and_settle_atomic`; production already had exactly that grant set (postgres, service_role), so the migration now states it.                                                                                                                                                                                                                                                                                                                                    |

**Dan must set one thing** for #4115 to do anything beyond the poll:
`ENGINE_PG_LISTEN_URL` in `/opt/club-arena/server/.env` on the engine host,
value = the Supabase SESSION-mode pooler string (Dashboard > Connect > Session
pooler, port 5432, user `postgres.<ref>`; not 6543, not the direct IPv6-only
host), then an engine restart. After one :55 cycle with `/metrics` showing
`poker_hand_outbox_listener_connected 1` and `wakes_total{source="listen"} >=
{source="realtime"}`, run step 2 from the migration's comment block
(`ALTER PUBLICATION supabase_realtime DROP TABLE public.hand_projection_outbox`)
at a quiet moment; that is the 5-7% of DB time.

**Workstream I (settlement writes each seat once): APPLIED 05:59 UTC as
migration 20260910054712** after the rolled-back validation reported
`VERDICT: PASS` on a live cash seat (seat_writes=1 with and without the
envelope). First five minutes: 3,851 settlements succeeded, 0 failed, 0 stuck,
0 ledger write failures. The paragraph below is the pre-apply analysis. `I-one-seat-write-per-hand.md/.sql` show the combined write is
behaviour-identical (all 43 table_seats triggers read; none inspects the
time-bank columns; row images identical in a rolled-back probe) and saves
~2.0-2.6 ms per hand steady state (7-20 ms cold), about 1% of settlement. It
needs the time-bank values to ride in a transaction-local setting
(`app.ca_hand_time_banks`) because the stack payload is hashed into
`hand_atomic_commits.payload_hash` and the core is owner-only behind three
SECURITY DEFINER wrappers. That is a real design change inside the money path
for a 1% gain, and the two functions were replaced once already tonight by
another agent (diamonds delegation). Held for Dan's explicit go; the SQL has
md5 guards and a rolled-back self-test that must end in
`PROBE_ROLLED_BACK ... VERDICT: PASS`.

## Phase 4 (05:45-06:30 UTC): the review pass and the last DB fixes

- **Migration 20260910054638** (applied 05:50 UTC): the `tables` RLS policy
  gets the same hashed-subplan rewrite as `tournaments`; `supabase_auth_admin`
  is a trusted actor in `fn_active_maintenance_release_boundary` (GoTrue's own
  role; signup wallet trigger was raising 42501); `fn_spin_expire_unfilled`
  reads `COALESCE(spin_multiplier,0) > 0` - with the column's DEFAULT 0 it had
  expired NOTHING since 09-08, so nobody waiting in an unfilled Spin past the
  timeout was refunded.
- **Review agents on the three engine PRs** (each finding fixed on the branch,
  or on a new branch where the PR had already merged, per 10.82):
  #4107 spin backoff: registry pruned against the REGISTERING board, alert
  call wrapped so it cannot throw into the launch, stall watchdog skips parked
  ids, `/metrics` gauges `poker_spin_launches_parked*` and `/health`
  `spinLaunchParks`; 30 tests. #4112 horse seat (merged as 5800a2b9db, follow-up
  branch `fix/seat-first-precheck-verifies-before-it-skips`, merged f725361edf):
  a skip is verified by a lock-free re-read so a horse that stood up between
  the read and its turn still gets the RPC this pass (10.5), a seat that opens
  after a `table_full` answer is filled this pass, `poker_seat_first_precheck_total{outcome}`;
  37 tests. #4115 outbox: `HAND_PROJECTION_POLL_MS=` empty no longer means a
  0 ms interval, the poll can be held off by an armed retry for at most 25 s,
  and the drain now runs per-table chains with bounded concurrency (default 4,
  strict hand order inside a table; the DB serialises per table with advisory
  locks) - the 100k-row outbox backlog drains ~4x faster; outbox depth and
  oldest-age gauges plus four Prometheus alert rules (`hand-projection` group;
  go live with `infra/monitoring/deploy.sh` on engine-01; they WILL fire until
  the backlog is gone). 49 tests; 2,884 engine tests green.
- **Listener decision:** the engine host holds no database password and none
  will be placed there by an agent (10.84), so `ENGINE_PG_LISTEN_URL` stays
  unset. The Realtime subscription on `hand_projection_outbox` is redundant
  anyway (every committed hand wakes the worker locally, and the 5 s poll is a
  net), so once #4115 is deployed the table leaves the publication - that is
  the 5-7% of DB time, with no LISTEN needed.
