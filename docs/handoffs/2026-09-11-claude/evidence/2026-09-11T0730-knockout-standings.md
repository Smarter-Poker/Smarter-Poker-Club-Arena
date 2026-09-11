# Workflow evidence: knockout-standings

- run: wf_d5b8bbe3-95d
- finished: 2026-09-11T07:30:23.656Z
- status: completed
- agents: 2
- summary: Knockout/standings: code fixes (door stamps bust time, normalizer re-prices, engine binds latest candidate, orphan rule) and a read-only payout audit

## status

committed

## summary

I've committed all four fixes locally on fix/a-bust-is-ranked-by-when-it-happened (b819a7206f code, 589f4af08a comment update). Nothing was pushed or applied. One problem is urgent. The 798866ae data repair went in at 07:04 UTC, and the engine's finish will undo it. The live payout path (fn_complete_tournament_terminal -> fn_settle_tournament_places) ranks players by elimination_sequence, which is recording order, not by eliminated_at. 83 of the 85 repaired places disagree with that order and there are no payouts yet. So when the engine finishes the event, it will renumber them back to recording order and pay the wrong players: 65f99ae2 2nd (16.89 instead of 5.08), a45c237c, 778cab7d, 767bd910 and ad5bd851 in 6th to 9th, and nothing to e0be3976, ae75d87e, acbf88b1 or b1dd1863. At 07:29 UTC the event was still RUNNING with one player and no payouts. For the same reason, fixes 1 and 2 correct only the manual settle path (prepare and ruling), not the engine's own finish. The migration replaces three existing functions with their live bodies plus the changes, and a PostgreSQL 17 test shows every fixed behaviour failing on the current live code and passing after the migration.

## branch

fix/a-bust-is-ranked-by-when-it-happened

## commit

589f4af08a56ac1fb6c88deda62556da6e60ba07

## worktree

/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-knockout-code

## migration_files

```json
["supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql"]
```

## proved_failing_on_old_code

The PostgreSQL 17 test (scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh) loads the live production code of every function involved, copied byte for byte; the md5s match production and the migration's own pre-checks. 8 scenarios must fail on that live code with a named assertion, and all 8 do:

- 01: eliminated_at came back as the recording time (now()).
- 02: three busts in one hand came back in reverse order.
- 03: the door refused with unresolved_knockout_generation_chain.
- 05: end to end, the late bust was paid 2nd.
- 06: prepare refused with recorded_prize_disagrees_with_structure.
- 07: the normalizer returned ok and renumbered although money had moved.
- 08: the Spin prepare refused the same way as 06.
- 09: the normalizer returned ok with no usable payout structure.
  After the migration is applied twice, all 11 scenarios pass; the 3 that check unchanged behaviour pass both before and after.
  Engine: with the old earliest-pending rule swapped into bustOrder.ts, 5 of the 8 tests in bustOrder.test.ts fail, including 'orders a player by their latest bust'. The root law test also fails on old code, because the migration does not exist there.

## tests_run

- PostgreSQL 17 test, on a local 17.11 cluster: all 11 scenarios behave as designed, before and after the migration.
- Full server suite (vitest): 669 files and 9184 tests passed, including the new bustOrder.test.ts and the updated TheSweepReachesTheTable.test.ts.
- Full root suite (vitest tests/): 1385 files passed. 2 failed, both 'Failed to resolve import @capacitor/...'; the shared node_modules has no @capacitor packages, which is unrelated to this change. The new law test and the law registry pass.
- Server tsc --noEmit: exit 0. Root tsc: 26 errors, all missing @capacitor modules (same environment gap).
- Prettier check and eslint on the changed files pass.
- CI check scripts against origin/main all report OK: check-migrations-applied (the migration adds no new function names), check-definer-authorization, check-unqualified-writes, check-no-new-band-aids, check-phantom-columns, check-required-columns.

## report

WHAT I CHANGED (the four fixes you asked for)

The migration is 20260911062048_a_bust_is_ranked_by_when_it_happened.sql. I reserved the version with scripts/reserve-migration-version.sh. It is one BEGIN/COMMIT with SET LOCAL lock_timeout='5s'. Each function is replaced with its LIVE body (read with pg_get_functiondef) plus the change; I diffed each against live and only the intended hunks differ. Same signatures, owner, security and grants. A pre-check pins the live md5 of the three replaced functions and of the two it reads (fn_ca_latest_committed_knockout_candidate 0602827..., fn_prepare_tournament_place_obligations ca0abbc...). A post-check pins the new md5s: legacy 334c7166, door e7b370df, normalizer 1b93c5dd.

1. The door stamps the bust time (fn_eliminate_player_legacy_candidate_20260907).
   - eliminated_at = hand_atomic_commits.committed_at of the candidate returned by fn_ca_latest_committed_knockout_candidate. That is the same row the door binds, matched on table_id, hand_number and hand_id.
   - Busts in the same hand get +1 microsecond per earlier rank: smaller stack_before first, then user id.
   - The rank counts every candidate in that hand, whatever its state, so it cannot shift if another player rebuys later.
   - If the time can't be proven, the door refuses with 'knockout_bust_time_unproven' instead of using now().
   - I kept the 5-argument signature. Changing the signature would mean a DROP and a new name, and CI's "new migrations were applied" gate stays green only because no new function names are added.

2. The normalizer re-prices what it moves (fn_normalize_tournament_final_standings).
   - The price is recomputed exactly as fn_prepare_tournament_place_obligations does it; the law test checks each piece of the rule appears in both. Structure trimmed to the field, bp = round(pct*100), each place least(remaining, round(pool_cents*bp/total_bp)), the last paid place takes the remainder, Spins use spin_payout_ladder.
   - Applied only to rows whose position changes and whose prize differs from their new place's amount, in the same write, then checked.
   - If any tournament_payouts or tournament_obligations row exists for the event, it refuses with RAISE WARNING plus 'moved_places_cannot_be_repriced_after_money_moved', and renumbers nothing. A settlement batch or a COMPLETED event already returns earlier, unchanged.
   - If the ladder can't be derived (payout structure invalid, pool not finalized, Spin ladder missing), it refuses with 'moved_places_cannot_be_priced'.
   - Satellites are renumbered as before, with no re-pricing.

