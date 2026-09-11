# Workflow evidence: review-knockout-migration

- run: wf_b6047f60-994
- finished: 2026-09-11T08:19:14.674Z
- status: completed
- agents: 1
- summary: Adversarial review of the bust-time/normalizer/orphan migration and engine bust-order change before it touches production

## verdict

apply-with-fixes

## summary

The migration is safe to apply. It can't touch a COMPLETED event or money that has already moved, and the parts that are meant to be correct are correct. But on its own it changes no payout: the engine pays through fn_complete_tournament_terminal -> fn_settle_tournament_places, which ranks by elimination_sequence. The prepare/normalizer/ruling path is not called by the server; the last settlement batch was on 2026-09-09, and every place obligation since 09-09 22:00 comes from engine.fn_settle_tournament_places. Bounty events keep now() stamps, and 11 of the 15 misallocated events are bounty events.

Checked against production (read-only) and PostgreSQL 17 (throwaway worktree and scratch clusters, all removed; the reviewed worktree is untouched and clean at 589f4af08a):

(1) Replaced functions vs live pg_get_functiondef: only the intended hunks differ, plus a new 'repriced' key in the normalizer's ok result. Signatures, DEFAULT 0, SECURITY DEFINER, search_path, owner postgres and ACLs are identical. Live md5s f596d731/b4937067/ad865880 match the preflight; the two functions it reads, 06028279 and ca0abbc6, also match.
(2) One BEGIN/COMMIT with SET LOCAL lock_timeout 5s and statement_timeout 30s. It contains only CREATE OR REPLACE FUNCTION and REVOKE/GRANT, so no table locks. The postflight pins the new md5s and ACLs, and a second apply is proven idempotent.
(3) The stamp binds the same candidate the door has just proved: the highest global hand_number from fn_ca_latest_committed_knockout_candidate. hand_atomic_commits.committed_at is NOT NULL (default clock_timestamp()) and nothing ever updates it, so knockout_bust_time_unproven is effectively unreachable. stack_before is the engine's hand-start stack.
(4) Re-pricing is byte-for-byte prepare's rule: bp rounding, trim to the field, the last paid place takes the remainder, and the Spin ladder. A 300-event random fuzz passed prepare 300/300 after normalize; the old normalizer failed 266/300.
(5) The orphan proof cannot resolve a final bust wrongly. A later generation is only captured when stack_before > 0, so the player was provably back in play. The ledger window between consecutive generations is sound given how chip_ledger.created_at is set (now()), and no rebuy refund legs exist.
(6) bustOrder binds the same generation as both the door and the bounty evidence loader. No real bust is skipped.
(7) The CI probe passes (11 scenarios, about 20 s). PG17 is installed by the job and python3 is on ubuntu-latest. The law and unit tests pass, and the branch merges cleanly onto current origin/main.
(8) The door is RUNNING-only. The normalizer is frozen for COMPLETED and batched events and refuses re-pricing once money has moved. There is no data DML.

Fixes before or with apply: narrow the money-moved gate (F3); reconcile or document the two clocks (F4); correct the dca6c345 claims (F7). Any settle change needs a bounty-door stamp plus a backfill first (F1, F2, F5).

## findings

