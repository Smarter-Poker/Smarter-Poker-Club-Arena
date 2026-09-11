# Workflow evidence: club-arena-night-investigations

- run: wf_ac970d45-a6e
- finished: 2026-09-11T05:39:22.803Z
- status: completed
- agents: 3
- summary: Read-only root-cause investigations: stuck knockout chains / hand-commit refusals, slow REGISTERING walk, Codex authority commit

## key

knockout-chains

## report

INVESTIGATOR knockout-chains: REPORT (read-only; nothing was written to production or the repo)

TL;DR

- 9bb330b7's first bust (hand 8550341) was real and durable. The player then rebought twice. The rebuy never marked that bust 'rebought', so it is left as an orphan 'pending' row. The live door refuses the player's second, real bust because of that older row.
- 65f99ae2 is NOT refused for unresolved_knockout_generation_chain. In the logs the reason is knockout_generation_has_new_live_seat, every time. A table break at 06:38:36 on 09-09 moved them to a new chair carrying a 0 stack.
- If you only unblock both players, the event finishes and pays the wrong people. The door stamps eliminated_at=now(), and the paying code ranks finishing places by eliminated_at, so late-recorded busts get better places. About 35.67 of the 100.20 pool would go to the wrong players. A correct repair has to rewrite the standings too (SQL in section 5).
- The loop stopped at 04:55:04, when the synchronized break started. Since then the log shows only blind-level lines. The database state is unchanged (checked 05:12). The event is frozen, not looping.

1. Why 9bb330b7 has a second stack

- The first bust is real and durable:
  - hand_atomic_commits (7d9f48fa, 8550341, c98bf947) committed at 2026-09-09 05:27:52.469, with written[9bb330b7]=0.00.
  - settlement_idempotency_keys a7398a8d… is 'succeeded' with written=0.00.
  - hand_history c98bf947 shows stack 0. The hand was not rolled back.
- The player rebought twice:
  - chip_ledger has two 'rebuy' legs of 1.00 each (wallet to prize_liability), at 05:27:55.790 and 05:28:32.179.
  - tournament_players.rebuys=2.
  - The old Table 9 seat 5724c3c7 was closed at 05:27:55.75 and still shows stack 2500.
- Between hand 8550341 (05:27:52) and 18:01:25 there are no hand_history rows for 9bb330b7, so the player had no seat for 12.5 hours.
- Seat 8ce38f80 on Table 4 opened at 2026-09-09 18:00:35.006722. The settlement request for hand 8732750 shows stack_before=2500, so the new chair started with one rebuy's chips, not two.
- The player won up to 117500 by 18:03:08. On 09-10 the stack went 117500 → 15000 → 15000 → 30000, then 0 at hand 9166239 (15:02:20). The 30000 is the stack at the start of that second bust hand, not the seating stack.
- Why the orphan exists:
  - The migration header of 20260909071226 says the rebuy chain was skipping fn_after_tournament_rebuy, the only statement that set a candidate to 'rebought'. That function no longer exists in production.
  - In this event, no candidate was marked 'rebought' when the rebuy happened. All five 'rebought' rows were resolved within 31 ms of their next bust being recorded. That matches the 20260909005925 door, which auto-resolved older pending generations. The live door refuses instead (20260910171911 lines 166-175; the production body matches, md5 b4937067…).
  - The one-time fix 20260910124524 only fixed candidates that already had a newer candidate. This player's second bust came at 15:02:20 on 09-10, after that fix ran. I can infer this because the fix's own post-condition would otherwise have resolved 25f47c6b.

2. Why 65f99ae2 is refused (the premise is wrong)

- Retained engine logs (04:16–04:55):

  | Player   | Refusals | Reason                                |
  | -------- | -------- | ------------------------------------- |
  | 65f99ae2 | 357      | knockout_generation_has_new_live_seat |
  | 9bb330b7 | 356      | unresolved_knockout_generation_chain  |

  65f99ae2 never appears with the chain reason.

- Walking the function body for 65f99ae2:
  - The latest candidate is 42f25fbc: hand 8584595, table e2a4df2f, seat 29a0a51e, joined 06:37:59.305.
  - The receipt checks pass. The newer-candidate check (lines 157-165) and the older-candidate check (lines 166-175) cannot fire with a single candidate. The state check passes, and rebuy_prompt_until is NULL.
  - There is one live seat, b39e7320 on d1b33e24, stack 0, joined 06:38:36.34.
  - Lines 206-218 compare that seat with the candidate: the table differs (d1b33e24 vs e2a4df2f), the seat id differs, and joined_at differs. That returns knockout_generation_has_new_live_seat.
- How the seat was created:
  - The bust hand 8584595 ended 06:38:34.66.
  - The Table 3 seat was left at 06:38:36.109, and the Table 2 chair was created at 06:38:36.34 with stack 0. ae75d87e left Table 3 at 06:38:37, and Table 3 closed at 06:38:38. This was a table break.
  - The move left no tournament_seat_move_receipts row. 65f99ae2 has played no hand since.

3. tournament_players rows

| Player                | status  | chips / chip_count | position | prize | rebuys | table / seat | eliminated_at |
| --------------------- | ------- | ------------------ | -------- | ----- | ------ | ------------ | ------------- |
| f12caf56 (MiaBama)    | playing | 252500 / 0         | NULL     | 0.00  | 0      | d1b33e24 / 2 | NULL          |
| 9bb330b7 (hawk_82)    | playing | 0 / 0              | NULL     | 0.00  | 2      | 16dd114e / 2 | NULL          |
| 65f99ae2 (SlyAnteDoc) | playing | 0 / 0              | NULL     | 0.00  | 0      | d1b33e24 / 1 | NULL          |

