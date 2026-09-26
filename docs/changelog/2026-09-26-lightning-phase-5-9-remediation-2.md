# Lightning Phases 5 And 9, Remediation Two: The Seat Is The Anchor

**Migration:** `supabase/migrations/20260926045132_lightning_phase_5_and_9_remediation_two_the_seat_is_the_anch.sql`
**Harness:** `scripts/dev/test-lightning-remediation-two.sh` (Postgres 17, port 55551, 17 sections)
**Static suite:** `tests/lightning-remediation-two.test.ts`
**Schema fragment:** `scripts/ci/schema-manifest.d/lightning-remediation-two.json`
**Status:** built and proved locally. Not applied to production; the orchestrator applies it after 20260926023047.

## Why

The Lightning work shipped in 20260921151618 (conversion), 20260925204249 (halt and reaper), 20260925215731 (formation barrier) and 20260926023047 (its remediation) is live and dark: `lightning_enabled` is false on every Cluster and every Lightning table is empty. An independent audit found twelve defects. This file repairs all of them in one transaction. The design rule it enforces is the one the product was specified with: the physical seat (`table_seats`) is the economic anchor, the pool is an overlay on it, and conversion, pool entry and formation move no chips.

## What Changed, Defect By Defect

### 1. The Commit Could Not See A Hand In Flight (P0)

`fn_cash_cluster_commit_lightning` counted `hand_history` rows with `ended_at IS NULL`. `hand_history` is written only at settlement, always with `ended_at`, so the count was always zero. It now counts incomplete `hand_state_snapshots` rows: the engine writes one after every action of a hand (`save_hand_state_snapshot`, at most one open per table) and completes it after settlement. The six-hour window and the member-table filters are kept, because production holds 2,160 incomplete snapshots, 1,734 of them older than an hour and 2,124 on tables with no engine lease at all. `cash_hand_participant_manifests` was considered and not used: it has no settled marker, so reading it means joining `hand_history` over a million rows.

The commit also waits for the engine to say it has stopped. New column `tables.dealing_halt_observed_at` and new function `public.fn_cash_table_observe_dealing_halt(p_table_id uuid) RETURNS timestamptz` (SECURITY INVOKER, executable by `service_role` only). The engine calls it when its table is parked at the halt gate between hands; it stamps `clock_timestamp()` if and only if the table is halted and that halt has not already been observed, and returns the standing stamp (NULL when not halted). The commit answers `halt_not_observed` (a structured refusal, the conversion stays PENDING_ON) until every live, undeleted member table with an unexpired `engine_table_leases` row (heartbeat inside `fn_engine_lease_stale_seconds()`) has `dealing_halt_observed_at >= dealing_halted_at`. Tables with no live lease are exempt. A member table that is not halted at all is halted by the commit, which then waits one round.

`fn_cash_cluster_open_table` reads the Cluster `FOR SHARE` and opens a table already halted whenever the Cluster is not in `must_move`: reason `lightning_pending_on` in `pending_on`, `lightning` otherwise.

### 2. Nothing Took A Player Out Of The Pool, And Nobody New Got In (P1)

