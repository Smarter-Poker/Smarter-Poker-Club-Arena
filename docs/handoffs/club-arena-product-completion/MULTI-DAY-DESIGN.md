# Multi-Day Tournaments: Lifecycle Design (v1)

Assignment CA-PRODUCT-COMPLETION-2026-09-22, docs-only lane. Base `a759cf82`.
Every anchor below is `path:line` in this tree. Migration paths are abbreviated
to their version prefix (`supabase/migrations/<version>_*.sql`).

## 0. What The Code Actually Says (verified, with corrections)

The prior investigation holds; rows marked NEW are additions that change the design:

| Fact                                                                                                                                                                                                      | Anchor                                                                                                | Consequence                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| The guard refuses 7 columns with 0A000; its trigger names all 7                                                                                                                                           | `20260902052302:76-131`                                                                               | Newest body. It is also the kill switch until step R6 (section 8).                                                                                                                |
| Status CHECK is exactly ANNOUNCED, REGISTERING, LATE_REG, RUNNING, COMPLETING, COMPLETED, CANCELLED                                                                                                       | `20260429i_x17:35-46`                                                                                 | A new status is a constraint change.                                                                                                                                              |
| `zz_freeze_launch_guard` fires on every write INTO `RUNNING`, and raises `TOURNAMENT_LAUNCH_RECEIPT_REQUIRED` unless `OLD.status='REGISTERING'` with an incomplete launch receipt and the tx-local marker | trigger `20260903003000:113-117`; body `20260908042800:405-426`                                       | Any `X -> RUNNING` for X other than REGISTERING is refused today. A resume needs its own receipt exemption.                                                                       |
| `trg_tournaments_start_readiness` only acts when `OLD.status IN ('ANNOUNCED','REGISTERING')`                                                                                                              | `20260906113000:319-320` (trigger `20260902110000:386-389`)                                           | Needs no exemption for a same-row resume; must be pinned so it stays that way.                                                                                                    |
| `zz_ca_fund_overlay_on_lock` only acts when `OLD.status IN ('ANNOUNCED','REGISTERING')`; it recounts payout depth from the row's own `tournament_players` and debits union bank or club treasury          | `20260914143521:61-76`, overlay debit `:146-249`                                                      | A child row per day would refit payout depth to the survivors and fund the guarantee a second time.                                                                               |
| `tournaments_rank_before_complete` fires on `-> COMPLETED`                                                                                                                                                | `20260917201651:30`; `fn_rank_survivors` `:784`                                                       | Any stage that "completes" a row ranks its survivors as finishers.                                                                                                                |
| Launch receipt: one per row (`PK tournament_id`), immutable, completed once                                                                                                                               | `20260908042800:1036-1075`                                                                            | A child-per-day design gets one launch per day; same-row needs a separate stage-resume receipt.                                                                                   |
| Launch RPCs are lease-fenced (`protocol_version=2`, generation, 30 s heartbeat)                                                                                                                           | `20260917062000:242-318`, `:320-372`; completion proof `20260911173003:192-300` (status check `:257`) | Pattern to copy for resume.                                                                                                                                                       |
| Blind publication refuses unless `status='RUNNING'` and not on break or frozen                                                                                                                            | `20260913200859:56-63`                                                                                | A bagged row cannot advance blinds by construction. New tables inherit `blind_level_state`                                                                                        | `20260913200859:127-146`. |
| `fn_thaw_platform` shifts `level_started_at` only `WHERE status='RUNNING' AND NOT on_break`                                                                                                               | `20260908032311:238-270` (`:245`, `:254`)                                                             | A row that is not RUNNING while bagged is untouched by the thaw.                                                                                                                  |
| Level remaining time is derived, not stored: `remaining = duration - (now - level_started_at - pausedMs)`                                                                                                 | `TournamentManagerBase.ts:5660-5705`                                                                  | Overnight needs an explicit persisted remaining duration.                                                                                                                         |
| `resumeLifecycle` returns without a manager unless the fresh row is RUNNING                                                                                                                               | `TournamentManagerBase.ts:5450`                                                                       | Safe default for a new status. `startLifecycle` excludes only COMPLETING, COMPLETED, CANCELLED (`:4282`), so it must also exclude the new status.                                 |
| The felt is the stack witness; the mirror is a projection. Seat assignment reads `table_seats.stack` first, then `tournament_players.chips` when no live seat; a mint gate forbids raising the live total | `20260918093004:362`, `:431-455`, `:457+`                                                             | Bag must make the bag row the only owner and leave the mirror equal to it; resume can reuse this seat authority.                                                                  |
| `fn_sync_tournament_chips` writes the mirror for `status='playing'` rows with no lease check                                                                                                              | `20260906152529:26-60`                                                                                | A stale manager could overwrite a bagged mirror unless fenced (PostgREST lease fence `20260908043200:1-18`, plus a new trigger).                                                  |
| Accepted hands: `hand_atomic_commits (table_id, hand_number, hand_id, stack_result)`; in-flight hands: `hand_state_snapshots.is_complete=false`                                                           | `20260908042100:50-60`; `20260326_hand_state_snapshots.sql:12`                                        | These are the bag watermark and the "no cards in the air" proof.                                                                                                                  |
| Started events never cancel: `atomic_cancel_tournament` refuses when `started_at IS NOT NULL`, a completed launch receipt, hands, or paid obligations exist                                               | `20260910171843:12-35` (function `20260909014444:659`)                                                | Holds for BAGGED unchanged.                                                                                                                                                       |
| Registration core admits only ANNOUNCED/REGISTERING or RUNNING with late reg open                                                                                                                         | `20260917233447:948-953`; rake row `:1122-1128`; funding receipts `:64-80`                            | BAGGED closes registration by construction.                                                                                                                                       |
| `fn_uncollected_entry_check` blanket-exempts `day_number>1 OR parent_tournament_id IS NOT NULL`                                                                                                           | `20260902052604:109-114`, note `:155-163`                                                             | Same-row design never sets those, so the blanket exemption stays unreachable.                                                                                                     |
| Wakes: `tournament_manager_wakes` with generation, reason CHECK, one pending per reason                                                                                                                   | `20260908042000:405-434`; consumer `GameServer.ts:8521`, ack `:8723`                                  | Wakes address a live manager; a bagged event has none.                                                                                                                            |
| Frozen Spin witness compares `to_jsonb(t)` of the whole `tournaments` row and `to_jsonb(r)` of every `tournament_players` row                                                                             | `20260918122532:27759-27770`                                                                          | New columns on either table change the image. All new state goes in new tables.                                                                                                   |
| NEW: the MTT activation guard pins `tournaments_status_check`, launch RPCs, overlay trigger, `fn_rank_survivors`, registration core and 20 named `tournaments` triggers by md5/definition                 | `20260918093004:714-800` (pins in the JSON at `:720`)                                                 | If production `ca_mtt_admission_contract.abi` is still `legacy-capacity-v1`, touching any pinned object makes that activation refuse with `MTT_ACTIVATION_*_DRIFT`. Preflight R0. |
| NEW: a dormant legacy `tournament_flights` table exists with `ON DELETE CASCADE`, admin write policies and, from the phantom remediation, `CREATE POLICY tf_sel ... FOR ALL USING (true)`                 | `20260312002:12-24`, policies `:36-66`; `20260314_phantom_table_remediation.sql:7`, `:196`            | Never reuse it. Verify and lock it in R0. Legacy columns `day1_ended_at`/`day2_started_at` (`20260312002:74-83`) are also unused and must stay so.                                |
| `fn_capture_accounting_tournament_fee` has no `CREATE` in repo migrations; it exists only as a pinned signature in activation witnesses                                                                   | e.g. `20260917232232:42`                                                                              | Treat as installed and immutable; this design never calls it again after entry.                                                                                                   |

