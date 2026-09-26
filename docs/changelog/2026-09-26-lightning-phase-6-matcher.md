# Lightning Phases 6 And 7: The Matcher Explains Every Idle Player, And The Blinds Rotate Fairly

**Migration:** `supabase/migrations/20260926080332_lightning_phase_6_and_7_the_matcher_explains_every_idle_play.sql`
**Harness:** `scripts/dev/test-lightning-phase6-matcher.sh` (Postgres 17, port 55552, 20 sections, includes the Phase 7 fairness simulation)
**Fixture:** `scripts/dev/fixtures/lightning-phase6-matcher-fixture.sql`
**Static suite:** `tests/lightning-phase-6-matcher.test.ts`
**Schema fragment:** `scripts/ci/schema-manifest.d/lightning-phase6-matcher.json`
**Status:** built and proved locally, on top of remediation two (20260926072527, 20260926072551, 20260926072615 and 20260926072638). Not applied to production; the owner applies it after those four.

## Why

Phase 9 built the formation barrier and remediation two anchored the pool to the seat, but nothing decided who plays with whom. The engine's Lightning worker needs one database matcher that it can run in shadow and then in earnest: legal players only, as many hands as the pool allows, big blinds that rotate fairly, a queue nobody can jump, fewer repeat opponents when the pool is big enough, and a reason for every player who is not dealt in. This file is that matcher, and the Phase 7 simulation that proves the blinds converge.

## What It Adds

### Configuration: `fn_lightning_config(p_cluster_id uuid) RETURNS jsonb`