3. The orphan rule (fn_eliminate_tournament_player_atomic).
   - An older PENDING candidate counts as bought back only if a chip_ledger leg exists with: category 'rebuy', player_wallet to prize_liability, status 'posted', amount > 0, same player and tournament, created after that candidate and before the player's next candidate.
   - Only then is it excluded from the unresolved-chain check and set to 'rebought'. That happens only after the elimination write succeeds, in the same transaction, and the ids are returned as rebought_generations.
   - With no proof, or any other state, it is still refused exactly as before; scenario 04 tests seven ways a ledger leg can fail to count as proof.
   - Refusals still write nothing.

4. Engine bust order.
   - New pure function server/src/tournament/bustOrder.ts: bindLatestKnockoutCandidates picks the latest candidate per player (hand_number, then id, same as the door).
   - It gives an order only when that latest candidate is pending. Otherwise, or if any of the player's candidate rows is unreadable, the player is unknown and sorts last, which is the existing convention.
   - TournamentManagerEliminations now reads all candidate states for the busted players (select 'id, eliminated_user_id, hand_number, stack_before, state', ordered by hand_number desc). The earliest-pending loop is gone.
   - I updated the pin in TheSweepReachesTheTable.test.ts and corrected the skip-rule comment that claimed the normalizer protects the payout.

Tests: PostgreSQL 17 test runner plus fixtures in scripts/dev/fixtures/a-bust-is-ranked-by-when-it-happened/, added as a step in the CI accounting_postgres job. Also bustOrder.test.ts, and tests/a-bust-is-ranked-by-when-it-happened.law.test.ts with its docs/laws.d entry, plus a changelog.

WHAT THIS DOES NOT FIX

- fn_settle_tournament_places, the engine's finish path, still ranks eliminated players by elimination_sequence, i.e. recording order. A late-recorded bust still takes a better place on the engine's finish; see the 798866ae warning above.
- The small change would be to order its two renumber queries by eliminated_at DESC NULLS LAST, then elimination_sequence DESC, then id. It is a money-authority ranking change, and CLAUDE.md 10.9 has a precedent that keeps recorded order.
- One live event, c1f15c30 "Breakfast Turbo" (COMPLETING, 6 payouts), has eliminated_at order that disagrees with all 39 of its positions. With that change it would stop completing, with an error, rather than completing as it does now. I left that change out on purpose.
- The bounty door (fn_claim_tournament_bounty_elimination and fn_claim_bounty_legacy_candidate_20260907) still stamps now() and still has the strict chain rule. It is unchanged.

CURRENT STATE (read-only, 07:25 to 07:29 UTC)

- Someone applied repairs at 07:04 (798866ae) and 07:23 (7aa16fa7 plus a5aa6984 4f7f8abb), so no RUNNING player is held by an orphan any more. The second commit updates the migration header and changelog to say so.
- a5aa6984 dca6c345 still has a pending candidate with a proving ledger leg; the new door would resolve it when that player next busts.
- 798866ae: RUNNING, 1 player, 0 payouts, positions in repaired bust order, elimination_sequence in recording order.