## 1. Recorded Owner Decisions (v1)

| Decision                                                                                                                                                                                   | Rationale                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day end is the end of a published blind level plus completion of already-accepted hands. Never a wall-clock cut of a live hand.                                                            | A hand is committed atomically (`hand_atomic_commits`); cutting it would split custody. The level index is already the durable clock unit.                                         |
| An overnight bag stops the blind clock and persists level index, committed blinds and ante, rule version, remaining level duration, break state and next-stage start (UTC plus IANA zone). | Remaining time is derived today (`TournamentManagerBase.ts:5660-5705`), so a derived clock would burn the whole night. The zone is needed to display and to reschedule across DST. |
| One surviving qualification per player per parent event; no stack aggregation; no second final seat.                                                                                       | Prevents chip minting by buying two flights and prevents one person holding two seats.                                                                                             |
| Re-entry into a later flight only after elimination and only under the published entry policy.                                                                                             | Uses the existing `reentry` operation (`20260917233447:69`) with its rake; no invented economics.                                                                                  |
| A qualified player cannot buy another flight.                                                                                                                                              | Follows from the previous two.                                                                                                                                                     |
| PKO heads carry.                                                                                                                                                                           | Obligations live on the one parent row; the bag snapshots each head for proof.                                                                                                     |
| Mystery Bounty activation is evaluated on the parent event.                                                                                                                                | One inventory, one pool (`mysteryBountyActivation.ts:1-35`).                                                                                                                       |
| Unstarted flight cancellation refunds via the established formula; started events keep never-cancel and recover.                                                                           | `20260910171843:12-35` stays law.                                                                                                                                                  |
| Qualification is a durable entitlement (source entry, source stack, target stage, receipt).                                                                                                | The consumer can restart from its own record (CLAUDE.md 10.12).                                                                                                                    |
| Capabilities `tournament.multi_day.single_flight` (`multi-day-v1`) and `tournament.multi_day.multi_flight` (`multi-flight-v1`), gated by `fn_capability_available(id)` (other lane).       | Creation is gated; running events are never stranded by a capability being withdrawn.                                                                                              |

## 2. Single-Flight: Same Row Across Days vs A Child Row Per Day

### Option A: same row, new status `BAGGED`

Day 1 and Day 2 are stages of one `tournaments` row. Between stages the row is
`BAGGED`. The row is launched exactly once (one `tournament_launch_receipts`
row, unchanged meaning). Each later stage start is a stage-resume receipt.

### Option B: a child row per day (`parent_tournament_id`, `day_number`)

### Evaluation against every guard and trigger