Every matcher tunable, read from `cash_games.ruleset_snapshot -> 'lightning'`, with a default for each and no default anywhere else: `matcher_version` ('m1'), `worker_mode` ('off', 'shadow' or 'form'; default 'off'), `pass_interval_ms` (1000), `pass_time_budget_ms` (750, never above the interval), `keepalive_interval_ms` (5000), `instance_min` (2), `instance_target` and `instance_max` (the table size: 6 at 6-max, 9 at 9-max), `reservation_ttl_ms` (20000), `form_window_ms` (45000), `deal_window_ms` (600000), `recent_opponent_window_hands` (60) and `recent_opponent_window_seconds` (900), the diversity bands `diversity_thin_min`, `diversity_medium_min` and `diversity_large_min` (defaults OFF, ON and twice ON from the population's own threshold reader, `fn_cash_cluster_lightning_thresholds`: 12/18/36 at 6-max, 18/27/54 at 9-max), `diversity_weight_large` (1) and `diversity_weight_medium` (0.5), thin and tiny weights fixed at zero by rule, `multi_table_limit` (4), `admission_batch_hands` (32 hands per pass), `max_replans` (3), `first_entry_rule` ('any_seat' or 'big_blind') and `position_fairness` (true). A wrong type falls back to the default, an out-of-range number is clamped, bands out of order are reset, and each is listed under `invalid`.

### P0 Legality: `fn_lightning_player_legality(p_cluster_id uuid, p_now timestamptz, p_disconnected uuid[])`

One row per open pool session of the Cluster, `RETURNS TABLE (player_id, pool_session_id, pool_slot_id, legal, reason_code, detail)`, and exactly one first-failing reason from one ordered CASE: CLUSTER_NOT_LIGHTNING, CLUSTER_FROZEN, LIGHTNING_DISABLED, PLATFORM_FROZEN, WRONG_EPOCH, SESSION_CLOSED, POOL_SESSION_NOT_ACTIVE, CASHOUT_PENDING, ANCHOR_LEFT, SITTING_OUT, NO_STACK, RESTRICTED, RG_EXCLUDED, DISCONNECTED, ALREADY_RESERVED, IN_HAND, SLOT_NOT_OPEN, MULTI_TABLE_LIMIT. It reuses the estate's checks instead of copying them: `fn_lightning_anchor_is_live_eligible` (it has the last word on the anchor), `fn_lightning_pool_stack`, `fn_lightning_player_in_hand`, `fn_platform_frozen()`, `fn_ca_player_restricted(player, 'cash')` gated by `ca_operator_policy.restrictions_enforced` exactly as the `table_seats` door `fn_ca_refuse_restricted_entry` gates it, and `fn_rg_require_not_excluded`. Every name was checked against the production catalogue first. Legal implies barrier-legal: every fact the barrier re-checks is one of these reasons.

### P1 Group Sizes: `fn_lightning_group_sizes(legal, min, target, max) RETURNS integer[]`

The fewest instances that seat every legal player inside [min, max] (P6: no unnecessary instance), choosing among feasible group counts the one whose average is closest to the target, then sizes within one of each other, larger first. With the default minimum of two, every count from 2 up is fully seated in ceil(n / max) hands: 13 at 6-max is 5/4/4, 7 is 4/3, 19 at 9-max is 7/6/6. Below the minimum there is no hand, never a lone seat. When no split seats everyone (only a configured minimum above two can cause it, for example a minimum of 4 over 7 players), the most players that can be seated are seated in full groups and the rest wait as WAITING_FOR_FORMATION (GROUP_SIZING), last in queue order.

### The Planner: `fn_lightning_match(p_cluster_id uuid, p_now timestamptz, p_disconnected uuid[], p_matcher_version text) RETURNS jsonb`

STABLE, writes nothing, deterministic for a snapshot. Output exactly `{matcher_version, generated_at, legal_count, groups: [{players, bb, keys}], diagnosis: [{player_id, state, reason_code}], pool_diversity_score}`. `players` is the order to hand the barrier: big blind, small blind, then seat 3 onward with the button last. Its body is `fn_lightning_match_plan`, which the writer calls with its own capacity. The priorities are lexicographic, never one weighted formula:

- **P1** sizes from the legal count, capped by the admission batch.
- **P2** the k big blinds are the first k legal players in `fn_lightning_blind_order`, the barrier's own key, so each group's big blind is P2-first inside it. Of the players seated this pass, the next k in that order are the small blinds, one to a group (the classical orbit: the small blind is next due for the big blind), which is also the barrier's own P2-second in each group.
- **P4** the other seats go to the remaining legal players in queue order: `lightning_pool_slot.idle_since`, then `lightning_pool_session.entered_at`, then `cash_player_session.opened_at` (the Cluster join), then `player_id`.
- **P5** only among the players seated this pass, who are all served now and so are P4-equivalent: each is placed in the group with the fewest recent encounters (from `lightning_hand_player` in the Cluster's most recent hands), but moved from the group plain P4 order would give only when weight times encounters saved is at least one. Large pools weigh 1, medium 0.5, thin and tiny 0, so a thin pool is formed exactly as P4 alone forms it. A move never changes a group size, so no hand is ever starved.
- **P3** advisory and last: inside a formed group it orders only the non-blind seats, from the button backward, each seat to the member who has held that position least (`lightning_blind_ledger` btn, co, hj and utg counts). It never changes membership or blinds and never delays anything.
- **P6** every group is a new instance; nothing is merged into a committed hand.

Every open-pool player is diagnosed exactly once: MATCHED if and only if grouped; else WAITING_FOR_PLAYERS (fewer legal players than the minimum), WAITING_FOR_BB (the optional big_blind first-entry rule holds a newcomer, only while holding them costs the pass no hand), WAITING_FOR_FORMATION (PASS_CAPACITY or GROUP_SIZING), WAITING_FOR_RECONNECT (DISCONNECTED) or BLOCKED_WITH_REASON with the P0 code. `pool_diversity_score` is the share of within-group pairs with no recent encounter.

### The Writer: `fn_lightning_match_and_form(p_cluster_id uuid, p_now timestamptz, p_disconnected uuid[], p_max_hands integer, p_request_id uuid) RETURNS jsonb`

Forms only when the Cluster's `worker_mode` is 'form'. Takes the Cluster row `FOR UPDATE SKIP LOCKED` (a concurrent pass answers `pass_in_progress` at once), plans, and forms each group through `fn_lightning_form_hand` with the group's big blind, a request id derived from the pass's (`md5(request_id || '/matcher_group/' || n)`), and a formation time one microsecond after the previous group's. Re-plans after a retryable refusal up to `max_replans`; stops at once on `formation_invariant_failed` (the barrier has frozen the Cluster, and the freeze commits); bounded by `p_max_hands`, the admission batch and the time budget. Writes one `matcher_assignment` event per hand and one `matcher_pass` event per pass (counts per state and per reason, never a row per player), both with `matcher_version` and `request_id`, and records the pass in the new append-only `cash_cluster_matcher_pass` under its request id; a retried request id is answered from there and forms nothing.

### `lightning_pool_slot.idle_since`

P4's first key. NOT NULL, backfilled from each slot's released reservations, never before `opened_at`. It starts at `opened_at` (`trg_matcher_slot_idle_since_starts_at_open`, because a column default cannot name another column) and moves forward to `resolved_at` whenever one of the slot's reservations is released or expires (`trg_matcher_reservation_end_marks_the_slot_idle`, AFTER UPDATE OF state).

### `lightning_reservation_active_by_player`

A partial index on `player_id` for live reservations, for the MULTI_TABLE_LIMIT count of a player's live hands in other Clusters.

## Decisions That Differ From The Brief

1. **No `fn_lightning_blind_ledger_record_hand`.** The barrier already writes the ledger at formation (`bb_count`, `sb_count`, the four position counts, `last_bb_at`, `last_sb_at`, `last_button_at`, `hands_since_bb`, `hands_since_sb`), because the blinds are assigned there and are immutable afterwards. A second write at completion would count every blind twice. The simulation completes every hand through the real terminal path (`fn_lightning_instance_begin_dealing`, then settling, then complete), which releases the reservations and now stamps `idle_since`.
2. **No second responsible-gaming reader.** `fn_rg_require_not_excluded` does not raise for an exclusion; it answers `{ok: false, error: 'self_excluded' | 'cooling_off'}`. P0 calls it directly, and the harness pins RG_EXCLUDED to it across seven row shapes.
3. **`idle_since` is kept by triggers, not by editing the release trigger and the slot opener.** The reaper's expiry is a second road back to the pool that the release trigger never sees. One trigger on the row that records the end covers both, and no existing function body is touched.
4. **An internal planner, `fn_lightning_match_plan(..., p_max_groups integer)`.** `fn_lightning_match` is exactly the contract; the writer calls the planner with its own `p_max_hands` so P5 never trades a player across the boundary between hands formed and hands not formed this pass, which would break P4.
5. **An extra P0 reason, POOL_SESSION_NOT_ACTIVE,** for a pool session in 'joining' or 'eligibility_check', which the barrier refuses and the brief's list did not name.
6. **Small blinds by P2 too, and one microsecond per group.** Measured in the simulation before this was added: the small blind went to whoever happened to rank next inside each group, and 60 rounds of 18 players gave small-blind counts from 5 to 15; and with every big blind of a pass stamped at one instant, the next P2 tie-breaks re-sorted each batch by `player_id`, so 60 rounds of 50 players left a cohort on 12 big blinds against another on 10. With both, every count is within one.
7. **The pass record is its own table,** not an index on `cash_cluster_events` (325,598 rows, 141 MB, hot): building an index there holds a SHARE lock for the whole scan.
8. **Variant, stake, table size and rule snapshot are not re-checked per player.** They are properties of the Cluster row every pool session is keyed to; the harness proves every open pool session's anchor table, cash-session scope, variant and stakes are its own Cluster's, and that legality never lists another Cluster's session.
9. **The P5 memory is the Cluster's most recent hands** (up to `recent_opponent_window_hands`, no older than `recent_opponent_window_seconds`), read through the existing `lightning_hand_by_cluster_epoch` index and the `lightning_hand_player` primary key, so no new index on `lightning_hand_player` is needed.

## Corrections

Two predecessor proofs are exact lists and become false, by design, when the planner's P0 reads the platform freeze: `p9#3` (20260925215731, proof 3) and `p9r#12` (20260926023047, proof 12), each "the fn*lightning* functions whose body names fn_platform_frozen are exactly the five writers". The readers are now those five and `fn_lightning_player_legality`, which writes nothing. Section 01 of the harness proves that exactly these two, and no other of the predecessor proofs, change truth when this file is applied, and re-proves their intent as containment: the five writers still refuse during the freeze and nothing on the recovery path asks it.

## How It Was Proved

`bash scripts/dev/test-lightning-phase6-matcher.sh` builds the real chain on Postgres 17, converts every Cluster through the real conversion, and reports twenty sections: predecessor proofs and the backfill; configuration; every P0 reason one fact from legal for a human and a horse; the diagnosis in every state; group sizes for every count 0 to 60 at six configurations; the barrier forming every planned group with the planned blinds and button; P4 key by key; P5 in a large pool against its P5-off twin and in a thin pool; P3; determinism across two backends; the writer (dark by default, events, pass record, idempotency, bounds, race re-plan, freeze); concurrency in one process through a second backend and across two real psql processes; Law 10.5; spec Phase 4 acceptance (6-max 17 stays, 18 converts and one pass forms three hands of six; 9-max 26 stays, 27 converts and forms three hands of nine); the fairness simulation; every live proof; grants; and a second application.

The Phase 7 simulation runs 1,000 rounds each for 18, 25 and 50 players (with horses), every round a full matcher pass then the real terminal path, committed per round, and a churn run of 25 players with about one in nine reported disconnected each round. It asserts that every round seats every legal player, that no two players' big-blind or small-blind counts differ by more than one (horses included), that every big-blind gap is floor(n/k) or ceil(n/k) rounds, that button counts are within two, and that under churn every player's big blinds stay within two of the burden they were legal for; and it prints the per-player distributions of every position and the repeat-opponent rate.

The bound of one is exact, not tuned: each round deals the big blind to the k players with the oldest `last_bb_at`, and stamping each group one microsecond apart keeps that order a strict first-in, first-out queue, so after any number of rounds every player has been served either floor or ceil of k times rounds over n.

## For The Engine Engineer

- Shadow: call `fn_lightning_match(cluster, now, disconnected_player_ids, NULL)` every `pass_interval_ms`; compare, record, form nothing.
- Form: set `worker_mode` to 'form' in the Cluster's `ruleset_snapshot.lightning`, then call `fn_lightning_match_and_form(cluster, now, disconnected_player_ids, NULL, new_request_id)` each pass; on an unknown outcome retry with the same request id. Then `fn_lightning_instance_begin_dealing` for each returned instance, `fn_lightning_instance_keepalive` every `keepalive_interval_ms`, and the settlement moves the instance to complete.
- `p_disconnected` is the worker's own list of players whose connection is down; they are WAITING_FOR_RECONNECT, not blocked.