- 9bb330b7's table/seat is stale: that table is closed and the seat was left at 15:02:20 on 09-10. 9bb330b7 has no live seat.
- All three have rebuy_prompt_until, elimination_sequence and terminal_closed_at NULL.
- The other 83 players are eliminated with distinct positions 4–86. tournaments.current_players=3.
- No payouts, obligations or place batch exist yet. Escrow prize_balance is 100.20.

4. Other tournaments in the same state

- Pending candidates blocked by an older non-rebought candidate: 4 rows in 2 RUNNING events.
  - 798866ae: 9bb330b7.
  - 7aa16fa7 "$100 Freeroll • 12:00 PM": 3a7ad729, f44d72f2, f8058099. Each busted on 09-08 between 18:05 and 18:08, has two 1.00 rebuy legs seconds apart, and busted again on 09-11 between 01:31 and 02:00.
  - 7aa16fa7 still has 4 players with chips. The retained logs since 04:16 show no door attempts for it.
- Latent orphans (latest candidate pending, but the player holds chips again): 2, both in a5aa6984 "Early Bird Freeroll (NLH)".
  - 4f7f8abb has a live seat with 320000.
  - dca6c345 has 2500 roster chips and no seat at all.
  - The event is frozen: current_players=2 and no hands in the last 2 hours.
- Live seats with stack 0 in RUNNING events: 1 (798866ae / 65f99ae2).
- The two cleanup sweeps are disabled: cron jobs 364 (fn_ca_eliminate_absent_tournament_players) and 365 (fn_ca_release_broke_seats) are active=f. Both also skip any player whose latest candidate is not 'rebought'.

5. Repair

Why unblocking alone pays the wrong people

- The door's legacy function (fn_eliminate_player_legacy_candidate_20260907) sets eliminated_at=now().
- fn_normalize_tournament_final_standings and fn_prepare_tournament_place_obligations rank places by eliminated_at. The engine comment at TournamentManagerEliminations.ts:1019-1023 assumes eliminated_at is the bust time; it is not.
- In this event, 64 of the 83 eliminations were recorded more than a minute after the bust, and 26 more than an hour after (up to 26h42m). The 07:53 batch on 09-10 comes from the rows that 20260910072322 put back to 'playing'.
- If only the two players are unblocked, the normalizer changes nothing (checked: 0 of 83 rows would move). The engine orders busts by the earliest pending hand, but with both fixes the order is 65f99ae2 first, then 9bb330b7. Payouts would be:

| Place | Pays after unblock only | Correct by bust order (the rule the normalizer states) | Correct prize |
| ----- | ----------------------- | ------------------------------------------------------ | ------------- |
| 1     | f12caf56                | f12caf56                                               | 29.42         |
| 2     | 9bb330b7                | 9da2d0b7                                               | 16.89         |
| 3     | 65f99ae2                | 9bb330b7                                               | 12.21         |
| 4     | 9da2d0b7                | a0d2909b                                               | 9.70          |
| 5     | a0d2909b                | e0be3976                                               | 8.12          |
| 6     | a45c237c                | ae75d87e                                               | 7.01          |
| 7     | 778cab7d                | acbf88b1                                               | 6.20          |
| 8     | 767bd910                | b1dd1863                                               | 5.57          |
| 9     | ad5bd851                | 65f99ae2                                               | 5.08          |

- a45c237c, 778cab7d, 767bd910 and ad5bd851 busted between 05:15 and 05:27 on 09-09. By bust order they finish around places 72–75.

Never apply one fix without the other

- The skip-after-3-refusals rule (BUST_REFUSAL_SKIP_AFTER=3, TournamentManagerBase.ts:269; TournamentManagerEliminations.ts:1025) records the other player within seconds.
  - Closing the seat alone records 65f99ae2 at place 3.
  - Fixing the orphan alone records 9bb330b7 at place 3 and leaves 65f99ae2 stuck.

Correct data repair (one transaction; dry-run it ending in ROLLBACK first, then COMMIT)