| Authority                                                                               | A: same row                                                                          | B: child row per day                                                                                                                                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_tournaments_refuse_unbuilt_multi_day` (`20260902052302:76-131`)                     | Never touches the 7 columns; the guard can stay forever for the 5 structure columns. | Requires dropping or loosening it for `parent_tournament_id` and `day_number` before any child exists.                                                                |
| `zz_freeze_launch_guard` (`20260908042800:405-426`)                                     | `BAGGED -> RUNNING` is refused today; needs one narrow receipt exemption (S3).       | Child `REGISTERING -> RUNNING` passes with a normal launch receipt.                                                                                                   |
| `trg_tournaments_start_readiness` (`20260906113000:319`)                                | Does not fire (OLD is RUNNING or BAGGED). Pin it.                                    | Fires; child must carry a complete published contract and its guarantee state, which it does not own.                                                                 |
| `zz_ca_fund_overlay_on_lock` (`20260914143521:74`)                                      | Does not fire. Overlay funded once at the real launch.                               | Fires on the child: refits payout depth to survivors and debits the bank for the guarantee again. Money defect.                                                       |
| `tournaments_rank_before_complete`                                                      | Fires once, at the real finish.                                                      | Day 1 row must end somehow; if COMPLETED, `fn_rank_survivors` ranks survivors as finishers and terminal settlement pays them. Needs a new non-terminal status anyway. |
| Launch completion proof (`20260911173003:257-300`)                                      | Unchanged.                                                                           | Child roster must be created with bag stacks: `tournament_players` inserts on a new tournament are new entries to `zz_freeze_entry_guard` and the mint gate.          |
| Escrow, obligations, rake settlement, entry-time attribution                            | Stay on one row; settled once by the existing terminal path.                         | Live on Day 1 row; Day 2 would pay places from escrow it does not hold. Cross-row money movement.                                                                     |
| PKO obligations, Mystery activation receipts (`20260908042000:16`, `:361`)              | Keyed on the one row.                                                                | Heads copied to the child (duplicate obligations); activation evaluated on the child, contrary to the owner decision.                                                 |
| `GameServer.discoverTournaments` ramp and past-start top-up (`GameServer.ts:7101-7200`) | Not REGISTERING, never ramped.                                                       | Child in REGISTERING gets horse-ramped and topped up with fresh paid entries.                                                                                         |
| `atomic_cancel_tournament` (`20260910171843:15`)                                        | Refuses (`started_at` set).                                                          | Unstarted child can be cancelled and would "refund" entries it never collected.                                                                                       |
| `fn_uncollected_entry_check` (`20260902052604:114`)                                     | Unaffected; same funded entries.                                                     | Relies on the blanket later-day exemption.                                                                                                                            |
| `fn_thaw_platform` (`20260908032311:245`)                                               | Skips BAGGED (correct; clock is stored as remaining).                                | Per-row, fine.                                                                                                                                                        |
| `discoverRunningResumes` (`GameServer.ts:8177`, RUNNING page `:8190-8206`)              | Skips BAGGED; a new lane owns resume.                                                | Child resumes as a normal launch.                                                                                                                                     |
| Frozen Spin witness (`20260918122532:27764`)                                            | No new columns; no Spin is ever multi-day.                                           | Same.                                                                                                                                                                 |
| MTT activation witness (`20260918093004:720`)                                           | Touches `tournaments_status_check` and the freeze-guard function.                    | Touches the guard, overlay and launch proof.                                                                                                                          |

**Recommendation: Option A.** B breaks five money authorities (overlay, rank,
escrow, PKO, cancellation) and every fix would be a cross-row money path. A
needs one status value, one guard exemption, and new tables.

### Exact changes for Option A

- **S1** Widen `tournaments_status_check` with `'BAGGED'` (drop and re-add `NOT VALID`, then `VALIDATE` in a later migration). One status covers bagged, scheduled-resume and resuming; the finer state lives in `tournament_stages.state`.
- **S2** New `BEFORE INSERT OR UPDATE OF status` trigger `trg_tournaments_bagged_status_door` (implemented; no row is ever inserted BAGGED): `RUNNING -> BAGGED` only with tx-local marker `app.atomic_stage_bag = <id>:<bag_id>` and an existing bag receipt; `BAGGED -> X` only for `X='RUNNING'` with marker `app.atomic_stage_resume = <id>:<resume_id>` and an incomplete resume receipt. `BAGGED -> COMPLETING/COMPLETED/CANCELLED` refused (55000).
- **S3** `fn_refuse_new_entries_while_frozen` tournaments branch (`20260908042800:405-426`): add a second admitted case beside the launch case: `OLD.status='BAGGED' AND EXISTS (incomplete tournament_stage_resume_receipts row) AND marker matches`. Symmetric with the launch: resume begin takes `pg_advisory_xact_lock_shared(530090,1)` and refuses when `fn_entry_purchases_frozen()`.
- **S3b** (found while implementing) `fn_tournament_live_seat_acquisition_requires_authority`, behind `a0_tournament_live_seat_root_guard` (`20260910173147:310`, attached `20260909014433:1366`), refuses any live tournament seat when the status is not ANNOUNCED, REGISTERING or RUNNING. Seating a resume happens while BAGGED, so it gets the same narrow exemption: BAGGED plus the resume marker plus an incomplete resume receipt. The terminal-authority proof (T or G held exclusively) is still required first.
- **S4** Readiness, overlay and rank triggers: no change; pin with tests (section 7).
- **S5** `startLifecycle` status exclusion (`TournamentManagerBase.ts:4282`) adds `'BAGGED'`. `resumeLifecycle` already returns (`:5450`).
- **S6** TS unions: `src/types/database.types.ts:383`, `server/src/types.ts:1010`, `src/types/club.types.ts:771` (`'bagged'`). Inventory every status-list reader (about 30 `server/src` sites, 44 SQL sites in 202609 migrations) and decide each; required ones: horse-busy predicates (`TournamentRecurringService.ts:5481` and the SQL inside `fn_register_horse_for_tournament`) must treat BAGGED as occupying its horses, and `TournamentRecurringService.ts:3191` live-MTT count must include BAGGED.
- **S7** New tables (section 4) and a `tournament_players` chips fence (S8).
- **S8** `BEFORE INSERT OR DELETE OR UPDATE OF chips, status, current_bounty, tournament_id ON tournament_players` trigger (implemented as `trg_tournament_players_bagged_custody_fence`): when the parent is BAGGED, refuse unless the stage RPC marker is set. This is a correctness fence for the single stack owner, not a detector.

## 3. States, Transitions, Fencing

| Conceptual state   | `tournaments.status`                        | `tournament_stages.state` (current stage)                   | Engine                                           |
| ------------------ | ------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| announced          | ANNOUNCED                                   | planned                                                     | none                                             |
| registering        | REGISTERING                                 | planned                                                     | discovery ramp, launch at start                  |
| running            | RUNNING                                     | running                                                     | manager, level clock                             |
| day-ending         | RUNNING                                     | day_ending                                                  | manager, stage-end pause authority, no new hands |
| bagged             | BAGGED                                      | bagged                                                      | no manager, no lease, no tables                  |
| scheduled-resume   | BAGGED                                      | bagged, next stage `scheduled` with `scheduled_start_utc`   | resume lane timer armed                          |
| resuming           | BAGGED                                      | next stage `resuming` (resume receipt claimed)              | resume consumer seating                          |
| running-next-stage | RUNNING                                     | next stage `running`                                        | manager adopts via `discoverRunningResumes`      |
| completed          | COMPLETING / COMPLETED                      | final stage `closed`                                        | existing terminal path                           |
| cancelled          | CANCELLED (only from ANNOUNCED/REGISTERING) | planned (inert)                                             | none                                             |
| recovery-required  | unchanged (RUNNING or BAGGED)               | `blocked` with a transition receipt naming the failed proof | consumer refuses to proceed                      |

Legal transitions (each one RPC, one transaction, one receipt):

1. `REGISTERING -> RUNNING`: existing launch, unchanged.
2. stage `running -> day_ending`: `fn_begin_stage_end` (lease-fenced).
3. `RUNNING/day_ending -> BAGGED/bagged`: `fn_bag_tournament_stage`.
4. `bagged -> scheduled` (and reschedule): `fn_reschedule_tournament_stage`, generation bump.
5. `scheduled -> resuming`: `fn_begin_stage_resume` (claims lease, writes receipt).
6. `BAGGED/resuming -> RUNNING/running`: `fn_complete_stage_resume`.
7. `RUNNING -> COMPLETING -> COMPLETED`: `fn_complete_tournament_terminal` (`20260917194950:91-120`), unchanged.
8. any stage state `-> blocked`: written by the refusing RPC itself; leaving `blocked` requires the same RPC to succeed on retry after the cause is fixed.

Fencing: every stage RPC holds the `engine_tournament_leases` row with the
caller's `lease_generation` (`20260908042900:19-35`) the way launch does,
locks the `tournaments` row `FOR UPDATE`, takes the maintenance barrier, and
checks the stage `schedule_generation`. The bag releases the lease
(`release_tournament_leases_v2`) in its own transaction so every later request
from that manager is refused by the PostgREST fence.

## 4. Schema (all new tables)

Common to every table: `ENABLE ROW LEVEL SECURITY`; `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role`; `GRANT SELECT TO service_role`; writes only through `SECURITY DEFINER` RPCs owned by `postgres`; FKs `ON DELETE RESTRICT`; receipts append-only via a `BEFORE UPDATE OR DELETE` immutability trigger and a `BEFORE TRUNCATE` refusal; `transaction_id xid8 DEFAULT pg_current_xact_id()` on every receipt, like `20260917233447:65`.

1. **`tournament_stage_plans`**: `tournament_id uuid PK`, `capability_id text CHECK IN (the two ids)`, `abi text CHECK IN ('multi-day-v1','multi-flight-v1')`, `rule_version text NOT NULL`, `time_zone text NOT NULL` (validated against `pg_timezone_names` at seal), `stage_count int CHECK 2..14`, `plan_hash text`, `sealed_at`, `sealed_by`. Immutable once sealed; sealing refused once any `tournament_players` row exists.
2. **`tournament_stages`**: `PK (tournament_id, stage_no)`; `kind CHECK IN ('flight','day')`; `day_no int`, `flight_label text NULL`; `end_after_level int NULL` (NULL only on the final stage); `scheduled_start_utc timestamptz`, `schedule_generation bigint NOT NULL DEFAULT 1`; `state CHECK IN ('planned','registering','running','day_ending','bagged','scheduled','resuming','closed','cancelled','blocked')`; `state_changed_at`. Mutable only by stage RPCs (marker-checked trigger). Index `(state, scheduled_start_utc) WHERE state='scheduled'` for the resume lane.
3. **`tournament_stage_transitions`** (receipts): `id uuid PK`, `tournament_id`, `stage_no`, `kind CHECK IN ('seal','day_end','bag','reschedule','resume_begin','resume_complete','qualify','merge','cancel_unstarted','blocked')`, `idempotency_key text UNIQUE`, `lease_generation uuid NULL`, `schedule_generation bigint`, `actor text`, `facts jsonb NOT NULL`. Index `(tournament_id, stage_no, created_at)`.
4. **`tournament_stage_clock_snapshots`**: `PK (tournament_id, stage_no)`; `bag_id`; `level_index int`, `small_blind`, `big_blind`, `ante` (copied from `blind_level_state`, `20260913200859:62-63`), `rule_version`, `level_duration_ms bigint`, `remaining_level_ms bigint CHECK >=0`, `next_level_index int`, `break_state jsonb` (on_break, break_started_at, break_ends_at, add-on window), `next_stage_start_utc`, `next_stage_zone`, `blind_state_hash text`.
5. **`tournament_stage_bag_watermarks`**: `PK (tournament_id, stage_no, table_id)`; `last_hand_number bigint`, `last_hand_id uuid` (from `hand_atomic_commits`), `seat_stack_sum numeric`, `seat_count int`. This is the provenance watermark: a bag is only valid over these exact commits.
6. **`tournament_stage_bags`**: `id uuid PK`; `UNIQUE (tournament_id, stage_no, registration_id)`; `user_id`; `stack numeric CHECK >0`; `bounty_head numeric CHECK >=0`; `source_table_id`, `source_seat_id`, `source_seat_number`; `watermark_hand_number`; `bag_id` (the transition). Immutable.
7. **`tournament_qualification_entitlements`**: `id uuid PK`; `tournament_id`, `user_id`, `source_stage_no`, `source_registration_id`, `source_bag_row_id UNIQUE`, `source_funding_receipt_ids uuid[] NOT NULL` (from `tournament_participant_funding_receipts`), `stack`, `bounty_head`, `target_stage_no`, `state CHECK IN ('active','consumed','void')`, `consumed_by uuid NULL`, `consumed_seat_id uuid NULL`. `CREATE UNIQUE INDEX ... (tournament_id, user_id) WHERE state IN ('active','consumed')` enforces one surviving qualification and no second final seat. The only permitted update is `active -> consumed` once (trigger).
8. **`tournament_stage_resume_receipts`**: `PK (tournament_id, stage_no)`; `resume_id uuid UNIQUE`; `lease_generation uuid`; `schedule_generation bigint`; `claimed_at`; `completed_at NULL`. Same immutability contract as `20260908042800:1049-1075`.
9. **`tournament_flight_memberships`** (multi-flight only): `id PK`; `tournament_id`, `user_id`, `registration_id`, `flight_stage_no`, `funding_receipt_id UNIQUE`, `operation CHECK IN ('entry','reentry')`, `state CHECK IN ('registered','playing','eliminated','qualified','refunded')`. `UNIQUE (tournament_id, user_id) WHERE state IN ('registered','playing','qualified')` enforces "re-entry only after elimination" and "a qualified player cannot buy another flight".

Client read path: `ca_tournament_stage_view(p_tournament_id)` `SECURITY DEFINER`, granted to `authenticated`, returns the public schedule, stage state, counts and bag totals, and only the caller's own bag, entitlement and seat.

## 5. Transactions

All are one transaction, idempotent on a caller-supplied key, and return the
stored receipt on replay.

**Stage plan seal** `fn_seal_tournament_stage_plan(t, plan jsonb)`: caller must pass `fn_can_create_games`; requires `fn_capability_available(capability_id)`; validates: stages ordered, final stage has `end_after_level IS NULL`, Day 1 `end_after_level` greater than `late_reg_levels` and every add-on level (so no entry window or add-on deadline crosses a bag), start times strictly increasing and at least one level duration apart, zone valid. Writes plan, stages, `seal` receipt, and (from R6 on) `is_multi_day=true, total_days=<day count>`.

**Day-end intent** `fn_begin_stage_end(t, lease_gen, stage_no, ended_level)`: requires `status='RUNNING'`, stage `running`, `current_level = end_after_level`, and not a final stage. Sets stage `day_ending`; writes `day_end` receipt with the level and the committed `blind_level_state`. It does not touch `on_break` and does not publish. Replay returns the receipt. The manager arms the stage-end pause authority only after this commits, so a restart always finds the intent.

**Bag** `fn_bag_tournament_stage(t, lease_gen, stage_no, table_watermarks jsonb)`:

1. Maintenance barrier; refuse `frozen` if `fn_platform_frozen()` (retry after the thaw; nothing moves).
2. Lock lease `FOR UPDATE` with generation, tournament `FOR UPDATE`, all live tournament tables in id order (same order as `20260913200859:78-81`).
3. Proof, all or nothing: no `hand_state_snapshots` with `is_complete=false` on any tournament table; for each table the supplied watermark equals `max(hand_number)` in `hand_atomic_commits`; every live seat's `stack` equals that seat's value in the last commit's `stack_result`; `sum(table_seats.stack)` over live seats equals the sum of watermark sums; no pending satellite qualifier boundary, deal review, or bounty obligation unsettled beyond the PKO watermark (`20260908042000:390-395`).
4. Single stack owner: insert one bag row per live seat (stack from the felt, never the mirror, per `20260918093004:436-446`; `bounty_head` from the player's bounty obligation state); set each seat `left_at=now()` through the existing tournament seat authority; set `tournament_players.chips` = bag stack with the stage marker; close tables through `fn_close_empty_tournament_table` (`20260908043300:136`).
5. Write clock snapshot: `level_index=end_after_level`, `remaining_level_ms=0`, `next_level_index=end_after_level+1`, break state (a synchronized break in progress is closed by the bag: `on_break=false, break_ends_at=NULL`), next stage start.
6. Write one entitlement per bag row targeting the next stage; stage `bagged`, next stage `scheduled`; `status='BAGGED'` with marker; release the lease.
7. Invariant checked before commit: `sum(bags.stack) = pre-bag live total`, `count(bags) = active players`, `sum(bounty_head)` equals the open PKO heads. Any failure raises; the manager writes `blocked` in a separate transaction with the failed proof.

**Reschedule** `fn_reschedule_tournament_stage(t, stage_no, new_start_utc, zone, expected_generation)`: operator (`fn_can_create_games`); only when stage `scheduled` and no resume receipt; new start in the future; `schedule_generation += 1`; `reschedule` receipt. A timer or wake carrying the old generation is refused by `fn_begin_stage_resume`, so it invalidates itself.

**Resume begin** `fn_begin_stage_resume(t, stage_no, resume_id, schedule_generation, lease_gen)`: consumer has claimed the lease via `claim_tournament_lease_v2`; maintenance barrier and frozen refusal; requires `BAGGED`, stage `scheduled`, `now() >= scheduled_start_utc`, generation match. Overdue is not an error: it resumes when it can, and the clock is restored relative to the actual resume, so no player loses time. Inserts the resume receipt; stage `resuming`; sets `current_level=next_level_index` and `blind_level_state` from the rule version so every table created next inherits the Day 2 blinds (`20260913200859:127-146`). Replays with the same `resume_id` adopt the receipt and rotate its lease generation exactly as launch does (`20260917062000:287-307`).

**Seat once** `fn_seat_stage_entitlement(t, resume_id, lease_gen, entitlement_id, table_id, seat)`: requires the incomplete resume receipt; entitlement `active`; mirror equals entitlement stack; marks the entitlement `consumed` with the seat id. Replay returns the existing seat. Seat draw is random per rule version, horses and humans in the same draw. CORRECTION (implementation): it cannot call `fn_ca_assign_tournament_player_seat_locked`, which refuses any status other than REGISTERING or RUNNING (`20260918093004:399-404`). It writes the seat itself, with that function's complete column shape, the bag's `club_id` and `horse_id` (entry-time identity is never re-derived), a fresh 30-second / four-use time bank, and its own mint check: live stacks plus this stack may not exceed the stage's entitled total.

**Resume complete** `fn_complete_stage_resume(t, resume_id, lease_gen)`: proves every entitlement for the stage is consumed, `count(live seats)=count(entitlements)`, `sum(live stacks)=sum(entitlement stacks)`, bounty heads unchanged; then sets `level_started_at = clock_timestamp() - (level_duration_ms - remaining_level_ms)` (for v1 remaining is always the full next level), `status='RUNNING'` with marker, receipt `completed_at`, stage `running`, previous stage `closed`. The existing manager admission then adopts the RUNNING row via `resumeLifecycle`, whose derived clock equals the persisted remaining.

**Qualification (multi-flight)**: identical to the bag; the entitlement's `target_stage_no` is the merge day. Registration into a flight writes the membership row in the same transaction as the core registration.

**Final merge (multi-flight)**: the merge day's resume is the same begin/seat/complete sequence over entitlements from several source stages. Consume-once is the partial unique index plus the `active -> consumed` trigger. Proof at complete: `sum(consumed stacks) = sum(bag stacks of qualified players)`; the total chips in play equal the entry-derived total minus nothing (busted players hold zero); bounty heads sum equals open PKO heads; `tournament_obligations` and `tournament_escrow` for the parent are untouched (one economic event).

**Cancellation**: unstarted single-flight events cancel through the existing path unchanged; stage rows stay `planned` and are inert because the row is CANCELLED. Started events never cancel (BAGGED has `started_at` and a completed launch receipt). Multi-flight unstarted flight: `fn_cancel_unstarted_flight` refunds each `registered` membership of that flight through the same per-entry refund computation `atomic_cancel_tournament` uses (receipt table `20260909014444:537`), writing `cancel_unstarted`; refused once the flight's stage has left `registering`.

**Operator transfer and union change**: no stage RPC writes `club_id`, `union_id`, `is_private`, `is_xmtt`, fee or attribution columns. Entitlements carry `source_funding_receipt_ids`, so completion-time `fn_settle_tournament_rake` keeps reading the entry-time attribution captured at registration. A club changing operator, agent or union between stages changes nothing about this event. `is_xmtt` stays a union marker only.

## 6. Engine Hook Points And The New Pause Authority

New pause authority `stageEndPause` in `TournamentManagerBase`, independent of
the three existing ones (`onBreak`, add-on `addOnBreakOwnsPause`,
hand-for-hand), per CLAUDE.md 13 invariant 2 (whoever paused resumes).

- `advanceBlindLevel` (`TournamentManagerBase.ts:7214`): before building the publication at `:7419`, if the cached plan says `prevLevel === stage.end_after_level` and a next stage exists, call `fn_begin_stage_end`, set `stageEndPause`, and return without publishing. The level clock stays unarmed.
- `prepareManagedTableEngineForPlay` (`:1202-1226`): a replacement engine inherits `stageEndPause` as `engine.pauseAfterHand(..., { beforeNextHand: true, untilResumed: true })`, same as `onBreak` at `:1209-1214`.
- Stage-end barrier: when every table reports idle after its last accepted hand, the manager reads each table's last committed hand and calls `fn_bag_tournament_stage` with the watermarks. On success it releases its engines through the existing close path and stops (`stop()` `:5975`). On `frozen` it waits for the thaw notification and retries the same call.
- `pauseForBreak` (`:2250`): refused while `stageEndPause` is set; the bag closes any break already in progress.
- `resumeLifecycle` (`:5431`): after reading the row, read the stage tables; if the current stage is `day_ending`, set `stageEndPause` before `startEliminationChecker` and before any engine can deal, and do not arm the blind timer.
- `startLifecycle` (`:4282`): exclude BAGGED.
- Elimination sweep (`TournamentManagerEliminations`): unchanged; busts in the final accepted hands are processed before a table counts as idle.
- New `GameServer.discoverStageResumes` lane, started beside `discoverRunningResumes` (`GameServer.ts:3414-3416`): pages BAGGED rows with a `scheduled` stage (same `fetchAllRows` keyset as `:8190-8206`), arms one timer per due time, and on due admits a manager in a `resumeStageLifecycle` mode that runs resume begin, seat, complete, then continues as the running manager. The timer only wakes; the receipt is the state. This is the "schedule is the product" case of CLAUDE.md 10.12.
- Horse availability: BAGGED counts as occupied (S6).

**What the :55 restart does to a bagged event.** At :53 nothing happens: a
bagged event has no tables to park. The engine restarts; `discoverRunningResumes`
ignores BAGGED; `discoverStageResumes` re-reads its rows and re-arms timers.
`fn_thaw_platform` does not touch BAGGED rows (`20260908032311:245`), and the
bag's clock is a stored remaining duration, so nothing is shifted or burned.
A resume due between :55 and :00 is refused by the barrier and runs right after
the thaw. A resume that was mid-seating when the break came is re-driven from
its receipt by the next manager, exactly like an interrupted launch. A day-ending
event at :55 is a normal RUNNING row: the new manager re-arms `stageEndPause`
from the `day_end` receipt and bags after the thaw.

v1 adds no new wall-clock deadline a player can lose to. If a later rule adds one
(for example a "present by" check-in), it goes into `fn_thaw_platform` in the
same change.

## 7. Client Surfaces (existing routes only)

- `clubs/:clubId/create-table/:gameType` (`TableConfigPage.tsx:1611-1631`): replace "NOT AVAILABLE YET" with a live Multi-Day MTT switch shown only when `fn_capability_available` says yes; a Day Schedule editor (Day, Ends After Level, Starts At, Time Zone) that submits through the seal RPC. Title Case labels, no em dashes.
- `tournaments` lobby (`TournamentLobbyPage.tsx:380`, `:608`): badge from the stage view; a BAGGED card reads "Day 1 Complete" and "Day 2 Starts Sat 12:00 PM CDT"; chip counts via `.toLocaleString()`.
- `tournaments/:tournamentId` (`App.tsx:988`; `DetailOverviewTab.tsx:463`, `:601`): Stage Schedule, Your Bag (chips and bounty), Chip Leaders after the bag, and after resume "Your Day 2 Seat: Table 4, Seat 7" with an Open Table button. The client never switches tables or navigates by itself (CLAUDE.md 10.6); alerts only.
- `table/:tableId`: after the final accepted hand's animations complete (they always play), a Day Complete sheet with the bag and next start. The table then shows closed; the multi-table layer (`App.tsx:2323`) must not move `activeIndex`.
- `clubs/:clubId/table-management`: Reschedule Day 2 (only while scheduled) and a Needs Attention state for `blocked`, naming the failed proof.

## 8. Test Plan

**Database (PostgreSQL 17 runner, same harness as `tests/sql/README.md` and `scripts/ci/run-diamond-sql-acceptance.py`):**

- Guard: all 7 columns still refused before R6; after R6 badge columns refused without a sealed plan, admitted with one; structure columns always refused.
- Status door: every illegal edge into or out of BAGGED refused; `BAGGED -> RUNNING` without receipt raises `TOURNAMENT_LAUNCH_RECEIPT_REQUIRED`.
- Pins: resume does not fire readiness, overlay (bank balance unchanged, payout_structure unchanged) or rank; completion after two stages ranks once.
- Bag proofs: in-flight hand refuses; watermark mismatch refuses; mirror overwrite while BAGGED refused; stale lease generation refused; replay returns receipt.
- Seat once: double seat, stale `resume_id`, stale schedule generation all refused; mint gate never trips.
- Thaw: BAGGED row unchanged by `fn_thaw_platform`; RUNNING next stage shifted as usual.
- Never cancel: `atomic_cancel_tournament` refuses BAGGED; unstarted flight refund equals the established per-entry refund.
- Accounting identity after a full two-day run: escrow, obligations, rake settlement and entry-time attribution equal a one-session control of the same field and hands; union change and agent change between stages leave settlement identical.

**Engine (vitest, `server/`):** stage-end pause inherited by replacement engines; no level publication past `end_after_level`; `pauseForBreak` refused while day-ending; `startLifecycle` refuses BAGGED; horses bag and resume through the same code path as humans.

**Restart at every boundary** (kill the manager, adopt with a new lease generation, assert exact outcome): (1) after day-end receipt, (2) one table mid-hand, (3) all idle before bag, (4) bag committed and response lost, (5) BAGGED across a :55 break, (6) resume begin committed with no seats, (7) partial seating, (8) all seated before complete, (9) complete committed and response lost, (10) first hand of the next stage. Repeat 1, 3, 6 and 8 inside a freeze.

**Laws (each with `docs/laws.d/<name>.md`):** `multi-day-stack-continuity.law.test.ts` (bag sum equals felt, resume sum equals bag); `multi-day-horses-identical.law.test.ts`; `multi-day-one-qualification.law.test.ts`; extend `tests/no-auto-table-switch.law.test.ts` for the Day 2 seat alert; keep `tests/unit/tournamentsNeverCancel.test.ts` green; update `tests/unit/theCreateTableFormOffersOnlyLiveSwitches.test.ts` and `tests/unit/TournamentFromTableConfig.test.ts` in the same change as the switch.

**Acceptance scenarios (test fixtures only, never production real chips, CLAUDE.md 11.5):** (a) two-day single flight, humans and horses, guarantee with overlay, PKO; bag after level 12; resume next day 12:00 America/Chicago; exact stacks, heads and final payouts. (b) Mystery Bounty activating on Day 2 from the parent pool. (c) Satellite awarding seats into a multi-day target before its registration closes. (d) Reschedule twice; old wakes ignored. (e) Engine outage past the scheduled start; resume on recovery with the full level. (f) Multi-flight 1A and 1B: bust in 1A then re-enter 1B; qualified 1A player refused in 1B; merge; unstarted 1C cancelled and refunded.

## 9. Ordered Additive Release Plan

Each migration: reserved with `scripts/reserve-migration-version.sh`, one
transaction, `SET LOCAL lock_timeout`, never applied :50 to :03 UTC.

- **R0 Preflight (no code):** confirm production `ca_mtt_admission_contract.abi`. If still `legacy-capacity-v1`, activation must land first or its witness must be re-prepared, because S1 and S3 touch pinned objects. Verify the legacy `tournament_flights` table and its `FOR ALL USING (true)` policy; lock it down in its own reviewed migration. Confirm `fn_capability_available` is installed.
- **R1** New tables, indexes, immutability triggers, privileges. Inert.
- **R2** Client and engine releases that understand `BAGGED` (unions, readers, horse-busy predicates, `startLifecycle`). Must be served before any row can be BAGGED.
- **R3** `tournaments_status_check` widened (`NOT VALID`); status door trigger; `tournament_players` chips fence. R3b: `VALIDATE CONSTRAINT`.
- **R4** Freeze-guard exemption for stage resume (S3) and the live-seat acquisition exemption (S3b).
- **R5** Stage RPCs and `ca_tournament_stage_view`; engine release with `stageEndPause`, `discoverStageResumes`, `resumeStageLifecycle`; client surfaces hidden until a plan exists. Engine activation in a certified window.
- **R6 Guard replacement, and only here:** after R1 to R5 are live and the database and restart suites pass, one migration replaces `fn_tournaments_refuse_unbuilt_multi_day`: the five structure columns stay refused unconditionally (this design never uses them); `is_multi_day`/`total_days` are admitted only when a sealed plan exists, its day count equals `total_days`, and its `capability_id` passes `fn_capability_available`. Same seven-column trigger. Same commit updates the `fn_uncollected_entry_check` note to say the later-day exemption is unreachable by design (one row). Until R6 the old guard itself refuses the seal RPC's badge write, so no multi-day event can exist early.
- **R7 Multi-flight (`multi-flight-v1`), separately reviewed**, because it needs changes to pinned money authorities: (M1) a flight registration door in the registration core beside late reg (`20260917233447:948-953`); (M2) later flights start through the stage-resume path with fresh starting stacks, v1 sequential flights only; (M3) payout depth and overlay committed once at the parent's final entry close instead of at the first flight's launch (`zz_ca_fund_overlay_on_lock` stands down for multi-flight plans), with `prize_pool_finalized` held until then so Mystery activation reads the whole parent pool; (M4) unstarted flight refund.

## 10. Open Owner Questions And Risks

Questions:

1. Should a stage be allowed to end on a player count ("play to 15% of the field") instead of a level? v1 says level only.
2. Resume after a long outage: resume whenever able (v1 default) or require operator confirmation beyond a tolerance?
3. Players absent at resume are dealt in and blinded like any absentee. Confirm.
4. A :55 break in progress at day end is closed by the bag (the night supersedes it). Confirm.
5. Day 2 seating: full random redraw (v1) or keep Day 1 tables where possible?
6. Multi-flight: are concurrent (overlapping) flights needed? v1 is sequential. Is late registration into Day 2 ever allowed? v1 refuses.
7. Final table deals and satellite bubbles never span a bag. Confirm that a deal review open at day end blocks the bag.

Risks:

- Sequencing against the MTT activation witness is load-bearing (R0).
- The legacy `tournament_flights` table may still carry a permissive policy in production.
- The status reader inventory is broad; a missed `status='RUNNING'` reader that means "live" could treat a BAGGED event as finished (for example horse availability).
- `union_id` was not found in the managed-lifecycle protected keys list (`20260902050100:25-37`); verify that nothing can change it on a registered event.
- Adding triggers to `tournament_players` must be checked against any activation witness that enumerates that table's triggers.

## 11. Implementation Notes (database R1, R3, R3b, R4 and R5 RPCs, 2026-09-24)

What was built, and where it differs from sections 2 to 9. Harness: `scripts/ci/test-multi-day-stage-foundation.py` (25 cases, real PostgreSQL).

- **Migrations.** `20260924043217` (the eight stage tables, R1), `20260924043224` (BAGGED added NOT VALID, the status door, the custody fence, both resume exemptions, R3 and R4), `20260924043232` (VALIDATE, R3b), `20260924043239` (seven service-role RPCs, R5 database half). They must install after `20260924025555` (the capability registry): that migration requires the seven-status vocabulary exactly, and every RPC asks `fn_capability_available('tournament.multi_day.single_flight')`.
- **R0 is enforced, not only documented.** `20260924043224` refuses unless `ca_mtt_admission_contract.abi = 'unlimited-mtt-v2'`, and it refuses unless the live `md5(prosrc)` of both patched functions equals the newest repository definition. The owner confirms both live md5s before installing.
- **Entitlements** carry `source_registration_id` (the key `tournament_participant_funding_receipts` is written against) instead of a copied array of funding receipt ids. Settlement keeps reading the entry-time attribution it already reads.
- **The first level of a resumed stage is supplied by the engine** at resume begin (`first_level`: index, blinds, ante, duration) and checked against the snapshot's `next_level_index`, because the engine derives levels past the persisted structure (`resolveBlindLevel`) and the database cannot. It is the same trust `fn_publish_tournament_blind_level` already places in the engine.
- **Seal** is service-role only in this release and never writes `is_multi_day` or `total_days`; the badge columns stay refused by the unbuilt guard until R6. It refuses a plan whose first day ends at or before the last late-registration, rebuy or add-on level.
- **Not built here:** the `blocked` stage state and its receipt writer (RPCs return their refusal reason; the engine lane records a refusal it cannot retry), `tournament_flight_memberships` (R7), the client read RPC `ca_tournament_stage_view` and the operator reschedule door (R5 client work; it must wrap the service-role RPC with its own `auth.uid()` check).
- **Production triggers the harness does not carry**, which the bag or resume passes through and which a dry run on a copy of the production schema must exercise before install: `smarter_private.f06_source_guard` (`a00_f06_source_seat`, `a00_f06_source_roster`, which refuses seat moves on a table with an unacknowledged F06 operation; the bag then rolls back and nothing moves), `aa_tournament_live_seat_proof_lock`, `aa_tournament_player_launch_proof_lock`, `trg_ca_guard_seat_creation` (it admits engine callers), `trg_tables_managed_lifecycle_guard`, `trg_tournament_table_close_requires_empty`, and the other status triggers on `tournaments` listed in the MTT activation witness.