```json
[
  {
    "severity": "high",
    "title": "No payout changes; live misallocations continue on the settle path",
    "file": "supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql",
    "detail": "Every event finishes via fn_complete_tournament_terminal -> fn_settle_tournament_places, which orders by elimination_sequence (recording order). Evidence the prepare path is dead: tournament_place_settlement_batches has no rows after 2026-09-09. Every place obligation since 09-09 22:00 has source engine.fn_settle_tournament_places. Nothing in server/src calls fn_prepare/fn_normalize/by_ruling.\n\nThe new eliminated_at is therefore a witness nothing pays from. Money that will go to the wrong players shortly:\n- fe72385b Morning Free Buy (heads-up now, 3 paid, pool 260.90): 3rd place (54.45) is held by f8c8eb13, who busted 04:16:14 and was recorded 3h38m late at 07:54:14 (true place 12th). The true 3rd, fb7da841 (busted 05:19:34), is recorded 8th.\n- 5aa7eeba Midweek Mystery (bounty, 1 player left, 600 pool, 6 paid): places 2-6 were recorded 5.9-7.7 h late, roughly 121.62 misallocated (approximate).\n- a5aa6984: whenever the seatless dca6c345 is removed, settle hands it 2nd place.\n\nAcross RUNNING events: 42 paid-range rows in 7 non-bounty events (about 126) and 8 rows in 2 bounty events (about 152).",
    "fix": "Pair the branch with the settle change in settle_path_recommendation (bounty stamp + backfill), or hold these events until it lands."
  },
  {
    "severity": "high",
    "title": "Bounty events are not covered",
    "file": "supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql",
    "detail": "fn_eliminate_tournament_player_atomic refuses bounty, PKO and mystery-bounty events. Their door, fn_claim_bounty_legacy_candidate_20260907, still stamps eliminated_at = now().\n\nRecomputing the last 34h of COMPLETED MTTs gives the same 15 misallocated events as the audit. 11 are bounty/PKO/mystery events, about 1,190 of about 1,659 (approximate: structure trimmed to the field, no bubble reserve):\n- Union Mystery Bounty 0257bf5d 341\n- Union Grand Championship d43d67f9 216\n- Turbo Tuesday PKO 9320fe50 135\n- Midweek Mystery 7d240805 133\n\nThe 4 non-bounty events are:\n- a9be040d: door, recorded 1h05m late\n- 5b3e294b: absent-sweep row. 1c33a761 lost the chair at 10:10:55, was recorded at sequence 11278 and paid 2nd, 123.27.\n- a94f8c5f and 29c85b8b: recorded 3-4.5h late.\n\nAny 'rank by eliminated_at' fix inherits recording order for bounty events.",
    "fix": "Stamp the bust-hand commit time in fn_claim_bounty_legacy_candidate_20260907 too, same rule. Or have settle derive the bust time from the bound 'eliminated' candidate joined to hand_atomic_commits instead of trusting eliminated_at."
  },
  {
    "severity": "medium",
    "title": "Money-moved gate is too broad; it opens the ruling door in bounty events",
    "file": "supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql",
    "detail": "The normalizer refuses re-pricing when ANY tournament_payouts or tournament_obligations row exists. All 14 RUNNING bounty events carry 'bounty' or 'mystery_bounty' obligations (127 rows). Reproduced in PG17: a PKO event whose only obligation is a kind='bounty' row returns moved_places_cannot_be_repriced_after_money_moved.\n\nThis matters because fn_settle_tournament_places_by_ruling calls the normalizer first and pays 'every place the roster names' when it refuses.\n- Before: the old normalizer renumbered and returned ok, so the ruling refused with chronology_can_certify_this_result.\n- After: the ruling proceeds and pays the recording-order roster.\n\nBounty KO money does not depend on place order, so re-pricing there cannot pay a place twice. Scenario 07 codifies the over-broad behaviour.",
    "fix": "Gate only on place money:\n- payouts whose source is NOT IN ('bounty','own_bounty','mystery_bounty','mystery_bounty_residual','bounty_residual','satellite_seat') \u2014 the non-place list fn_settle_tournament_places already uses;\n- obligations with kind IN ('place','bubble_protection').\nUpdate scenario 07: keep the bubble_protection refusal; the bounty case should re-price."
  },
  {
    "severity": "medium",
    "title": "Engine and door use different clocks",
    "file": "server/src/tournament/bustOrder.ts",
    "detail": "The engine sorts busts by hand_number, which fn_next_hand_number (a global sequence) assigns at deal time. That order sets the provisional positions and elimination_sequence. The door now stamps commit time.\n\nIn RUNNING non-bounty events, deal order differs from commit order for 1,399 of 4,357 eliminations. committed_at lags hand end by p50 0.38s, p99 3.9s, max 7.5s.\n\nReproduced in PG17: a promptly recorded two-table finish (hand 3000100 committed 10:00:30, hand 3000101 committed 10:00:10) was recorded a=3rd, b=2nd. The new normalizer swaps and re-prices them; settle would pay b 2nd.\n\nIn 8e16cdb4 the only paid-range difference (places 19-21, about \u00b11.00: c82e74af -1.00, 2e49e7e8 +0.50, 58584896 +0.50) comes down to hands 9386965 and 9386971. They started 8 ms apart, ended 3 ms apart and committed 19 ms apart.\n\nThe header ('eliminated_at order is therefore bust order') and bustOrder ('hand number: the primary witness') contradict each other.",
    "fix": "Pick one clock. Either sort non-PKO busts by the bound hand's committed_at (keep hand order only for the PKO watermark), or document that commit time decides places at settlement. Consider a tie rule for hands that overlap in time."
  },
  {
    "severity": "low",
    "title": "After apply, eliminated_at mixes two meanings",
    "file": "supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql",
    "detail": "All 4,465 eliminated rows in RUNNING events carry recording-time stamps (eliminated_at order equals elimination_sequence order for 100% of them). 1,412 busts are pending right now, 1,398 of them older than 10 minutes. Once recorded after apply they get earlier bust-time stamps than rows that were recorded late just before apply. The normalizer, or any future settle-by-eliminated_at, would mis-rank across that seam.",
    "fix": "Before anything relies on eliminated_at, backfill it for RUNNING and unpaid COMPLETING events from each player's latest 'eliminated' candidate commit (+1\u00b5s same-hand rank). This must run in the same transaction as the settle change."
  },
  {
    "severity": "low",
    "title": "Finished-but-not-completed detector can raise false critical alerts",
    "file": "supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql",
    "detail": "fn_ca_tournament_finished_but_not_completed (cron 304, every 5 min) alerts on RUNNING events with at most one player left whose max(eliminated_at) is older than 15 min. With bust-time stamps, a final bust recorded 15 or more minutes late qualifies the moment it is recorded, before the roughly 20 s finish.",
    "fix": "Measure from recording time (elimination_sequence, or a recorded_at column) instead of eliminated_at."
  },
  {
    "severity": "low",
    "title": "dca6c345 claims and an in-body comment are wrong or stale",
    "file": "supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql",
    "detail": "The header says the door resolves a5aa6984 dca6c345 'when that player next busts'. That will not happen. The player has no seat and no hand after hand 8569325 (09-09 06:13:09); tp.chips=2500 exists only in the mirror. Its rebuy leg was posted at 06:28:26, 15 minutes after the prompt closed, and bought nothing.\n\nIf the mirror is zeroed, the door stamps 06:13:09, which is correct, yet settle still pays it 2nd of 100. Separately, 'Two further orphans sit in a5aa6984' is baked into the function body and is already stale.\n\nThis also shows a posted 'rebuy' leg alone does not prove re-entry. The door rightly also requires a later generation.",
    "fix": "Correct the header and changelog. Remove the transient claims from the function comment."
  },
  {
    "severity": "low",
    "title": "Door ignores a rebuy leg after the bound generation",
    "file": "supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql",
    "detail": "When the latest pending generation is followed by a posted rebuy leg, the stamp is right only if the player never played afterwards. Six already-eliminated, out-of-the-money players show the missing-candidate shape: they played 5-292 hands after their latest candidate:\n- 798866ae: 22af2652, 6d6b3cc2, 20a40df1, 45a5e770\n- 7aa16fa7: 71efcdb3\n- a5aa6984: 55256246\nThe 07:04 repair stamped the 798866ae four with the stale candidate time. The branch neither fixes nor worsens them, but they must be corrected before any settle-by-eliminated_at.",
    "fix": "Refuse with knockout_bust_time_unproven when a posted rebuy leg follows the bound generation and hand_history shows the player in a later hand."
  },
  {
    "severity": "low",
    "title": "bustOrder read has no row cap guard; engine should deploy with or before the migration",
    "file": "server/src/tournament/TournamentManagerEliminations.ts",
    "detail": "The candidate read now returns every state with no LIMIT. PostgREST's row cap (1000 by default) would drop the oldest rows first. A player could then lose their entry and sort LAST, which is the best place in the batch. Not reachable today: at most 4 generations per player, so 160 rows per 40-user chunk.\n\nDeploy order: if the migration lands before the engine change, an orphan-holder would be accepted at its earliest-pending sort position, i.e. the worst remaining place. There are 0 such players today.",
    "fix": "Select only each player's latest generation (or assert the row count against the cap). Merge and deploy the engine before applying the migration."
  }
]
```