```sql
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';
DO $pre$ DECLARE v_t public.tournaments%ROWTYPE; BEGIN
  SELECT * INTO v_t FROM public.tournaments WHERE id='798866ae-019a-4fa5-b3e4-5dea61c7cdf6' FOR UPDATE;
  IF v_t.status<>'RUNNING' OR coalesce(v_t.is_bounty,false) OR coalesce(v_t.is_pko,false) OR coalesce(v_t.is_mystery_bounty,false) THEN RAISE EXCEPTION 'event moved'; END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts WHERE tournament_id=v_t.id) OR EXISTS (SELECT 1 FROM public.tournament_obligations WHERE tournament_id=v_t.id)
     OR EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches WHERE tournament_id=v_t.id) THEN RAISE EXCEPTION 'money already moved'; END IF;
  PERFORM 1 FROM public.tournament_players WHERE tournament_id=v_t.id ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM public.tournament_players WHERE tournament_id=v_t.id AND status='playing')<>3
     OR NOT EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id=v_t.id AND user_id='f12caf56-c369-4b22-8e04-fdda07820876' AND status='playing' AND chips>0)
     OR (SELECT count(*) FROM public.tournament_knockout_candidates WHERE tournament_id=v_t.id AND state='pending')<>3
     OR (SELECT count(*) FROM public.tournament_knockout_candidates WHERE state='pending' AND id IN ('25f47c6b-7228-486a-af66-70000a7e3912','fca7f2ac-3b05-4b72-ab23-3ecde38e0f04','42f25fbc-b0f9-4a3c-be89-dee8f510801a'))<>3
     OR (SELECT count(*) FROM public.chip_ledger WHERE tournament_id=v_t.id AND category='rebuy' AND from_entity_id='9bb330b7-a66a-4c52-b19c-d932ae07a354' AND created_at>'2026-09-09 05:27:52.44+00')<>2
     OR NOT EXISTS (SELECT 1 FROM public.table_seats WHERE id='b39e7320-d41b-4ab7-9665-146c5d7bc90e' AND user_id='65f99ae2-cd2e-46a2-be72-c47361552350' AND left_at IS NULL AND stack=0)
  THEN RAISE EXCEPTION 'board moved since investigation'; END IF; END $pre$;
UPDATE public.tournament_knockout_candidates SET state='rebought', resolved_at=clock_timestamp()
 WHERE id='25f47c6b-7228-486a-af66-70000a7e3912' AND state='pending';
UPDATE public.table_seats SET left_at=clock_timestamp(), status='left', leave_pending=false, is_sitting_out=false, is_away=false, sit_out_at=NULL, scheduled_leave_hands=NULL
 WHERE id='b39e7320-d41b-4ab7-9665-146c5d7bc90e' AND user_id='65f99ae2-cd2e-46a2-be72-c47361552350' AND left_at IS NULL AND stack=0;
UPDATE public.tables tb SET current_players=(SELECT count(*) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL) WHERE tb.id='d1b33e24-5f0e-4a06-ac03-a7d892a11e52';
CREATE TEMP TABLE canon ON COMMIT DROP AS
WITH t AS (SELECT prize_pool, payout_structure::jsonb ps FROM public.tournaments WHERE id='798866ae-019a-4fa5-b3e4-5dea61c7cdf6'),
field AS (SELECT count(*)::int n FROM public.tournament_players WHERE tournament_id='798866ae-019a-4fa5-b3e4-5dea61c7cdf6'),
fb AS (SELECT tp.id tp_id, c.id cand_id,
         a.committed_at + make_interval(secs => (row_number() OVER (PARTITION BY c.hand_number ORDER BY c.stack_before, tp.user_id)-1)/1000000.0) bust_at
       FROM public.tournament_players tp
       JOIN LATERAL (SELECT * FROM public.tournament_knockout_candidates c WHERE c.tournament_id=tp.tournament_id AND c.eliminated_user_id=tp.user_id AND c.state<>'rebought' ORDER BY c.hand_number DESC, c.id DESC LIMIT 1) c ON true
       JOIN public.hand_atomic_commits a ON a.table_id=c.table_id AND a.hand_number=c.hand_number AND a.hand_id=c.hand_id
       WHERE tp.tournament_id='798866ae-019a-4fa5-b3e4-5dea61c7cdf6' AND tp.user_id<>'f12caf56-c369-4b22-8e04-fdda07820876'),
r AS (SELECT fb.*, (SELECT n FROM field) - row_number() OVER (ORDER BY bust_at, tp_id)::int + 1 place FROM fb),
bp AS (SELECT (e->>'place')::int place, round((e->>'percentage')::numeric*100)::bigint bp FROM t, jsonb_array_elements(t.ps) e WHERE (e->>'place')::int <= (SELECT n FROM field)),
c1 AS (SELECT place, CASE WHEN place=(SELECT max(place) FROM bp) THEN NULL ELSE round((SELECT round(prize_pool*100) FROM t)*bp::numeric/(SELECT sum(bp) FROM bp))::bigint END c FROM bp),
plan AS (SELECT place, coalesce(c,(SELECT round(prize_pool*100) FROM t)::bigint-(SELECT sum(c) FROM c1 WHERE c IS NOT NULL)) c FROM c1)
SELECT r.tp_id, r.cand_id, r.bust_at, r.place, coalesce(p.c,0)/100.0 prize FROM r LEFT JOIN plan p ON p.place=r.place;
DO $c$ BEGIN IF (SELECT count(*) FROM canon)<>85 OR (SELECT count(DISTINCT place) FROM canon)<>85 OR (SELECT min(place) FROM canon)<>2
  OR (SELECT max(place) FROM canon)<>86 OR (SELECT sum(prize) FROM canon)<>70.78 THEN RAISE EXCEPTION 'ladder invalid'; END IF; END $c$;
UPDATE public.tournament_players SET position=NULL WHERE tournament_id='798866ae-019a-4fa5-b3e4-5dea61c7cdf6' AND status='eliminated';
UPDATE public.tournament_players tp SET status='eliminated', chips=0, eliminated_at=k.bust_at, position=k.place, prize=round(k.prize,2) FROM canon k WHERE tp.id=k.tp_id;
UPDATE public.tournament_knockout_candidates c SET state='eliminated', resolved_at=clock_timestamp() FROM canon k WHERE c.id=k.cand_id AND c.state='pending';
DO $p$ BEGIN IF (SELECT count(*) FROM public.tournament_players WHERE tournament_id='798866ae-019a-4fa5-b3e4-5dea61c7cdf6' AND status='playing')<>1
  OR EXISTS (SELECT 1 FROM public.tournament_knockout_candidates WHERE tournament_id='798866ae-019a-4fa5-b3e4-5dea61c7cdf6' AND state='pending')
  OR EXISTS (SELECT 1 FROM (SELECT position, 86-(row_number() OVER (ORDER BY eliminated_at,id))::int+1 cp FROM public.tournament_players WHERE tournament_id='798866ae-019a-4fa5-b3e4-5dea61c7cdf6' AND status='eliminated') q WHERE position<>cp)
  THEN RAISE EXCEPTION 'postcondition'; END IF; END $p$;
SELECT public.fn_emit_tournament_manager_wake('798866ae-019a-4fa5-b3e4-5dea61c7cdf6','rebuy');  -- sweep stopped 04:55; 'rebuy' is one of 6 allowed reasons
COMMIT;
```

- I ran the ladder part as a SELECT: it gives 85 rows, places 2–86, and prizes for places 2–9 as in the table. Place 1 (29.42) is written by the engine's finish path.
- The prize rewrite is required, not optional: the normalizer only renumbers positions, and fn_prepare_tournament_place_obligations refuses when a place holder's recorded prize does not match the structure.
- I checked the table_seats and tournament_players triggers by reading them; none should block this, but I have not executed it. The dry-run is the proof.

Code changes needed