I did not touch the main checkout at ~/Documents/club-arena (it has staged changes that aren't mine). My scratch files and the local test cluster are removed.

## risks

```json
[
  "URGENT, not caused by this branch: the 798866ae repair applied at 07:04 UTC will be renumbered back to recording order when the engine finishes the event. fn_settle_tournament_places renumbers to elimination_sequence order when no place payouts exist, and 83 of the 85 positions disagree with it. It would pay 65f99ae2 2nd, 9bb330b7 3rd and 9da2d0b7 4th, and nothing to e0be3976, ae75d87e, acbf88b1 or b1dd1863. At 07:29 UTC the event was RUNNING with one player and 0 payouts. A human needs to decide before the engine's next finish attempt.",
  "Applying the migration replaces 3 function bodies: fn_eliminate_player_legacy_candidate_20260907, fn_eliminate_tournament_player_atomic and fn_normalize_tournament_final_standings. There is no table DDL, no data row is written by the migration itself, and there is one PostgREST schema reload. Grants are restated unchanged. It refuses to apply if any of the 5 pinned function bodies changed after 2026-09-11 06:20 UTC. Apply outside the :50-:03 break window.",
  "After applying, every non-bounty elimination gets eliminated_at = the bust hand's commit time (+1 microsecond per rank within the hand) instead of the recording time. Ranking changes only where eliminated_at is read: the normalizer, prepare and the ruling function. The engine finish (fn_settle_tournament_places) is unaffected because it ranks by elimination_sequence.",
  "Side effect: cron 304 (fn_ca_tournament_finished_but_not_completed) uses max(eliminated_at). If a final bust is recorded more than 15 minutes late, it can open a critical financial_alert as soon as the event is down to one player. That requires the 5-minute cron to fire in the roughly 20 seconds before the engine completes the event.",
  "Door: an older pending candidate is set to 'rebought' only with the ledger-leg proof, and only in the same transaction as a successful elimination. As of 07:25 UTC nobody is held by an orphan any more (repairs at 07:04 and 07:23), so today this affects only a5aa6984 dca6c345, on that player's next bust. The door's response gains a rebought_generations key; the engine ignores unknown keys.",
  "The legacy function's new refusal 'knockout_bust_time_unproven' should be unreachable once the door's checks pass. If it ever fires, the engine treats it as a door refusal, which counts toward BUST_REFUSAL_SKIP_AFTER.",
  "Normalizer: moved rows are re-priced only on the prepare and ruling paths. Two new refusal reasons, 'moved_places_cannot_be_repriced_after_money_moved' and 'moved_places_cannot_be_priced', leave positions untouched. Before, the normalizer returned ok and prepare refused later. Because fn_settle_tournament_places_by_ruling proceeds when the normalizer refuses, those cases can now reach a human ruling. Following the spec literally, any tournament_payouts row counts as money moved, including bounty payouts, so bounty events never get re-priced.",
  "Not fixed, needs a decision: fn_settle_tournament_places still ranks the engine's finish by recording order. The suggested change is ORDER BY eliminated_at DESC NULLS LAST, elimination_sequence DESC, id ASC in its two renumber queries. It would make c1f15c30 'Breakfast Turbo' (COMPLETING, 6 payouts, eliminated_at order disagrees with all 39 positions) stop completing, with an error, rather than completing as it does now, and it touches the CLAUDE.md 10.9 recorded-order precedent.",
  "Not changed: the bounty door (fn_claim_tournament_bounty_elimination and fn_claim_bounty_legacy_candidate_20260907) still stamps now() and keeps the strict chain rule. 14 of 628 RUNNING events are bounty-type; none holds an orphan today.",
  "The engine change is independent of the migration and safe to deploy in either order. It only changes the order of busts for players with more than one candidate, or whose latest candidate is not pending (they now sort last as unknown). It also lines the sweep's order up with the hand the bounty door binds, which protects the PKO watermark.",
  "CI: a new step in the accounting_postgres job runs the PostgreSQL 17 test; it needs python3 and PostgreSQL 17, which the job already has. The test contains a byte-exact copy of four live production function bodies (door, legacy, normalizer, prepare) as fixtures. If production changes them, the test's md5 check and the migration's pre-check both stop, which is intended.",
  "Root full test suite has 2 failures and root tsc has 26 errors, all from @capacitor packages missing in the shared node_modules. They are unrelated to this branch but will show up in any local run from this worktree."
]
```

---

## status

report

## summary

1. I checked all 10,556 events that completed between 09-09 00:00 and 09-11 06:25 UTC (none completed between then and 06:55). Every player in them is a horse. The true bust order can be derived for 10,553 events; 3 cannot (5b3e294b, d6f7a7e2, a9be040d). For all 22,094 eliminations that have a candidate, the hand commits agree with the candidate.
2. In 15 paid events, 62 player-rows were paid something other than their true prize. 1,436.78 was overpaid (28 rows) and 1,436.78 was underpaid (34 rows), across 60 distinct players: 0 humans and 60 horses. Every event is zero-sum. The 209 satellites are clean. Recorded prize, paid amount and payout rows agree for every row, so bust order is the only error.
3. No money has moved in the RUNNING events. 9 of them would pay wrongly at finish: 41 provisional prizes are wrong and 20 rows whose true place is paid carry no prize, which is 158.56 over and 421.93 under. That includes 5 busts still pending at the door. 6 rebuy-chain players have a stale 'eliminated' candidate, so the fix must use the hand commit as its witness.
4. All 6 orphan candidates have a later rebuy ledger leg. 5 are safe to resolve to 'rebought', but 798866ae/9bb330b7 only in the same transaction as the standings and prize rewrite. a5aa6984/dca6c345 is not safe on its own: the rebuy was bought 14m47s after the prompt closed and the player was never seated.
5. No existing money door can correct the paid events. fn_terminal_tournament_evidence_is_immutable refuses every insert naming a COMPLETED tournament, the reconcile function returns pool_fully_discharged, and the obligation door refuses places already paid to someone else. A player-to-player transfer is not supported and CLAUDE.md 10.9 rule 3 forbids it. Recommendation: new code for a house-funded 'finish_position_correction' back-pay of 1,436.78, with overpaid players keeping what they got.

## report

# Knockout order: exact audit (read-only; nothing written to production or the repo)

**Snapshot and access**

- Snapshot times: COMPLETED set taken at 06:22 UTC on 09-11; RUNNING set at 06:39–06:55 UTC.
- Access: every query was a SELECT, run with `default_transaction_read_only=on` and `statement_timeout=20s`.
- Rule ported: `fn_prepare_tournament_place_obligations` (md5 of pg_get_functiondef: be9cf45cc7a867d0b06a80648b1e0b43).

## Method

**True bust**

- Take the player's latest non-'rebought' `tournament_knockout_candidates` row. `hand_number` is globally unique; I checked that its order agrees with commit order for every player.
- Join it to `hand_atomic_commits.committed_at` on (table_id, hand_number, hand_id). Every candidate in scope has its exact commit.
- Same hand: the smaller `stack_before` busts first, then the smaller user_id.
- Winner = place 1. Every other place = field − rank.

**True prize (exact port of the rule)**

- `pool_cents = round(round(prize_pool,2)*100)`.
- Structure: Spins use `spin_payout_ladder` for their multiplier; everything else uses `fn_safe_jsonb_array(payout_structure)`.
- The structure is trimmed to places ≤ field, and `bp = round(pct*100)`.
- Each place gets `min(remaining, round(pool*bp/total_bp))`. The last trimmed place gets the remainder.

**Paid**

- Sum of `chip_ledger` legs with category 'tournament_prize' (prize_liability→player_wallet) per event and user.
- Cross-checked against `tournament_payouts` (place-evidence sources), `tournament_obligations` and `tournament_place_settlement_batches`.

**Checks**

- **Rule port:** the recorded prize equals my rule's prize at the recorded place for all 33,249 rows (0 exceptions).
- **Paid vs recorded:** paid = recorded prize = payout rows for every row (0 exceptions). The only money error is the ordering.
- **Hand witness:** for 22,094 of 22,094 candidate-backed eliminations, the player's last appearance in `stack_result.written` is the chosen candidate's hand, with stack 0. 10,534 winners finish with chips.
- **SQL spot check:** a SQL recomputation for 0257bf5d gives the same places.

## A. COMPLETED events (ended 09-09 00:00 to 09-11 06:25 UTC)

**Scope:** 10,556 events: 7,859 Spins, 2,390 SNGs, 209 satellites, 98 MTTs. 33,249 players; `profiles.is_horse` is true for all of them.

**Results**

- **Order out of place, no money impact:** 320 events have at least one row out of true order (2,187 rows). 251 are Spins where 2nd and 3rd are swapped but the 2x–5x ladders pay only 1st. 69 are MTTs. SNGs: 0.
- **Satellites (209):** seats, tickets and remainders all went to the true holders (0 mismatches). 8 have out-of-order rows outside the award places.
- **Bubble protection:** no event in scope uses it.
- **Bounties:** bounty and mystery-bounty legs are per knockout, and bounty residuals went to the true winners, so they are not affected.

**Events where the PAID amount differs from the true prize (15)**

| #   | event                                | name                                          | ended       | pool    | field | players paid≠true | overpaid | underpaid | batch |
| --- | ------------------------------------ | --------------------------------------------- | ----------- | ------- | ----- | ----------------- | -------- | --------- | ----- |
| 1   | cfecf786-4f66-4e0c-8725-e01703d2f748 | 10 Chip Spin PLO4 (10x)                       | 09-09 01:03 | 100.00  | 3     | 2                 | 20.00    | 20.00     | yes   |
| 2   | d7882afc-73fa-4eaf-9f24-0f32d53d96b2 | Evening Mystery Bounty (PLO5)                 | 09-09 21:00 | 400.00  | 30    | 3                 | 115.48   | 115.48    | yes   |
| 3   | d43d67f9-bd78-4ac6-b17d-a05c6eed5475 | Union Grand Championship (NLH)                | 09-10 01:23 | 2500.00 | 56    | 3                 | 215.75   | 215.75    | no    |
| 4   | b84f312f-abe7-40a1-a208-5a6745d78372 | Night Owl Special (NLH)                       | 09-10 01:24 | 600.00  | 48    | 4                 | 49.26    | 49.26     | no    |
| 5   | a94f8c5f-cdf5-4f3a-8e2b-4521137157a6 | DSS Wednesday $22 NLH Deepstack • 2 PM CT     | 09-10 07:41 | 1134.00 | 63    | 2                 | 78.58    | 78.58     | no    |
| 6   | 0257bf5d-80c0-407b-b151-a0ede129b05e | Union Mystery Bounty (PLO5)                   | 09-10 15:46 | 800.00  | 36    | 5                 | 341.28   | 341.28    | no    |
| 7   | bb179b59-4e74-46b9-b6ac-b4c5d8b5ade7 | Midnight Bounty (NLH)                         | 09-10 15:46 | 100.00  | 23    | 4                 | 49.74    | 49.74     | no    |
| 8   | 236d8826-b00b-4999-b232-5e3c0a5547f3 | Afternoon Bounty (NLH)                        | 09-10 15:51 | 200.00  | 32    | 5                 | 85.32    | 85.32     | no    |
| 9   | 8d3a37b0-708b-4c42-8e0f-e2b0a1cc9664 | Pre-Dawn Mystery Bounty (PLO5)                | 09-10 15:51 | 80.00   | 24    | 4                 | 39.79    | 39.79     | no    |
| 10  | 09ac876f-4fbf-4173-a72d-54ad988f521c | Sunrise Bounty (NLH)                          | 09-10 15:51 | 90.00   | 26    | 4                 | 44.77    | 44.77     | no    |
| 11  | 4366c4c0-8dbb-4ba1-aed9-3721968b825d | Midweek Bounty                                | 09-10 15:51 | 350.00  | 52    | 6                 | 70.95    | 70.95     | no    |
| 12  | 7d240805-161f-47eb-97d6-8d0de74b6195 | Midweek Mystery                               | 09-10 15:51 | 600.00  | 50    | 5                 | 132.78   | 132.78    | no    |
| 13  | 29c85b8b-941b-4b64-b954-7234cfdf8928 | DSS Wednesday $150 Evening Freeroll • 7 PM CT | 09-11 01:37 | 157.70  | 23    | 2                 | 32.91    | 32.91     | no    |
| 14  | 9320fe50-8d17-45ad-988c-bc7c3fea42d5 | Turbo Tuesday PKO                             | 09-11 01:48 | 600.00  | 106   | 11                | 134.58   | 134.58    | no    |
| 15  | 6f6dab21-b80b-418d-af89-8437849b7289 | Brunch Special PKO (PLO8)                     | 09-11 01:49 | 180.00  | 32    | 2                 | 25.59    | 25.59     | no    |

The investigator's 11 events after 09-10 07:00 are #5–15 (50 rows: 21 overpaid, 29 underpaid). #1–4 are additional.

**Per affected player** (delta = paid − true; all are horses)

| event    | user                                 | rec place/prize | true place/prize | paid   | delta   |
| -------- | ------------------------------------ | --------------- | ---------------- | ------ | ------- |
| cfecf786 | 00000000-0000-0000-0000-000000000031 | 3/0.00          | 2/20.00          | 0.00   | -20.00  |
| cfecf786 | a6951550                             | 2/20.00         | 3/0.00           | 20.00  | +20.00  |
| d7882afc | c7a783ee                             | 4/0.00          | 2/115.48         | 0.00   | -115.48 |
| d7882afc | de9802a0                             | 2/115.48        | 3/83.48          | 115.48 | +32.00  |
| d7882afc | 484d22c4                             | 3/83.48         | 4/0.00           | 83.48  | +83.48  |
| d43d67f9 | 13f916ec                             | 4/291.00        | 2/506.75         | 291.00 | -215.75 |
| d43d67f9 | 1d1e1921                             | 2/506.75        | 3/366.25         | 506.75 | +140.50 |
| d43d67f9 | 1000eabd                             | 3/366.25        | 4/291.00         | 366.25 | +75.25  |
| b84f312f | 97e77c3a                             | 3/96.00         | 2/132.78         | 96.00  | -36.78  |
| b84f312f | f7c6e68a                             | 2/132.78        | 3/96.00          | 132.78 | +36.78  |
| b84f312f | 9b2787f1                             | 5/63.78         | 4/76.26          | 63.78  | -12.48  |
| b84f312f | face0000-0000-0000-0000-000000000007 | 4/76.26         | 5/63.78          | 76.26  | +12.48  |
| a94f8c5f | 2db815f9                             | 8/0.00          | 7/78.58          | 0.00   | -78.58  |
| a94f8c5f | 3d872c4e                             | 7/78.58         | 54/0.00          | 78.58  | +78.58  |
| 0257bf5d | a24711c1                             | 4/113.76        | 2/198.08         | 113.76 | -84.32  |
| 0257bf5d | a6951550                             | 5/0.00          | 3/143.20         | 0.00   | -143.20 |
| 0257bf5d | a621706d                             | 6/0.00          | 4/113.76         | 0.00   | -113.76 |
| 0257bf5d | 9dc5344d                             | 2/198.08        | 11/0.00          | 198.08 | +198.08 |
| 0257bf5d | 9dcf6e6b                             | 3/143.20        | 17/0.00          | 143.20 | +143.20 |
| bb179b59 | 00000000-0000-0000-0000-000000000015 | 4/0.00          | 2/28.87          | 0.00   | -28.87  |
| bb179b59 | 00000000-0000-0000-0000-000000000018 | 5/0.00          | 3/20.87          | 0.00   | -20.87  |
| bb179b59 | 00000000-0000-0000-0000-000000000037 | 2/28.87         | 18/0.00          | 28.87  | +28.87  |
| bb179b59 | 00000000-0000-0000-0000-000000000033 | 3/20.87         | 20/0.00          | 20.87  | +20.87  |
| 236d8826 | fc9fa68f                             | 4/28.44         | 2/49.52          | 28.44  | -21.08  |
| 236d8826 | 3fe15f75                             | 5/0.00          | 3/35.80          | 0.00   | -35.80  |
| 236d8826 | 611cf850                             | 6/0.00          | 4/28.44          | 0.00   | -28.44  |
| 236d8826 | 289adf4a                             | 2/49.52         | 6/0.00           | 49.52  | +49.52  |
| 236d8826 | 60f7edc9                             | 3/35.80         | 30/0.00          | 35.80  | +35.80  |
| 8d3a37b0 | 6288fdc6                             | 5/0.00          | 2/23.10          | 0.00   | -23.10  |
| 8d3a37b0 | aaa1dbd5                             | 6/0.00          | 3/16.69          | 0.00   | -16.69  |
| 8d3a37b0 | a85c6ca0                             | 2/23.10         | 15/0.00          | 23.10  | +23.10  |
| 8d3a37b0 | 8ef81aac                             | 3/16.69         | 17/0.00          | 16.69  | +16.69  |
| 09ac876f | 38563ca3                             | 9/0.00          | 2/25.98          | 0.00   | -25.98  |
| 09ac876f | 13f916ec                             | 10/0.00         | 3/18.79          | 0.00   | -18.79  |
| 09ac876f | 6f5fd01a                             | 3/18.79         | 4/0.00           | 18.79  | +18.79  |
| 09ac876f | 61e51804                             | 2/25.98         | 5/0.00           | 25.98  | +25.98  |
| 4366c4c0 | de07f928                             | 3/51.28         | 2/70.95          | 51.28  | -19.67  |
| 4366c4c0 | 93e59b77                             | 4/40.74         | 3/51.28          | 40.74  | -10.54  |
| 4366c4c0 | 6b95593e                             | 5/34.09         | 4/40.74          | 34.09  | -6.65   |
| 4366c4c0 | be7ecf8c                             | 6/29.42         | 5/34.09          | 29.42  | -4.67   |
| 4366c4c0 | 7c165d15                             | 7/0.00          | 6/29.42          | 0.00   | -29.42  |
| 4366c4c0 | 7817543d                             | 2/70.95         | 17/0.00          | 70.95  | +70.95  |
| 7d240805 | 00000000-0000-0000-0000-000000000004 | 3/96.00         | 2/132.78         | 96.00  | -36.78  |
| 7d240805 | face0000-0000-0000-0000-000000000005 | 4/76.26         | 3/96.00          | 76.26  | -19.74  |
| 7d240805 | 9830c0e9                             | 5/63.78         | 4/76.26          | 63.78  | -12.48  |
| 7d240805 | 5a2be214                             | 6/0.00          | 5/63.78          | 0.00   | -63.78  |
| 7d240805 | 00000000-0000-0000-0000-000000000009 | 2/132.78        | 29/0.00          | 132.78 | +132.78 |
| 29c85b8b | 294fd624                             | 5/0.00          | 3/32.91          | 0.00   | -32.91  |
| 29c85b8b | c2bbe90b                             | 3/32.91         | 16/0.00          | 32.91  | +32.91  |
| 9320fe50 | f69498c4                             | 13/0.00         | 3/67.14          | 0.00   | -67.14  |
| 9320fe50 | f9e96cd6                             | 5/44.58         | 4/53.34          | 44.58  | -8.76   |
| 9320fe50 | c6dbc079                             | 42/0.00         | 5/44.58          | 0.00   | -44.58  |
| 9320fe50 | c46f04f8                             | 9/27.90         | 6/38.52          | 27.90  | -10.62  |
| 9320fe50 | 781b24c7                             | 8/30.60         | 7/34.08          | 30.60  | -3.48   |
| 9320fe50 | 48c15f8b                             | 6/38.52         | 8/30.60          | 38.52  | +7.92   |
| 9320fe50 | 2a763abd                             | 4/53.34         | 9/27.90          | 53.34  | +25.44  |
| 9320fe50 | 1ba20655                             | 7/34.08         | 10/25.62         | 34.08  | +8.46   |
| 9320fe50 | 217b726d                             | 3/67.14         | 11/23.76         | 67.14  | +43.38  |
| 9320fe50 | 62d0cfe7                             | 10/25.62        | 20/0.00          | 25.62  | +25.62  |
| 9320fe50 | ea994444                             | 11/23.76        | 37/0.00          | 23.76  | +23.76  |
| 6f6dab21 | 88323ada                             | 7/0.00          | 4/25.59          | 0.00   | -25.59  |
| 6f6dab21 | 8703e327                             | 4/25.59         | 10/0.00          | 25.59  | +25.59  |

**Evidence pattern**

- The misplaced winners were recorded in batches: eliminated_at 2026-09-10 15:45:37 from migration 20260910154537_the_busts_the_door_can_now_accept_are_recorded (door called with now(); the events completed 15:46–15:51), 09-09 20:56:1x, 09-10 07:53–07:54 and 09-10 13:58–14:00.
- The gap between bust and record reaches 168,061 s. Example: 60f7edc9 busted 09-08 17:04:36, was recorded 09-10 15:45:37 and paid as 3rd.

**Exact tie in 9320fe50 (hand 8796072, 09-10 01:24:10.358)**

- 9 players were all-in with 198,000 each; 2 chopped the pot and 7 busted with identical stack_before.
- Places 4–10 are therefore decided only by the user_id tiebreak in the task rule.
- Under an equal split (TDA), each of the 7 gets 36.38 (×5) or 36.37 (×2) of 254.64. That event's over/under becomes about 120.07 instead of 134.58.
- No other exact tie touches a paid place.

**Flagged: true order cannot be derived (never guessed)**

1. **5b3e294b-a15f-455e-be6f-403db0389ff9, Mid-Morning Turbo (6-Max NLH)** (pool 427.00, field 24).
   - 1c33a761 (rat_92) has one candidate, b577470c (hand 8669695, bust 09-09 10:10:52.33), and it is marked 'rebought'. A 10.00 rebuy leg was posted at 10:11:03.97.
   - The player was never seated again: one seat, left at 10:10:55.832, and no hand commit after 8669695. They were recorded 2nd and paid 123.27.
   - The other 22 eliminations are derivable.
   - If the 10:10:52 bust is final: 00000000-0000-0000-0000-000000000038 is true 2nd (123.27; paid 89.12, delta −34.15), df9b5404 is true 3rd (89.12; paid 0, delta −89.12), and 1c33a761 is true 24th (delta +123.27). The 10.00 rebuy was never played.
   - Needs a decision.
2. **d6f7a7e2-6e55-400d-a81c-581a586c541a, $100 Freeroll • 6:00 AM** (pool 765.10, field 391). All 390 eliminations predate the candidate table (busts 09-08 12:16–17:17; first candidate 09-08 15:03:28) and have no hand commits. It was settled 09-09 17:18 by reconcile.
3. **a9be040d-0cd4-4d71-9056-a48cfc85ce58, Morning Free Buy (NLH)** (pool 459.00, field 200). 181 of 199 eliminations have no candidate and no hand commit (pre-candidate era).

**Missing candidate, but the order is still proven (27 events; money unaffected in all)**

- 21 heads-up satellites (field 2).
- 6 Spins at 2x–5x where the player without a candidate was never dealt a hand and was recorded before any other bust: 6aeb091f, 19cf9300, f42d2882, cfb67570, 72b27269, 5f790c02.

## B. Totals (15 paid events, rule as specified)

- **Overpaid:** 1,436.78 over 28 player-rows (28 players).
- **Underpaid:** 1,436.78 over 34 player-rows (33 players; 13f916ec DrBull is underpaid in both d43d67f9 and 09ac876f).
- **Balance:** every event nets to zero, and paid total = pool.
- **Distinct affected players:** 60 (a6951550 fat_flannel is +20.00 in cfecf786 and −143.20 in 0257bf5d). **Humans 0, horses 60.**
- **Underpaid by host:** club 2a1132b9 (4 DSS events) 317.02 (a94f8c5f 78.58, 4366c4c0 70.95, 29c85b8b 32.91, 9320fe50 134.58). fade0000 (the other 11 events) 1,119.76.
- **Not included:** flagged 5b3e294b (conditional ±123.27, plus the unplayed 10.00 rebuy) and the equal-split alternative for 9320fe50.

## C. RUNNING events (494 RUNNING, 64 with eliminations)

**The investigator's metric reproduces exactly:** 20 events, 689 rows placed above a player who busted more than 60 s later, 13 of those carrying a provisional prize, in 5 events.

**Exact comparison**

- Method: true place from the bust hand. Busts still pending at the door are included, because they will finish below everyone still alive.
- 119 rows carry a provisional prize, in 25 events. 41 of them, in 9 events, carry the wrong prize for their true place.
- 20 rows, in 7 events, have a paid true place but no prize.
- No money has moved: 0 tournament_payouts, obligations are bounty-only (106 bounty + 6 mystery_bounty), and there is no place batch.

| event                                | name                                           | pool   | field | alive                | provisional-prize rows | wrong | missing prize | over if unfixed | under if unfixed |
| ------------------------------------ | ---------------------------------------------- | ------ | ----- | -------------------- | ---------------------- | ----- | ------------- | --------------- | ---------------- |
| 5aa7eeba-4c49-4912-b6c5-79053d1cba92 | Midweek Mystery                                | 600.00 | 60    | 1                    | 3                      | 3     | 2             | 0.00            | 209.52           |
| fe72385b-a5c8-4ba1-aff9-0183fcb2e0fd | Morning Free Buy (NLH)                         | 260.90 | 23    | 2                    | 1                      | 1     | 1             | 54.45           | 54.45            |
| 798866ae-019a-4fa5-b3e4-5dea61c7cdf6 | Early Bird Freeroll (NLH)                      | 100.20 | 86    | 1 (+2 pending busts) | 6                      | 6     | 6             | 23.86           | 52.96            |
| 7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d | $100 Freeroll • 12:00 PM                       | 204.40 | 385   | 4 (+3 pending busts) | 32                     | 19    | 3             | 6.08            | 30.83            |
| 9536150e-7b7b-4914-af22-deeab3766d86 | DSS Wednesday $11 NLH Mystery Bounty • 8 PM CT | 144.00 | 24    | 1                    | 2                      | 1     | 1             | 30.06           | 30.06            |
| bee519fa-ff07-438c-9542-d386fc821908 | Afternoon Free Buy (NLH)                       | 304.00 | 167   | 12                   | 5                      | 3     | 3             | 22.46           | 22.46            |
| f922df63-a780-4482-86c4-55d8a4199311 | Midday Free Buy (NLH)                          | 250.00 | 194   | 13                   | 7                      | 4     | 4             | 20.56           | 20.56            |
| a5aa6984-6c1c-4b59-aeb7-9e7878853bdd | Early Bird Freeroll (NLH)                      | 99.30  | 100   | 2                    | 8                      | 2     | 0             | 1.05            | 1.05             |
| d7997aef-0a69-4c0a-b074-aa63d8ba40fe | $100 Freeroll • 6:00 AM                        | 171.20 | 391   | 18                   | 22                     | 2     | 0             | 0.04            | 0.04             |

Totals if these events finished on today's ranking: 158.56 over and 421.93 under. It is not zero-sum because 5aa7eeba has no prize written yet for places 2–3.

**Affected rows** (rec → true; prize rec → true)

- **5aa7eeba:** bc43a03f 4→2 (69.84→121.62); d2880af2 2→3 (0.00→87.90); 2b36fe05 5→4 (58.44→69.84); 551eef11 6→5 (50.46→58.44); 9e5abf96 14→6 (0.00→50.46).
- **fe72385b:** fb7da841 8→3 (0.00→54.45); f8c8eb13 3→12 (54.45→0.00).
- **798866ae:**
  - 9da2d0b7 4→2 (9.70→16.89); 9bb330b7 unrecorded→3 (12.21); a0d2909b 5→4 (8.12→9.70).
  - e0be3976 19→5 (8.12); ae75d87e 20→6 (7.01); acbf88b1 21→7 (6.20); b1dd1863 22→8 (5.57); 65f99ae2 unrecorded→9 (5.08).
  - a45c237c 6→76 (7.01→0); 778cab7d 7→74 (6.20→0); 767bd910 8→75 (5.57→0); ad5bd851 9→78 (5.08→0).
- **7aa16fa7:**
  - Unrecorded busts: 3a7ad729 →5 (9.42), f44d72f2 →6 (8.14), f8058099 →7 (7.19).
  - Moving up: 28d30605 13→12, 8376185d 18→14, 00000000-…-000000000041 19→15, eb2e16b6 20→16, 660d14dc 21→17, cb50fee0 29→19, 8338bf08 30→20, 2143ec37 25→21, 00000000-…-000000000017 26→22, f687be6b 27→23, 57d5af45 28→24.
  - Moving down: 373a7bc7 12→13, ef1baf0a 14→18, 0097309f 15→25, 2478c921 16→26, f45f73b2 17→27, 54a0a8e8 22→28, 4aa0d45c 23→29, 00000000-…-000000000050 24→30.
  - Each move is worth 0.31–1.30.
- **9536150e:** 5a21988c 4→3 (0.00→30.06); 8339a681 3→19 (30.06→0.00).
- **bee519fa:** 631a3049 103→15 (7.87), a0dbce6c 104→16 (7.48), 4f0bbf2a 105→17 (7.11); 01bd8786 15→20, 559c9e97 16→21, 7a720598 17→23 (these three lose 7.87, 7.48, 7.11).
- **f922df63:** 3b79b8a6 131→17 (5.50), 4f0bbf2a 132→18 (5.25), 632df610 133→19 (5.03), 7817543d 134→20 (4.78); 1ba20655 17→22, 1179f15e 18→23, e4894901 19→24, 06f16138 20→25 (these four lose 5.50, 5.25, 5.03, 4.78).
- **a5aa6984:** 5e94c522 6→5 (6.64→7.69); 32a4fc92 5→6 (7.69→6.64).
- **d7997aef:** c025d7b4 38→37 (1.54→1.58); b4cd2cf5 37→38 (1.58→1.54).

**What the finish-time fix needs**

1. **Rank by the bust hand and recompute prize for every moved row.** 5aa7eeba and 9536150e are stuck with one player left: 20260910154537 wrote place 2–3 rows with prize 0, so the prepare function will refuse them.
2. **Don't rely on the latest candidate alone: 6 are stale.** The candidate marked 'eliminated' is an earlier bust the player came back from: rebuy chips were delivered and played, and the real last bust has no candidate.
   - Affected: 7aa16fa7 71efcdb3; 798866ae 22af2652, 20a40df1, 6d6b3cc2, 45a5e770; a5aa6984 55256246.
   - None reaches a paid place. The witness is the hand commit where the stack last went to 0.
   - The investigator's 798866ae repair SQL would stamp those 4 players' eliminated_at from their stale candidates (for example 22af2652 at place 86 instead of 14). That is not money, but the stamps would be wrong.
3. **Exact ties:** 7aa16fa7 has 3 same-hand, same-stack pairs; the difference is at most 0.23 each.
4. **Live risk:**
   - 8e16cdb4 Prime Time Free Buy (NLH): pool 718.00, field 279, 21 left at 06:55.
   - 190 of its 258 eliminations are out of true order, with record lag up to 767 s. Its 7 provisional prizes are still right.
   - It is entering the 28 paid places and will pay on eliminated_at order if it finishes before the fix ships.

## D. The 6 orphan candidates (all have a later rebuy ledger leg)

| event    | user     | orphan candidate (hand, bust)          | rebuy leg(s) after the bust                                         | chips delivered and played?                                               | real later bust                                          | resolve to 'rebought'                                                                                               |
| -------- | -------- | -------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 798866ae | 9bb330b7 | 25f47c6b (8550341, 09-09 05:27:52.469) | 1.00 @05:27:55.790, 1.00 @05:28:32.179                              | yes: seat 8ce38f80 from 18:00:35 starting at 2,500, played to 09-10 15:02 | fca7f2ac (9166239, 09-10 15:02:20.535), pending          | SAFE, but only in one transaction with the standings/prize rewrite and closing 65f99ae2's zero-stack chair b39e7320 |
| 7aa16fa7 | 3a7ad729 | e0964903 (8260256, 09-08 18:05:51.261) | 1.00 @18:05:52.829, 1.00 @18:05:55.683                              | yes: 5,000 then 10,000 (hands 8260652, 8260865)                           | 0d36acc0 (9313543, 09-11 02:00:24.202)                   | SAFE                                                                                                                |
| 7aa16fa7 | f44d72f2 | 52df5865 (8260161, 18:05:29.725)       | 1.00 @18:05:31.548, 1.00 @18:05:34.692                              | yes: 5,000 then 10,000                                                    | 0c2c1faf (9303810, 09-11 01:33:10.822)                   | SAFE                                                                                                                |
| 7aa16fa7 | f8058099 | 4216a918 (8261342, 18:08:15.723)       | 1.00 @18:08:17.595, 1.00 @18:08:22.618                              | yes: 5,000 then 9,808                                                     | 3e4435c1 (9303770, 09-11 01:32:29.664)                   | SAFE                                                                                                                |
| a5aa6984 | 4f7f8abb | d29d729e (8579957, 09-09 06:30:05.326) | 1.00 @06:30:08.112                                                  | yes: played from 06:40:35 at 2,500; live seat d34c66cb now 320,000        | none yet (latent: the door would refuse their next bust) | SAFE                                                                                                                |
| a5aa6984 | dca6c345 | d0ac2895 (8569325, 09-09 06:13:09.079) | 1.00 @06:28:26.464, 14m47s after the rebuy prompt closed (06:13:39) | no: 2,500 roster chips, no live seat, no hand commit since 8569325        | none                                                     | NOT SAFE on its own (see below)                                                                                     |

**Why dca6c345 is not safe**

- Flipping the candidate leaves a seatless 'playing' player in a 2-player event. Any recording path would then stamp now() and place them 2nd, when their true bust was 09-09 06:13:09.
- Option 1: resolve it and actually seat them with 2,500, honouring the rebuy they paid for.
- Option 2: record them at their bust time and refund the 1.00. That needs the exact refund authority, because `fn_settle_tournament_obligation` refuses kind 'refund'.

**Observation, not part of the orphan fix:** 9bb330b7 paid 2.00 for two rebuys but played only 2,500 chips. The other 2,500 sit on closed seat 5724c3c7 (table 7d9f48fa).

**Current state (06:47 UTC)**

- **798866ae:** RUNNING, current_players 3. f12caf56 has chips; 9bb330b7 busted but the door refuses it; 65f99ae2 sits on a zero-stack chair. Last hand 09-10 15:03:24. 3 pending candidates. No payouts, obligations or batch. Escrow prize_balance 100.20 = pool.
- **7aa16fa7:** RUNNING, 7 players: 4 with chips on 4 live seats and 3 busted but unrecorded. Last hand 09-11 02:00:24. 6 pending candidates. No place money moved. Escrow 204.40 = pool.
- **a5aa6984:** RUNNING, 2 players: 4f7f8abb seated with 320,000 and dca6c345 with no seat. Last hand 09-10 12:51:01. 2 pending candidates. No money moved. Escrow 99.30 = pool.

## E. Correction path for the 15 paid events

**What each existing door does here**

- **`fn_tournament_payout_reconcile(uuid,boolean)`:** returns `pool_fully_discharged` for all 15 (paid = pool), so no top-up. Per place it also refuses `place_paid_to_a_different_player`, and it only reports 'overpaid'; it never claws back.
- **`fn_settle_tournament_obligation(...)`** (via `_before_atomic_batch_gate`):
  - An external caller needs an approved `ca_manual_adjustments` row, written by `fn_ca_adjustment_under_10_9`.
  - It refuses `place_paid_to_another_user`: every underpaid player's true place is held and paid by someone else.
  - It refuses `player_already_holds_a_place`: 10 underpaid rows already hold a paid place.
  - It needs escrow funds. All 15 escrows have prize_balance 0.00 and are closed; 13 also have terminal_closed_at set and a terminal settlement receipt.
- **`fn_credit_and_log(..., p_payout_position, p_payout_source)`:** 'finish_position_correction' is in the closed payout vocabulary. `fn_tournament_payout_shape` already maps keys shaped `tourney:<id>:vacantplace:<user>:<place>` to that source.
- **House funding:** chip_ledger category 'correction' (club_treasury or union_bank → prize_liability), as in 20260909060341_bubble_protection_is_funded_by_the_house_not_the_winner. `fn_ca_post_correction` is journal-only and needs an incident or write-failure link.

**Blocker:** the trigger `fn_terminal_tournament_evidence_is_immutable`, on tournament_payouts, tournament_obligations, tournament_players and chip_ledger, raises on every INSERT naming a COMPLETED tournament. `fn_terminal_tournament_escrow_is_immutable` guards the escrow. None of the doors above can write a correction to these events today; the 09-09 precedent predates that trigger.

**Moving money between players:** not supported and not permitted.

- There is no tournament debit or clawback door. The 'clawback' source and key grammar exist only as vocabulary; `fn_credit_and_log` only credits positive amounts; `fn_clawback_chips_atomic` is for agent chip_transactions, not tournaments.
- CLAUDE.md 10.9 rule 3 forbids taking money back from a player for a platform defect.
- It would need new code and Dan's explicit decision. Not recommended.

**Recommendation**

1. **Leave the 28 overpaid rows alone.** The house absorbs 1,436.78, all paid to horses, and the report records it.
2. **House-fund the back-pay:** 1,436.78 to the 34 underpaid rows (33 players), per event, from the host bank: club 2a1132b9 treasury 317.02; fade0000 bank 1,119.76.
3. **This needs new code, in one migration with a reserved version** (scripts/reserve-migration-version.sh):
   - An append-only correction receipt per (event, player): recorded place and paid amount, true place and amount owed, candidate id, hand number, committed_at.
   - A narrowly scoped exemption in `fn_terminal_tournament_evidence_is_immutable` for inserts that carry a matching receipt.
   - Per event: a 'correction' funding leg from the host bank to prize_liability.
   - Per player: `fn_ca_adjustment_under_10_9` with a paragraph naming every affected player, then `fn_credit_and_log(user, delta, 'tourney:<tid>:vacantplace:<user>:<true_place>', 'prize', ..., <tid>, 'PLAYER', NULL, NULL, <true_place>, 'finish_position_correction')`, which is idempotent per player.
   - Do not rewrite tournament_players or the two frozen batches (cfecf786, d7882afc); correct forward.
   - Prove it in a self-aborting DO block first, then write the changelog and resolve the financial_alerts row.
4. **Decisions needed before paying:** the 9320fe50 seven-way tie (user_id tiebreak or equal split); 5b3e294b (1c33a761's unplayed 10.00 rebuy). d6f7a7e2 and a9be040d cannot be derived and stay as settled.
5. **RUNNING events:** fix at finish with the normalizer change (rank by bust hand, recompute prize, use the hand witness for stale candidates), resolve the orphans, and close 65f99ae2's zero-stack chair. Every door stamp should use the bust commit time, not now().

Helper scripts and the read-only extracts used for this audit are in /tmp/ko_audit_0911 on the Mac (67 MB of production dumps); they can be deleted.

## tests_run

All read-only; production writes: none. Every psql session ran with default_transaction_read_only=on and statement_timeout 20s, SELECT and COPY-to-file only.

- Extracted all 10,556 COMPLETED events (ended 09-09 00:00 to 09-11 06:25 UTC) and the 494 RUNNING events: players, candidates with their exact hand_atomic_commits, payouts, obligations, batches, chip_ledger prize and bounty legs, spin_payout_ladder, and live seats.
- Ported fn_prepare_tournament_place_obligations exactly in Python: numeric round half away from zero, spin ladder, trimming, LEAST clamp, remainder to the last place. Validation: recorded prize equals the rule's prize at the recorded place for all 33,249 rows; paid equals recorded prize equals payout rows for every row.
- Checked every candidate against the hand commits (stack_result.written and request.stacks): 22,094 of 22,094 candidate-backed completed eliminations agree. 6 stale candidates found in RUNNING events.
- SQL recomputation for 0257bf5d matches the Python result.
- The investigator's RUNNING metric reproduces exactly: 20 events, 689 rows, 13 prize rows, 5 events.
- Read the definitions (pg_get_functiondef) of fn_normalize_tournament_final_standings, fn_tournament_payout_reconcile, fn_settle_tournament_obligation(+\_before_atomic_batch_gate), fn_credit_and_log, fn_credit_player_wallet_once, fn_tournament_payout_shape, fn_ca_post_correction, fn_ca_adjustment_under_10_9 and fn_terminal_tournament_evidence_is_immutable. Also read the chip_ledger and tournament_payouts check constraints, and the triggers on the payout, obligation, player, escrow and ledger tables.

## risks

```json
[
  "Money in 9320fe50 places 4-10 depends on the tiebreak: 7 players busted in hand 8796072 with the same 198,000 stack, and the task rule (user_id) decides their order. An equal split changes that event's over/under from 134.58 to about 120.07.",
  "The latest-candidate rule is wrong for rebuy-chain players whose later bust has no candidate: 6 such players in RUNNING events (0 in completed). The normalizer fix must use the hand-commit witness. The investigator's 798866ae repair SQL would stamp wrong eliminated_at values for 4 players, though no money is affected.",
  "8e16cdb4 (Prime Time Free Buy, pool 718.00, 21 left at 06:55) is entering the paid places with 190 of 258 rows out of true order. It will pay on eliminated_at order if it finishes before the fix ships.",
  "No existing door can write a correction to a COMPLETED event, because fn_terminal_tournament_evidence_is_immutable refuses the insert. The back-pay therefore needs new code, and any exemption must be scoped to a receipt.",
  "RUNNING numbers are a snapshot from 06:39-06:55 UTC and will change as events play on.",
  "Open money questions outside the ordering fix: 9bb330b7 paid 2 rebuys but played 2,500 chips (the other 2,500 sit on closed seat 5724c3c7); 1c33a761 in 5b3e294b paid a 10.00 rebuy and was never seated; dca6c345 bought a rebuy after the prompt window closed and was never seated.",
  "5b3e294b, d6f7a7e2 and a9be040d cannot be derived from candidates and commits and are only flagged."
]
```