## settle_path_recommendation

Yes, make fn_settle_tournament_places rank by bust time, but not by swapping in ORDER BY eliminated_at today.

What that swap alone would change right now: nothing. All 4,465 eliminated rows in RUNNING events have eliminated_at in exactly elimination_sequence order, because every one is a recording-time stamp.

With a backfill from the bound 'eliminated' candidate's commit time and a bounty-door stamp, it would move today (amounts approximate):

1. fe72385b Morning Free Buy, heads-up now: 54.45 for 3rd moves from f8c8eb13 (recorded 3h38m late) to fb7da841.
2. Four more non-bounty events: bee519fa about 22.46, f922df63 about 20.61, 7aa16fa7 about 6.08, a5aa6984 about 1.05. a5aa6984 also depends on the ghost dca6c345: settle-by-sequence pays it 2nd; by bust time it finishes about 100th and places 2-10 each move up one.
3. 8e16cdb4 Prime Time Free Buy: 193 of 262 ranks change, but in the money only places 19-21, about ±1.00. That is decided by two hands that started 8 ms apart, ended 3 ms apart and committed 19 ms apart. It is a timing race, not late recording. 3f03e48b was recorded 39 min late but is 18th either way.
4. Bounty events, only if the bounty door is changed too: 5aa7eeba Midweek Mystery about 121.62 (places 2-6 recorded 5.9-7.7 h late), 9536150e about 30.05.
5. c1f15c30 Breakfast Turbo (COMPLETING): nothing either way. Settle already raises before ranking, because place obligations 5-6 lie outside its 4-place derived ladder and all 180.00 was paid rolling. A bust-time ranking would also want to move 6 sweep rows (positions 35-40, stamped 14:38-14:42 after chip-losing seat moves) into places 2-7. It would refuse, because settled place evidence exists.

It is safe if done as one change:

a. Apply this migration, and give fn_claim_bounty_legacy_candidate_20260907 the same bust-hand stamp.
b. In the same transaction, backfill eliminated_at for RUNNING and unpaid COMPLETING events from each player's latest 'eliminated' candidate's hand_atomic_commits.committed_at (+1µs same-hand rank, smaller stack first). Leave rows without a candidate on their stamp: absent sweep = lost_chair_at; release-broke and commander = now(). Both sweep crons are currently inactive.
c. Hand-fix the six rows whose real last bust has no candidate (listed in the findings; all out of the money).
d. In settle, order eliminated players by (eliminated_at, elimination_sequence, id). Fail closed on any eliminated row with a NULL eliminated_at. Keep elimination_sequence as the final-elimination winner witness, and keep the existing refusal to renumber once place evidence exists.
e. Decide explicitly that commit time, not hand number, orders busts on different tables (about 32% of rows differ from the engine's provisional order). Either make the engine sort non-PKO busts the same way, or accept that settle renumbers them. Consider a tie rule for hands that overlap in time.

COMPLETED events are untouched, because settle's renumber block never runs for them and only exact replays pass. Events with existing place evidence (settled place payouts or place obligations) fail closed rather than move money.