- **Orphan candidates.** The candidate is created by fn_ca_commit_hand_settlement_before_lease_generation (it inserts the zero-stack generation). It does not resolve an older pending generation for the same player. The orphaning writer was the 09-08/09 rebuy chain.
  - The live process_tournament_rebuy now resolves its candidate inside the purchase and refuses a chain, so new rebuys will not create orphans.
  - The 6 existing orphans (7aa16fa7 ×3, 798866ae ×1, a5aa6984 ×2) need a correction keyed on "pending with a later rebuy leg", or a door rule that resolves them with that proof.
- **Door timestamp.** The door must stamp eliminated_at from the bust hand (v_atomic.committed_at), not now(). The normalizer must also recompute prize whenever it moves positions.
- **Engine bust order.** TournamentManagerEliminations.ts:635-638 keeps the earliest pending hand per user (`hand < seen`). It should use the latest candidate, the same one the door binds.
- **Zero-stack seats.** No new code is needed. The seat-creation guard (TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK), the mover (refuses stack<=0), and the hand-commit zero-seat release are live. The only zero live seat is the 09-09 legacy one.

6. The hand-commit refusals ("did not durably sync every final seat stack")

- **The check:** migration 20260910054712, lines 610-651, is still live. It writes tournament_players.chips = target, but that column is an integer, then compares tp.chips to the exact numeric target. Any fractional stack fails, the exception block at lines 827-845 rolls the hand back, and the reason is 'rolled_back'.
- **Where fractional stacks come from:** the persisted structure has 12 levels ending at 200/400. Past the end, escalatedBlindLevel (server/src/tournament/blindEscalation.ts) multiplies by ratio^k without rounding, unless the chip cap engages (the cap floors).
- **What the data shows:**
  - All three named events have hand_history at 255.58/511.15 at 00:00:33–00:01:01.
  - Their failed settlement keys: 4131e3e9 had 11 (00:00:42–00:01:49), 27fac5e7 had 9 (00:00:13–00:01:52), 22a10610 had 2 (00:00:13–00:00:28).
  - 12 more heads-up SNGs failed the same way between 00:12 and 01:37. 10 of them show fractional blinds in their hand history at those times.
  - Every hand that did commit at a fractional level ended with whole-number stacks.
  - The failed hands left nothing durable: the next committed hand's stack_before equals the last committed stacks.
  - All 3 named events are now COMPLETED, with winners on 2000 chips and places set.
- **Not happening now:**
  - 0 matching log lines in the last 60 minutes.
  - The last failed key was at 01:37:37.
  - No RUNNING event has had a failed key since 23:30.
  - No live tournament table has fractional blinds and no live seat has a fractional stack.
- **It can recur:** the rounding gap is still in current main. The fix is integer blinds in escalation.

Other things I found that need review

- Standings recorded out of bust order: 20 RUNNING events have 689 rows placed above a player who busted more than a minute later (13 of those rows carry a provisional prize, in 5 events). 11 COMPLETED events (since 09-10 07:00) have 24 such rows that carry a prize.
- In 798866ae, the 13 players now at places 6–18 each paid a 1.00 rebuy after busting and never played another hand.

Files on the Mac: my temporary helper and dump files in /tmp were deleted. The read-only worktree at ~/Documents/.agent-trees/club-arena/claude-review-0911 was not modified.

---

## key

registering-walk

## report

**Result.** A REGISTERING pass on production (build 404948b354) takes **472–605 s right now (median about 520 s)**. Almost all of that is the walk: about 146 seat-first top-ups per pass, run one after another at a median of 2.6 s each, and nearly every one ends "0 of N claimable". The fix below brings the walk down to seconds. Even so, the pass will still take about 50 s, because a separate sweep after the walk costs about 40 s (point 5). Nothing on production or in the worktree was changed.

## 1. Measured pass time (docker logs -t)

- **Marker used:** `[GameServer] Recovering stuck COMPLETING tournament: Breakfast Turbo`. It prints exactly once per pass, from the COMPLETING block right after the walk.
- **Normal passes:** 04:17:34→04:27:38 took 604.5 s. The next ones took 536.5, 482.8 and 482.7 s. After the 05:00 thaw they took 547.6 s (04:59:38→05:08:46), then 519.3 and 471.9 s.
- **Passes during the :53–:00 freeze:** 50.4–58.6 s each. `isMaintenanceFrozen()` breaks the walk at its first row, so this is the part of a pass that has nothing to do with the walk. The walk itself is therefore about 7–9 minutes.
- **One pass in detail (04:36:35–04:44:38):**
  - 188 `holding N horse(s) back ... 0 of N claimable` lines. 42 of them are paired with fast-lane `SEAT-FIRST BOARD CANNOT FILL` lines, which leaves about 146 walk top-ups.
  - Gap between consecutive walk lines: median 2.6 s (p25 2.3, p75 2.9, p90 3.3).
- **What is on the board (DB):**
  - 340 REGISTERING: 202 seat-first (199 past their start, all short, 159 with 0 seats, 43 partly filled) and 138 MTTs (137 inside the 72 h ramp window, 3 behind the ramp curve).
  - About 57–61 of the empty seat-first boards are "held empty", which returns after 3 round trips.
  - Fleet: 1,000 horses. 2,942 live seats on non-closed tables. 537 registrations inside the load horizon.
  - Cash room: 114 live cash tables with 90 seated, so the reserve is 138 (the logs say 136–137).
  - Only two club/union scopes cover all 340 rows: Midway union (3 clubs, 1,508 member rows) and Deep Stack Society (418 member rows).

## 2. Why each top-up is slow

Every top-up runs about 15–17 database calls strictly one after another. About 11 of them return the same answer for every call in the pass. Line numbers are in `server/src/services/TournamentRecurringService.ts` at 404948b354.

