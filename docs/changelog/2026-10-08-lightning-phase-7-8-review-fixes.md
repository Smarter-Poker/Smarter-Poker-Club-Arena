# Lightning Phases 7 and 8: The Adversarial Review Findings Are Closed

**Date:** 2026-10-08
**Migration:** `20261008043021_lightning_phase_7_and_8_review_fixes_the_dwell_is_a_duration.sql`
**Harnesses:** `scripts/dev/test-lightning-phase7-reversion.sh` (sections 27 to 31) and `scripts/dev/test-lightning-phase8-session.sh` (sections 13 to 19)
**Static Suites:** `tests/lightning-phase-7-reversion.test.ts` and `tests/lightning-phase-8-session.test.ts`

Adversarial review of the merged Lightning migrations `20261007222717` (Phase 7
remediation) and `20261007212735` (Phase 8) found six defects. One migration
closes all six at the root, as asserted substitutions into the bodies
production carries. No table is created or altered, and every touched function
keeps who may execute it and its comment.

## Finding 1 (P1): The Dwell Is a Duration, Not a Count of Calls

`fn_cash_cluster_begin_pending_off` recorded a first OFF sighting in
`cash_games.lightning_off_condition_since` and returned `off_condition_dwell`
only while that column was NULL. Any later call proceeded unconditionally, so
a seat-change wake about 500ms after the first sighting opened PENDING_OFF and
`pending_off_dwell_ms` was dead configuration. The non-NULL branch now
requires `clock_timestamp()` to have reached the standing sighting plus the
configured dwell, and refuses with the standing `first_seen_at` until then. A
`pending_off_dwell_ms` of 0 keeps the previous two-sighting behaviour: the
first sighting records, the second proceeds at once. A disabled Cluster or
game still drains immediately; the dwell gates only the population trigger.

## Finding 2 (P2): A Stale Sighting Dies With the Epoch

Neither `fn_cash_cluster_unfreeze` nor `fn_cash_cluster_commit_lightning`
cleared `lightning_off_condition_since`, so the next Lightning epoch could
open PENDING_OFF on one observation against a sighting recorded before a
freeze or in a dead epoch. Both now NULL the column in the same UPDATE that
moves `cluster_mode`: the unfreeze beside its halt clearing, the ON commit in
its mode UPDATE.

## Finding 3 (P2): The Multi Table Limit Holds Across Clusters

`fn_lightning_player_legality` counts committed reservations, but
`fn_lightning_match_and_form` serialises only per Cluster, so k Clusters
forming in the same instant could each admit the same player: a mobile limit
of 2 could end with 4 live hands. `fn_lightning_form_hand` gains
`p_player_platforms` (passed through by `fn_lightning_match_and_form`), and
after writing the committed reservations it takes one transaction advisory
lock per participant in sorted player id order, then recounts each
participant's live committed reservations across every Cluster against that
participant's platform limit from `fn_lightning_config`. Anyone over the
limit makes the whole formation a normal retryable refusal (SQLSTATE 40001),
which rolls the atomic block back and releases its reservations; the matcher
replans and P0 then refuses the player as MULTI_TABLE_LIMIT. Two racing
barriers queue on the player's lock and the second counts the winner's
committed rows, so exactly one succeeds. The advisory locks are taken after
every row lock the barrier holds and always in sorted order; two formations
in one Cluster are already serialised by the Cluster row FOR UPDATE, and two
formations in different Clusters share no row lock, so no cycle is possible
against the anchor seat locking. The ten argument `fn_lightning_form_hand` is
dropped in the same transaction; the eleven argument one carries its grants
(service_role only) and comment.

## Finding 4 (P3): No Winners Record, No Guessing From Its Absence

`fn_lightning_recent_hands` misclassified when `hand_history` was pruned or
its winners were absent: net 0 and not listed read `split`, and a 0 net chop
whose recorded userId differed in case or type read `lost`. When no winners
record exists the result is now the net alone: ahead won, behind lost, level
and folded folded, otherwise won. When a record exists the winners' userId is
compared case and type normalised.

## Finding 5 (P3): Pool Status Is the Client Contract

`fn_lightning_pool_status` returned the raw `cluster_mode`, leaking frozen,
paused and the pending states to players. The `cluster_mode` key is dropped.
The client contract is `{players, status, joinable, multi_table_limit}`:
`joinable` is true only for an enabled Lightning Cluster in `lightning` mode,
and `multi_table_limit` is the configured `{desktop, tablet, mobile}` object
from `fn_lightning_config`, carried in the same payload so the client entry
door can enforce the configured limits.

## Finding 6 (P3): An Unreported Platform Is the Narrowest Limit

The legality platform lookup in `fn_lightning_player_legality` defaulted a
missing or unknown platform to desktop, the widest limit (4). It now defaults
to mobile, the narrowest (2), in both the platform CASE and the limit
fallback, and the barrier's new cross Cluster recount defaults the same way.
Not reporting a platform can never buy a wider limit than the client would
enforce. Callers that know the platform keep passing `p_player_platforms` and
are unaffected.

## Law 10.5

Nothing in the migration reads `is_horse` or `horse_id`. A horse's dwell,
limit recount, result classification and pool status are a human's exactly,
and both harnesses prove the refusals and classifications for a horse beside
a human.

## Proof

Each harness first proves every defect real on the merged code, applies the
migration (after its prerequisite peer file, mirroring production), proves
the fixes with real drives, real formations, two real backends racing one
mobile player across two Clusters, re-evaluates every earlier live proof, and
applies the migration a second time to prove it changes nothing.