`lightning_pool_session.anchor_seat_id uuid NOT NULL REFERENCES table_seats(id)`, with `lightning_pool_session_one_open_per_anchor` (unique, `WHERE exited_at IS NULL`) and a plain index for the foreign key. The conversion writes it by asserted substitution of its INSERT: the seat its `DISTINCT ON (ts.user_id)` already picks. New `public.fn_lightning_pool_enter(p_seat_id uuid, p_now timestamptz DEFAULT clock_timestamp()) RETURNS uuid` enters an eligible seat of a lightning-mode Cluster at the current epoch (anchor that seat, `starting_stack` the seat stack, under the player's existing cash session) and opens its slot, or returns the player's existing open session.

Two constraint triggers on `table_seats`, both `DEFERRABLE INITIALLY DEFERRED` and both calling `fn_table_seats_lightning_pool_follows_seat()`: `trg_table_seats_lightning_pool_on_insert` (AFTER INSERT, WHEN the seat is eligible) and `trg_table_seats_lightning_pool_follows_seat` (AFTER UPDATE, WHEN `left_at`, `user_id`, `is_sitting_out` or `leave_pending` changes or the stack crosses zero). A departing or turned-over anchor exits its session (`exit_reason`, `ending_stack`), closes its slot and records `pool_player_left`; a player still seated elsewhere in the Cluster is re-entered through that seat. This also fixes joins, buy-ins and sit-ins after the commit. A one-time sweep at the end of the migration enters anybody already seated and eligible in a lightning Cluster (none in production).

### 3. Two Copies Of The Stack (P1)

`fn_lightning_pool_stack` now returns the anchor seat's `table_seats.stack`, or 0 once the anchor has left or turned over. `starting_stack` is a snapshot and `net_result` a statistic. Formation's candidate filter also requires `fn_lightning_anchor_is_live_eligible(anchor, cluster, player)` and an open cash session; the barrier locks the anchor seats `FOR SHARE` before the slots and pool sessions, and its money comparison includes each anchor's stack, departure and occupant.

### 4. A Player In A Live Hand Could Be Cashed Out (P1, Money)

`public.fn_lightning_player_in_hand(p_player_id uuid, p_cluster_id uuid) RETURNS boolean` is true if and only if a committed reservation exists on an instance in `forming`, `reserved`, `dealing` or `settling`. `trg_table_seats_lightning_anchor_guard`, BEFORE UPDATE WHEN `OLD.stack IS DISTINCT FROM NEW.stack OR OLD.left_at IS DISTINCT FROM NEW.left_at OR OLD.user_id IS DISTINCT FROM NEW.user_id`, refuses with message prefix `LIGHTNING_HAND_IN_PROGRESS` and SQLSTATE `PLT01` a change to a seat anchoring an open pool session whose player is in hand, unless `current_setting('ca.lightning_settlement_hand', true)` equals that hand id. Its first statement is one index probe on `anchor_seat_id`. Measured in the harness: about 3 to 5 microseconds per ordinary stack update, over 3,000 updates, best of three.

### 5. A Participant Could Leave A Locked Hand (P2)

`fn_lightning_hand_player_is_immutable` now also asks the latch of `OLD.hand_id` on UPDATE and refuses any `hand_id` change on a row whose old hand is locked.

### 6. `fn_lightning_instance_begin_dealing` Checked Nothing Outside The Instance (P2)

It takes `cash_games` `FOR SHARE` before the instance, and abandons the instance with a reason (`cluster_is_not_lightning`, `lightning_disabled`, `epoch_is_not_current`, `participant_left_the_pool`) and answers a structured refusal unless every participant's pool session and slot are open, the anchor is live eligible and the cash session is open. The deadline is judged by `clock_timestamp()`.

### 7. Impossible States Were Retried (P2)

The barrier's own re-checks and its money comparison (moved inside the atomic block) raise SQLSTATE `PLT02`. The handler retries only `55P03`, `40P01`, `40001` and a `unique_violation` on an index two matchers really race for (the four reservation indexes, the two open-slot indexes and `lightning_hand_one_per_request`). Everything else freezes the Cluster through the existing Cluster state machine (`cluster_mode = 'frozen'`, which every formation, opening and deal already refuses and which the epoch row follows), writes `stack_invariant_failed` and `cluster_frozen` with the SQLSTATE, message, constraint, players, seats and both money snapshots, and answers `formation_invariant_failed` with `retry: false`. Unfreezing is an operator's UPDATE back to `lightning`.

### 8. Lock-Order Inversion And Long Holds In The Tick (P2)

`fn_lightning_pool_slots_sync` takes `cash_games` `FOR UPDATE SKIP LOCKED` first (the mode formation uses) and answers `cluster_busy` instead of waiting, checks the pass deadline `fn_cash_clusters_tick_all` now publishes in `ca.cluster_pass_deadline` before every slot it opens, and closes slots at `GREATEST(p_now, opened_at)`. `fn_cash_clusters_tick_all` also stops starting Lightning Clusters past its budget. `fn_cash_clusters_to_tick` is not narrowed, because the ClusterController builds its row map (Main 1, enabled, eligible horses) from it; instead `fn_cash_cluster_tick` reads `cluster_mode` plainly first and stands down without ever taking the row.

### 9. One Failed Abort Rolled Back The Whole Reap (P2)

Each abort in `fn_cash_cluster_reap_stuck_conversions` runs in its own sub-block; a failure is recorded as `lightning_pending_on_reap_failed` with its SQLSTATE and the pass continues.

### 10. Missing Specification Events (P2)

`cash_cluster_events.event_version smallint NOT NULL DEFAULT 1` and `request_id uuid`. New events: `cluster_epoch_started` (from the epoch writer, genesis and every advance, with the conversion's request), `pool_player_joined` and `pool_player_left` (per player), `instance_created` (barrier and `fn_lightning_instance_open`), `instance_started`, `instance_completed` and `instance_destroyed` (from the terminal trigger, so every road is covered, including a dealing hand the reaper voids, with `hand_voided`), `pool_player_reserved` and `pool_player_released` (one per instance with the player list) and `hand_created` with every participant's seat, position, blind role and stack. `hand_created` replaces `lightning_hand_formed`, which nothing outside the Phase 9 harness read (checked in `server/src`, `src`, scripts and tests).

### 11. Idempotency, Closed History, Forensics, Debt Age (P3)

`fn_lightning_form_hand` gains `p_request_id uuid DEFAULT NULL`: the nine-argument signature is dropped in the same transaction and its comment and grants carried to the ten-argument one. `lightning_hand.request_id` is unique (`lightning_hand_one_per_request`) and immutable; a retry with the same id answers `replayed: true` with the hand it formed, and an id from another Cluster is refused. DELETE is revoked from `service_role` (and the browser roles) on the seven Lightning tables and `cash_cluster_conversion`, and TRUNCATE on the latter, after verifying no function body and no line of `server/src` deletes from them. `cash_cluster_conversion.chips_at_begin` and `chips_at_commit` record the seats' chip total at the halt and at the commit. `lightning_blind_ledger.debt_since` is kept by `trg_lightning_blind_ledger_tracks_debt_since` (set when any of the four obligations first becomes unresolved, cleared when all are resolved) and is the third term of the P2 key in place of `updated_at`, which every formation moved. The barrier's big-blind check compares the `debt_age` the blind order returns, so the two agree by construction.

## Decisions That Differ From The Brief

- The pool triggers are deferred constraint triggers, not plain AFTER triggers. The live buy-in (`atomic_table_buyin_before_maintenance_announcement_gate`) inserts the seat before it opens the cash session a pool session must be subordinate to; an immediate trigger would never let a buyer in. The harness proves the immediate version fails.
- The anchor guard's WHEN clause also includes `user_id`, because seat rows turn over to a new occupant (`fn_clear_sitout_on_turnover`).
- `fn_cash_table_observe_dealing_halt` does not re-stamp a halt it has already seen, so an engine polling its gate writes the row once per halt.
- Formation does not call `fn_cash_cluster_live_eligible`, which counts a UNION that includes the pool itself. `fn_lightning_anchor_is_live_eligible` is its seated half asked of one seat; the harness proves the two count the same five of twelve players across every deciding shape.
- The guard's probe is served by either anchor index; the planner prefers the full one the foreign key needs.
- The two table*seats trigger functions are SECURITY DEFINER: the rows they must see are behind row level security, and a writer who cannot see them must not pass for that reason. Every `fn_lightning*` function stays SECURITY INVOKER.
- The hot-table DDL (`tables`, `cash_cluster_events`, the `table_seats` foreign key and triggers) is the last thing before COMMIT, under a 3 second lock_timeout, so its locks are held for milliseconds.

## Corrections

The following `@live-proof` lines of earlier files are false after 20260926045132, deliberately; the migration files are not edited. The harness evaluates every proof of all four predecessors and requires that exactly these, and no others, are false. Where a proof names the nine-argument `fn_lightning_form_hand`, the harness also evaluates it with the ten-argument signature, and "holds in substance" means that version is true.

| Proof                 | Line | What It Pinned                                              | Why It Is Now False                                              |
| --------------------- | ---- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| 20260925204249 p5r#4  | 399  | exactly three functions write `SET dealing_halted_at`       | `fn_cash_cluster_open_table` now opens a table halted (defect 1) |
| 20260925215731 p9#2   | 353  | the nine-name `fn_lightning_` list                          | already superseded by 20260926023047; the set grew again         |
| 20260925215731 p9#6   | 357  | no `fn_lightning_` function writes `lightning_pool_session` | `fn_lightning_pool_enter` is the pool door (defect 2)            |
| 20260925215731 p9#15  | 366  | the six-name trigger list                                   | already superseded by 20260926023047; the set grew again         |
| 20260926023047 p9r#1  | 350  | the ten-name `fn_lightning_` list                           | four new functions                                               |
| 20260926023047 p9r#2  | 351  | the thirteen-name Lightning trigger list                    | `trg_lightning_blind_ledger_tracks_debt_since`                   |
| 20260926023047 p9r#13 | 362  | the nine-argument barrier exists                            | signature changed; holds in substance                            |
| 20260926023047 p9r#14 | 363  | barrier reaps under its lock                                | names the nine-argument signature; holds in substance            |
| 20260926023047 p9r#15 | 364  | barrier locks pool sessions FOR SHARE                       | names the nine-argument signature; holds in substance            |
| 20260926023047 p9r#16 | 365  | the retryable class list                                    | names the nine-argument signature; holds in substance            |
| 20260926023047 p9r#20 | 369  | the five versions are stamped                               | names the nine-argument signature; holds in substance            |
| 20260926023047 p9r#21 | 370  | the P2 key with `updated_at`                                | the third term is `debt_since` (defect 11)                       |
| 20260926023047 p9r#22 | 371  | the big-blind override ties on pool entry                   | names the nine-argument signature; holds in substance            |
| 20260926023047 p9r#25 | 374  | seven- to nine-handed positions                             | names the nine-argument signature; holds in substance            |
| 20260926023047 p9r#29 | 378  | no `fn_lightning_` function writes `lightning_pool_session` | `fn_lightning_pool_enter` (defect 2)                             |

The two stale proofs the audit named in 20260925215731, the nine-name function list and the six-name trigger list, are p9#2 and p9#15 above. Every proof this file adds is containment: it names what this file put there and never the size of a set a later file may grow.

## How It Was Proved

`bash scripts/dev/test-lightning-remediation-two.sh` builds Postgres 17 on a socket, applies the three Lightning fixtures, every Lightning migration from 20260920235343 through 20260926023047, the Phase 9 writers and this harness's fixture, and then:

- Section 01 reproduces every defect on 20260926023047's own code, on the estate it builds.
- The migration is applied over that estate, and sections 02 to 14 prove each repair with a bad twin and a good twin one thing apart, horses included (Law 10.5), with a real second backend for the lock proofs and function-call counters for the WHEN clauses.
- Section 15 evaluates all 32 proofs of this file (all true) and every proof of the four predecessors (true except the Corrections list, each false).
- Section 16 applies the file a second time and finds every body, acl, comment, trigger, index, constraint, column and row count unchanged.

The Phase 5 and Phase 9 harnesses apply fixed lists that end before this file, and were re-run unchanged and green. CI runs the new harness in `accounting_postgres` right after the Phase 9 formation step, and the `.github/workflows/ci.yml` pin in `scripts/qualification/cash-native-hosted.manifest.json` is recomputed.

## For The Engine And Settlement Engineers

- Call `fn_cash_table_observe_dealing_halt(table_id)` from the halt gate, between hands, whenever the table is parked because `dealing_halted_at` is set.
- Settlement of a Lightning hand sets `ca.lightning_settlement_hand` to that hand id for its transaction; without it the anchor seat's stack, departure and occupant cannot change while the player is in hand (SQLSTATE `PLT01`).
- Pass `p_request_id` to `fn_lightning_form_hand` and retry with the same id; treat `formation_invariant_failed` (`retry: false`, `frozen: true`) as a page, not a retry.