**Seat-first top-up past its start with nothing claimable (the ~146-per-pass case):**
| Step | Lines | Round trips |
|---|---|---|
| Tournament row | 5177 | 1 |
| `fn_tournament_primary_table` | 5247 | 1 |
| Seats on the primary table | 5268 | 1 (held-empty boards stop here: 3 total) |
| `unseatedRegistrantHorses` | 5342 → 4853 | 1–3 |
| `pickFreeHorses` (5348): `horseLoadMap` | 4694 → 4453 (3 pages of 1,000 over 2,942 seats) + 4534 (1 page) | 4 |
| `pickFreeHorses`: whole fleet | 4737 (a full page plus an empty page) | 2 |
| `pickFreeHorses`: `clubMemberIdsForTournament` | 4773 → 4635 + 4649 (Midway only) + 4671 | 2 for DSS, 4 for Midway |
| `pickFreeHorses`: `cashRoomReserve` | 4818 → 4333 + 4356 | 2 |

**MTT top-up (ramp or past start):** about 17–20 round trips, plus one `fn_register_horse_for_tournament` per horse (5950), one after another. The path is 5177, 5283, 5583 (4), 5611, 5672 (2), 5711, club membership (2–4), 5818, 5832, 5871 for freerolls only, 5950 ×k, 5545 and 5554. The logs show about 3.5 s per `Pre-start ramp: +1` line (19 ramps between 05:07:38 and 05:08:46).

**Where the 2.6 s goes:** round trips, not database work.

- Database time per call is small. From pg_stat_statements since the 2026-09-10 02:34 reset:

  | Query                  | Calls  | Mean    |
  | ---------------------- | ------ | ------- |
  | Seat-load page         | 97,491 | 28.7 ms |
  | Registration-load page | 34,906 | 38.9 ms |
  | Fleet page             | 33,927 | 3.5 ms  |
  | Club members page      | 34,477 | 1.8 ms  |
  | Primary-table RPC      | 75,973 | 0.78 ms |
  | Top-up tournament row  | 42,580 | 0.05 ms |

- A simple round trip from the engine host to Supabase us-west-2 costs about 110 ms. The log gap from `holding ... 1 of 3 claimable` to the `seat-first-precheck` line is 2 calls in 217–381 ms.

## 3. Does a slow pass delay starts? Yes for MTTs; spins and heads-up are not affected

- **Where the start decision runs:** the REGISTERING→RUNNING branch (GameServer.ts:5127–5209) is checked for a row only when the walk reaches that row.
- **05:00 MTTs today:** "Midnight Free Buy (NLH)" and the two "$100 Freeroll • 12:00 AM" logged `Starting tournament` at 05:07:27.7. Their first hands were dealt 456–498 s after start_time. "Pre-Dawn Mystery Bounty (PLO5)" (05:05:53) started at 05:07:35.9 and dealt 111 s late.
- **Last 14 hours** (hand_history.started_at minus start_time): every MTT scheduled on the hour dealt 438–1,041 s late, excluding hours affected by restarts. MTTs scheduled at other times dealt 162–279 s late.
- **Humans:** no MTT in the last 48 h had a non-horse entrant, so no human has hit this yet. A human who registered for an MTT would wait exactly as long.
- **Spins and heads-up:** they start in the 1-second fast lane (`discoverSeatFirstStarts`, 6836). Boards with a human seated are filled every 12 s by `fillPartialSeatFirstGame` (6927). Neither waits for the walk.

## 4. The fix

The full diff is at `/tmp/claude-inv-registering-walk/fix.diff` on the Mac (679 lines). `git apply --check` against the worktree passes, and the worktree is still clean.

**`TournamentRecurringService.ts` changes:**

1. **Insert after line 1310:** a new exported `HorseTopUpPass` class and a `viaTopUpPass()` helper.
   - `once(key, read, keep)` reads each answer at most once per pass, and concurrent callers share one in-flight read.
   - It never keeps a value that `keep` rejects, or a read that failed.
   - `forget()` clears everything it holds.
2. **`cashRoomReserve` (4331):**
   - Before: `private async cashRoomReserve(): Promise<number>`, returning 0 on every failure.
   - After: `cashRoomReserve(pass?)` returns `(await viaTopUpPass(pass, 'cash-room-reserve', () => this.readCashRoomReserve(), v => v !== null)) ?? 0`.
   - The old body becomes `readCashRoomReserve(): Promise<number | null>`. At 4340 it now returns null when the read fails or comes back empty, and 0 only when there are no cash tables. At 4371 and 4377 it returns null instead of 0.
   - The effect: a failed read still counts as a 0 reserve for that one call, as before, but the pass never keeps that 0.
3. **`clubMemberIdsForTournament` (4632):** it takes `(tournamentId, pass?)`. After the `if (!hostClubId) return null;` line it calls the new `clubMemberIdsForScope(hostClubId, unionId)` through the pass under the key `` `club-members:${hostClubId}:${unionId ?? ''}` ``. All the existing lines move into the new method unchanged.
4. **`pickFreeHorses` (4685):** a 4th parameter `pass?` is added.
   - 4694: `const load = await viaTopUpPass(pass, 'horse-load', () => this.horseLoadMap(), (map) => map !== null);`
   - 4737: the same `fetchAllRows` call wrapped as `viaTopUpPass(pass, 'horse-fleet', () => fetchAllRows(...), (page) => page.complete)`.
   - 4773: `clubMemberIdsForTournament(tournamentId, pass)`.
   - 4818: `cashRoomReserve(pass)`.
5. **`topUpWithHorses` (5142):**
   - `opts` becomes `{ allLanes?; pass?: HorseTopUpPass }`, with `const pass = opts.pass;`.
   - 5348: `this.pickFreeHorses(poolWanted, false, tournamentId, pass)`.
   - 5504: `this.registerHorses(tournamentId, shortfall, opts.allLanes === true, pass)`.
   - New `if (added > 0) pass?.forget();` after that call. The catch block also calls `pass?.forget()`.
6. **`registerHorses` (5568):** a 4th parameter `pass?` is added. 5583 reads the load through the pass, 5672 reads the available pool through the pass (key `'horse-pool-available'`, kept only if complete), and 5761 calls `clubMemberIdsForTournament(tournamentId, pass)`.

**`GameServer.ts` changes:**

1. **Import (42–48):** add `HorseTopUpPass` and `MTT_PRESTART_TICK_MS`.
2. **After line 190:** new constants `PAST_START_TOP_UP_CONCURRENCY = 8` and `PAST_START_TOP_UP_MAX_INTERVAL_MS = 10 min`.
3. **After line 1444:** new field `pastStartTopUpClock: Map<string, {at, misses}>`.
4. **After line 4998:** create `const topUpPass = new HorseTopUpPass(); const pastStartTopUps = new Set<Promise<void>>();`.
5. **Ramp call (5086–5089):** add `{ pass: topUpPass }`. The ramp still runs inline and keeps its 45 s throttle.
6. **Past-start branch (5118–5123):**
   - Before: `const added = await this.tournamentRecurring.topUpWithHorses(tournament.id, target);` followed by the "Filled" log.
   - After, per event:
     - The interval is `Math.min(MTT_PRESTART_TICK_MS * 2 ** Math.min(misses, 4), PAST_START_TOP_UP_MAX_INTERVAL_MS)`. That is 45 s, then 90, 180, 360, and at most 600 s after repeated empty top-ups. It resets to 45 s as soon as a top-up adds anyone.
     - If 8 top-ups are already running, it waits for one to finish, then re-checks `directAdmissionIsCurrent` and `isMaintenanceFrozen`.
     - It then launches `topUpWithHorses(id, target, { pass: topUpPass })` as a tracked promise that updates the clock, logs "Filled", and reports errors under `GameServer.past_start_top_up_failed`.
     - The existing `continue` is unchanged.
7. **After the walk loop (after 5210):** `await Promise.allSettled([...pastStartTopUps]);`
8. **Prune block (5325):** also prunes `pastStartTopUpClock`.

**Why the backoff matters:** `fn_seat_horse_in_seat_first_game` averages 458.9 ms (max 9.3 s) over 64,955 calls, and it takes the global lock that hand settlement waits on. Without the backoff, a pass that lasts seconds would re-ask boards that keep refusing about 10 times more often than today. This is the same backoff `fillPartialSeatFirstGame` already uses.

**Rules preserved:**

- **Club scoping:** same filter. The membership is held per (club, union), which are exactly the inputs the read uses.
- **Cash-room hold-back:** same calculation for each call. The pass never keeps a fail-open 0, and it forgets everything after any seat or registration.
- **Four-table limit:** the same `horseLoadMap` is used, and the database trigger still refuses each RPC with 23514 when over the limit.
- **Maintenance freeze:** the gate at the top of the loop is unchanged, as are topUp's own gate and the per-RPC gates. There is one extra re-check after waiting for a slot.
- **Seat-first behaviour:** held-empty boards, own registrants first, the precheck ledger and the fast lane are all untouched.
- **The one behaviour difference:** top-ups running at the same time may claim from a snapshot that is at most one pass old. That is the same read-then-claim gap the fast lane's parallel jobs already have.

**About "exit early when no horse is claimable":** with the pass in place, `pickFreeHorses` decides "nothing claimable" in memory, with zero round trips. A board still cannot be skipped before its own reads, because seat-first top-ups also seat the board's own unseated registrant horses (5342), and those bypass the pool and the hold-back. Right now 0 of 202 boards have any, so one batched roster read per pass could skip whole boards. That is a possible follow-up and is not in this patch.

**Verification** (done in a copy at `/tmp/claude-inv-registering-walk/sb`):

- `tsc --noEmit` exits 0, and `prettier --check` is clean.
- All 23 server test files that pin this code pass (361 tests), and so do the 8 root test files that pin it (122 tests).
- The full server suite passes: 668 files (1 skipped), 9,176 tests.
- 37 of the 38 root test files that read `GameServer.ts` or `TournamentRecurringService.ts` pass (509 tests). `finalSweep20260908.test.tsx` failed only because the copy could not resolve `react-router-dom` for the frontend source.

## 5. Tests that pin this code

- **Need a regex change:** these four fail without it, and the change is in the diff. Each adds `, pass` and, for the first of each pair, `\s*`:
  - `server/src/services/HorsesStayInTheirClub.test.ts:150-152` and `:168`
  - `server/src/services/aClubBoardFillsFromItsOwnMembers.test.ts:92-94` and `:103`
- **New test in the diff:** `server/src/services/theWalkReadsTheFleetOnce.test.ts` (9 tests). It covers the pass's behaviour (shared reads, unknown answers never kept, `forget()`) and pins the new wiring in the walk.
- **Still pass unchanged:**
  - The freeze law tests in `server/src/maintenance/theFreezeIsTotal.law.test.ts`.
  - Server tests (all under `server/src`): `engineStartBudget` (no new methods between `discoverCashTables` and `discoverTournaments`), `tournamentResumeBudget`, `SpinStartsInOneSecondAndPlaysInFull`, `bootOrderDiscoveryFirst`, `theSweepOnTheCoreIsANumber`, `spinLaunchParking`, `DirectEngineRecovery.guard`, `theLongestWaitIsAdoptedFirst`, and in `services/`: `pickFreeHorsesLimits`, `seatFirstFillOrder`, `seatFirstSeatPrecheck`, `seatFirstCountSync`, `HorseConcurrency`, `PagedReadsAreDeterministic.law`, `PagedReadsCannotLieAboutBeingComplete`, `FourTableLimit`, `MttPrestartRamp`, `heldEmptyRotationAndSoleOpen`, `oneCandidatePerSeatIsABet`, `supabase/pagination`.
  - Root tests: `tests/config/spinSeatFirstIntegrity` and, in `tests/unit/`, `horsesFillAllSeats`, `tournamentsNeverCancel`, `todaysIncidentsStayFixed`, `seatFirstGames`, `humanIsNeverLeftWaiting`, `tournamentRestartSurvival`, `tournamentRakeAndBreaks`.

## 6. What to expect, and what is left (these are estimates; nothing was deployed)

- **Per top-up that seats nobody:** 3–7 round trips (about 0.35–0.8 s) instead of about 16 (2.6 s).
- **Walk:** about 13–18 s on a pass where all ~200 boards are due (the first pass after boot or thaw). About 2–5 s once boards have backed off, plus about 1.3 s for each ramp, which still runs inline.
- **MTT starts:** reached within seconds of the pass starting. Events on the hour should start within about one pass after :00, instead of 7–17 minutes late.
- **Pass:** about 55–70 s, down from 472–605 s. The remaining ~40 s is the decided-but-RUNNING sweep at `GameServer.ts:5703-5734`. It runs one count query per RUNNING tournament older than 10 minutes, one after another: 368 today, at about 110 ms each. That is why passes during the freeze still take 50–58 s.
- **To get the pass itself to single-digit seconds:** that sweep's counts need to be batched. A batched read must page through the rows and skip a tournament whose count could not be read, rather than treat it as 0. It is outside this walk fix and not in the diff.

Files are in /tmp/claude-inv-registering-walk (on the Mac):

- fix.diff
- sb/ (the copy with the patch applied)
- baseline.log
- full-final.log
- tsc.log

---

## key

codex-authority

## report

**Recommendation: port later, and in a smaller form. Don't port 1e98a98109, or the versions it was rebased into, as written.** The host-side lease helper is sound. The workflow half would put a new loop defect into main's deploy train, and it deletes the integration point main already reserved for this lease.

## 0. Branch state

- 1e98a98109 is no longer the branch head. The reflog shows Codex rebased or amended it more than 10 times. The head is now **a5dd161e77**, amended at 05:26:36 UTC today (+1857/−97 lines). The Python helper, `engine-up.sh`, the installer and the verifier are byte-identical to 1e98a98109 (same patch-ids). The workflow, CLAUDE.md and the tests have changed since.
- **The Codex threads were not stopped as of 05:27 UTC:**
  - the authority branch was amended at 05:26:36;
  - `agent/codex-live-realtime/stage-b-clean-v3` got a commit (f51ed66095) at 05:19:17 and a merge (9253f860de) at 05:22:38;
  - `fix/hetzner-club-arena-publish-authority` got 72bfeebdee at 05:27:16.
  - Nothing newer had appeared by 05:34 UTC.

## 1. What it solves

- It adds a TTL lease: a JSON state file whose read-modify-write is guarded by flock, at `/var/lib/club-arena/engine-production-authority.json`. Commands are claim, renew, assert-owner, release and status.
- The workflow claims the lease before tests and renews it after tests.
- The cutover step asserts the lease under `engine-up.lock` (a5dd161e77:1173-1176).
- `engine-up.sh` requires the exact lease only for a pending candidate, i.e. when `ENGINE_RELEASE_TOKEN` is set (a5dd161e77 `engine-up.sh`:142-159).
- It is not a general lock around docker start/stop. `engine-up.lock` still does that job.
- The incident behind it: the Stage-B coordinator cancelled runs 34512893031 and 34515705774 to hold the 18:55 break (main changelog `2026-09-10-every-deploy-reaches-the-break.md`:20-21). The ledger shows them as rows 374 and 375, shipped=false, at 18:32:49 and 18:41:19 UTC.

## 2. Does the problem still exist?

- **Yes, but it costs a break, not production safety.**
- Main has no way for an actor outside GitHub to reserve a break:
  - The Verdict's `lease_held_elsewhere` branch (main:1580) can never fire, because the gate only emits `staged_deferred` and `no_certificate` (main:866, 907).
  - The changelog says the lease is "being built separately… not yet merged" (lines 76-77, 99).
  - On the host, the helper is not installed and there is no lease state. I checked this with read-only `ls`/`stat`: `engine-control` holds 4 files, and `/var/lib/club-arena` is 700 root.
- Overlapping mutations are already prevented. The cutover takes `flock -w 30` and re-reads the certificate under the lock (main:973-977), and the supervisor skips when the lock is held (`engine-supervisor.sh`:212-213). A collision today means one of two things:
  - The GitHub cutover times out and the run goes red. A cutover that ran never hands on, so the train waits for the next engine push.
  - Or Stage-B's `flock -n` aborts.
- The 2026-09-10 workaround no longer works. On main a cancelled run hands the train on immediately (main:1530-1543), so cancelling runs to hold a window now fights the train.
- The Stage-B cutover still has not run. Its migrations are `.sql.pending`, and its runbook (`codex-stage-b-clean-v3`, `docs/runbooks/lease-heartbeat-keyshare-cutover.md`:104-119, 172-192) uses only `engine-up.lock`. The commit's own CLAUDE.md text says that lock "must never substitute for this lease".

## 3. Is the design correct?

**The helper is correct.** I ran a copy in /tmp with the state and lock files redirected:

- a conflicting claim exits 75;
- a claim after expiry takes over;
- a renew or release by anyone but the owner is refused.

It also does atomic fsynced writes, strict validation, and fails closed on corrupt state.

**Split between release and recovery is correct.** The supervisor timer (active on the host, runs every minute), sp-autoheal, rollback and the guarantee step all restore the sealed image without a token, so no lease can block recovery. A run that defers never reaches the seal, rollback or guarantee steps. The release seal stays an independent layer.

**Defects, most serious first:**

1. **A loop with no brake.** A run that finds another actor's lease runs no tests, build or gate wait. Its Verdict then calls `hand_on || exit 1` straight away (a5dd161e77:1866-1872). Nothing limits this: `DEPLOY_RETRY_LIMIT` only counts failures. While a foreign or stale lease is active, the train re-runs back to back. Each lap costs one short run, one root SSH connection and one ledger row. I couldn't measure the lap length without GitHub access; my estimate is minutes. This breaks main's rule of "at most one such run per break" (main:1608).
2. **The lease is held far too long.** It is claimed before tests with a 3600 s TTL (a5dd161e77:552) and renewed to 7200 s (756). It is then held through tests, build, a wait of up to 60 minutes for the break, cutover and rollback. Whenever an engine push is pending, an outside actor can only claim in the gap between runs or after disabling the workflow. It reserves a whole run, not a break.
3. **Stale leases can only expire.** The only commands are status, claim, renew, assert-owner and release (helper:430-456). There is no break-glass command, no audit log, and CLAUDE.md gives no recovery procedure. A runner that vanishes blocks everyone for up to 2 hours. If the SSH call in the Release step fails transiently, the job fails even after a successful ship (a5dd161e77:1699), and the lease stays until its TTL runs out.
4. **The lease is voluntary for everyone outside GitHub.** Nothing forces Stage-B or a direct operator to claim it.
5. **It removes main's reserved integration point.** It deletes the `lease_held_elsewhere` branch, rewrites the pins at `deployAndPublishAreHonest.test.ts`:259 and 452, and adds about 100 lines of SSH key removal and restore that exist only because the claim happens before tests. Main already sets up SSH after tests (main:545 vs 463).
6. **Minor issues:**
   - The `ENGINE_PRODUCTION_AUTHORITY_NOW_EPOCH` test hook works in production (helper:61-71). In /tmp, a future value produced a lease that the real clock reported as active beyond the 2-hour maximum.
   - a5dd161e77:481 says "persistent self-hosted runner", but the job uses `runs-on: ubuntu-latest` (a5dd161e77:149).

## 4. Conflicts with main

- **1e98a98109 against origin/main** (tested at both 61bab809fc and 1a0cdc3eed): `auto-deploy-hetzner.yml` has 3 conflict hunks (the DID NOT DEPLOY reason, its explanatory text, and the ledger REASON). `deployAndPublishAreHonest.test.ts` has 1.
- A textual merge is also wrong in meaning:
  - Main's Verdict and its SHIPPED expression would not know about the authority skips. A deferral would show red as "the cutover did not verify" and would not hand on.
  - The ledger's SHIPPED would no longer match the Verdict's, which breaks main's "SAME shipped expression" test.
  - The ledger step would end up running before Release and SSH cleanup.
- **add7e404d9 and a5dd161e77** merge cleanly with origin/main 1a0cdc3eed (merge-tree exit 0). The problems in section 3 remain.
- **Against another Codex branch in progress**, `fix/hetzner-club-arena-publish-authority` (27 commits): a5dd161e77 conflicts in 6 files, 14 hunks. That branch shrinks the workflow to 544 lines and moves the release into a host-side systemd transaction (`engine-release-transaction.sh`). If it lands, the lease belongs inside that transaction, not in the workflow.

## 5. When to port, and what to do meanwhile

- **Port before any Stage-B or direct-SSH break cutover is scheduled, or once the release-architecture branch is decided, whichever comes first.**
- **Until then:** an actor who needs a break should disable `auto-deploy-hetzner.yml` (main's documented stop, main:1530) and never cancel runs. A cancelled run's hand-on is refused while the workflow is disabled. The actor should keep holding `engine-up.lock` through stop, apply and restart, as the Stage-B runbook already does.

**What the reduced port must change to fit main (1a0cdc3eed):**

1. **Keep:** the helper, adding a break-glass command that records a reason, an append-only audit log, and honouring `NOW_EPOCH` only in test mode. Also keep the `engine-up.sh` candidate check, the installer (+10 lines), verifier Layer 3c, and the helper unit tests (lines 55-532 of the test file).
2. **Drop:** the pre-test claim, the moved "Setup SSH key" step, the SSH key remove/restore steps, the renew step, the 7200 s TTL, and every `production_authority`/`authority_recheck` gate.
3. **Claim inside the `drain` step** (main:800), once the certificate is ready, with a TTL of about 1800 s (cutover, rollback and the end-of-run steps take about 19 minutes). On exit 75, keep polling until the gate deadline. If the lease is still held then, emit `skip=true`, `gate_kind=lease_held_elsewhere` and a `gate_reason`. Main's existing Verdict branch then hands on, and the next run waits for the next :55. Any other exit code fails closed.
4. Keep the cutover's `assert-owner --min-remaining-seconds 600` and pass the owner and lease id to `engine-up.sh`, taking them from `steps.drain.outputs`.
5. Release in an `always()` step placed before "Record deploy truth", with retries. A release error should not fail a run that shipped. Move "Cleanup SSH key" before the ledger step. That fix is worth doing on its own: today the checkout code at main:1432 runs with the root key still on disk until main:1464.
6. Change the DID NOT DEPLOY wording for `lease_held_elsewhere`; today it says "This run is RED" (main:1380). Pass `gate_reason` through `env`. Leave the Verdict, the SHIPPED expressions, the ledger REASON and the test pins at 259 and 452 unchanged.
7. Update the CLAUDE.md procedure: GitHub claims only at the break, add the break-glass command, and state "disable, never cancel". Add claim and release steps to the Stage-B runbook.

I checked the host read-only only (`ls`/`stat`/`systemctl`/`docker ps`), ran `merge-tree` read-only, and removed my /tmp files.

Paths:

- Branch worktree: /Users/smarter.poker/Documents/.agent-trees/club-arena/codex-horse-phase7
- Stage-B worktree: /Users/smarter.poker/Documents/.agent-trees/club-arena/codex-stage-b-clean-v3
- Release-architecture branch: /Users/smarter.poker/Documents/Codex/2026-08-30/https-smarter-poker-hub-club-arena/work/resume-audit
- Main review worktree: /Users/smarter.poker/Documents/.agent-trees/club-arena/claude-review-0911
