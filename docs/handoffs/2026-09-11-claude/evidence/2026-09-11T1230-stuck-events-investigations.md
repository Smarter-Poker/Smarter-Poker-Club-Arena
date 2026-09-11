# Workflow evidence: stuck-events investigations (wf_e0f1bbf3-217, exported 2026-09-11 ~12:30 UTC)

---

## investigate:breakfast

The event can be completed with no new prize money, but the existing ruling door can't do it. The proposal is one transaction: put back the 6-place ladder the places were paid against, then complete through the normal completion door (`fn_complete_tournament_terminal`). I rehearsed it and committed it on a local PG17 copy (current production schema plus this event's rows). A root-cause fix is committed on a branch, not pushed.

The payout order is wrong against true bust order. Places 2-6 were paid to players who really finished 8th-13th. The players who really finished 2nd-7th are recorded at 35-40 and got nothing. All 40 entrants are house bots (`profiles.is_horse = true`), so no real player gained or lost money.

**1. Why the ladder went from 6 to 4 places** (engine log `engine-20260908T145519Z…146e19a7.log.gz` on the engine host, `managed_game_contract_versions`)

- Small correction: the event was created 09-05 14:00:29, but it has been COMPLETING since **2026-09-08 14:53:50**, not 09-05.
- 14:01:23 on 09-08: the RUNNING flip failed three times, so the game ran with its row still REGISTERING. Locally, a plain REGISTERING→RUNNING update is refused with `TOURNAMENT_LAUNCH_RECEIPT_REQUIRED`, which is consistent with this failure.
- 14:24:55: late registration closed. The engine fitted 6 places (32.53/23.42/16.86/12.14/8.74/6.31), which is `payoutStructureForField(40)`: 15% of the field. This is contract v3. That engine code was removed in adf1a2c35f.
- 14:35:24–14:36:41: places 6 down to 2 were paid against v3 (11.36, 15.73, 21.85, 30.35, 42.16).
- 14:53:50: the old "played but still REGISTERING" sweep changed the row to COMPLETING. That status change fired the trigger `zz_ca_fund_overlay_on_lock`, whose first block refits the ladder to `fn_ca_payout_structure(40, payout_percent=10)`, which is 4 places. It wrote that over the paid 6-place ladder (contract v4).
  - The trigger that should block ladder changes after the pool is finalized (`zzzz_freeze_finalized_tournament_prize_pool`) is disabled in production.
  - Six other guard triggers on `tournaments` are also disabled.
- 14:53:51: recovery priced 1st place at 77.62, but the escrow held only 58.55, so 58.55 was paid. Migration 20260909060539 later wrote that obligation down to 58.55.
- Since then the engine retries about every 1–2 minutes (172 times between 08:55 and 10:55 today). It always fails with "place obligation outside its derived ladder" because places 5–6 aren't in the 4-place ladder.
- No other non-Spin event paid since 09-01 had its ladder changed after its first payout.

**2. Paid places vs true bust order**

- No `tournament_knockout_candidates` or `hand_atomic_commits` rows exist for this event (both started logging after it finished). I used `hand_history` instead: each player's last hand where their end stack was 0, ordered by hand end time.
  - Both hand end time and history commit time give the same order.
  - For two busts in the same hand, the smaller starting stack finishes lower (the platform's rule).
- Every one of the 39 busts was a showdown hand. At 14:36:55 (hand 8213247) all 480,000 chips were at table 4 among the winner and the six "sweep" players.
- The adversarial review's conclusion is right (positions 35–40 are really places 2–7). Its explanation is wrong: there were no chip-losing seat moves.
- Actual cause: the first bust (14:03) got position 34 because 34 players had entered. Six late registrants joined afterwards, but the position ladder was never widened. The first 33 busts used up positions 34 down to 2. The engine logged "7 players left" at 14:36:44 after handing out place 2, and put the last six busts at 35–40 ("finishing ladder exhausted … standings need renumbering").
- `elimination_sequence` for this event was backfilled on 09-09 from those wrong positions, so it repeats the error.

| True place | Player (hand, bust time)                    | Recorded place | Paid  |
| ---------- | ------------------------------------------- | -------------- | ----- |
| 1          | 5a0cd7e0                                    | 1              | 58.55 |
| 2          | 1c0dee1e (8215053, 14:42:17)                | 40             | 0     |
| 3          | c6dc3bfa (8214451, 14:40:42)                | 39             | 0     |
| 4          | 00000000…0025 (8214314, 14:40:14)           | 38             | 0     |
| 5          | 2d6c5e7a (8213802, 14:38:59)                | 37             | 0     |
| 6          | 165df98e (8213440, starting stack 52,660)   | 35             | 0     |
| 7          | f39893fa (same hand, starting stack 31,607) | 36             | 0     |
| 8          | 57d5af45 (14:36:16)                         | 3              | 30.35 |
| 9          | 1e6efb0b (14:35:44)                         | 4              | 21.85 |
| 10         | face0000…0001 (14:35:25)                    | 2              | 42.16 |
| 11         | e7925474 (14:34:54)                         | 6              | 11.36 |
| 12         | 9313a5e1 (14:34:37)                         | 7              | 0     |
| 13         | 00000000…0006 (14:34:05)                    | 5              | 15.73 |

Places 14–40 are also out of order. The full 40-player true order is written into the ruling's audit record.

**3. The existing ruling door does not apply**
I read `fn_settle_tournament_places_by_ruling` in full (production matches migration 20260909171500) and ran it locally:

- The chronology check refuses this event (`paid_positions_do_not_match_final_results`, 5 groups), so the door is reachable.
- It then stops on the unsettled fee ("fee balance is still 20.00").
- With the rake settled first, it fails on its own COMPLETED update: its own 'ruling' batch row freezes the obligations, so the step that stamps them closed is refused ("obligations … frozen by their atomic place batch").
- Past that, it would still fail at COMMIT: the rule that a completed event must have a terminal receipt went live at 2026-09-09 21:56, after the door's only use at 17:18. The door writes no receipt.
- It would also leave the 4-place ladder in place and the winner's prize at 0.00.
- This means the door can't complete any non-satellite event right now. It needs its own follow-up fix.

**4. Proposed ruling** — `/Users/smarter.poker/Documents/.agent-trees/club-arena/c1f15c30-ruling/ruling_c1f15c30.sql` (md5 e688d1621e65bf09dcf3165c94bbf9d3), one transaction:

- **Setup:** `lock_timeout 5s`, and `request.jwt.claims` set to service_role. Without that, the lifecycle guard refuses the ladder change ("cannot be modified after a player has registered").
- **Locks:** `fn_ca_lock_settlement_lane_global()` first, then the tournament row `FOR UPDATE`. This matches the completion door's lock order, so the engine's retries can't deadlock with it.
- **Preflight** (raises on any mismatch):
  - status COMPLETING, pool 180.00 and finalized;
  - `md5(payout_structure)=56c764db…`, and the contract history is v3 (418b1c97…) then v4;
  - no terminal receipt, batch, rake settlement or final-table deal exists;
  - escrow is prize 0 / bounty 0 / fee 20.00, still open;
  - exactly 6 settled obligations and 6 'structure' payouts (exact place, user, amount; total 180.00), and 6 prize credits totalling 180.00;
  - 40 roster rows, the winner at place 1, 39 eliminated with sequence = 41 − position, places 2–6 held by the paid players;
  - 40 rake records totalling 20.00;
  - exactly one live seat, the winner's (e8469c2c…).
- **The ruling:** `UPDATE tournaments SET payout_structure='[{"place":1,"percentage":32.53},{"place":2,"percentage":23.42},{"place":3,"percentage":16.86},{"place":4,"percentage":12.14},{"place":5,"percentage":8.74},{"place":6,"percentage":6.31}]' WHERE id=… AND status='COMPLETING' AND md5(payout_structure)='56c764dbf0b4a775017b1ac8c09ed946'`, asserting exactly 1 row. This restores v3 byte for byte; its amounts equal the six payouts to the cent.
- **Completion:** `fn_complete_tournament_terminal(c1f15c30…, 5a0cd7e0…, 'places')`.
- **Audit record:** `fn_raise_server_financial_alert('warning','tournament_ruling', …, dedupe 'ruled-finish:c1f15c30…')`. It carries the voided and restored contract hashes, the paid record, the true order and the make-good lists.
- **Postflight** (raises on any mismatch):
  - COMPLETED on the v3 ladder, with contract v5 recorded as a system revision;
  - terminal receipt: mode places, 6 payouts, 180.00, rake 20.00 to the union, 1 seat released, 4 tables closed;
  - payouts, prize credits and obligations unchanged;
  - prize cache correct (the winner goes 0.00 → 58.55);
  - escrow 0/0/0 and closed; union rake wallet up exactly 20.00;
  - no live seats or open tables; the terminal receipt validates.
- **Rehearsal:** committed in about 0.15 s. A second run is refused at preflight.
- **Everything it writes, besides the standing records:**
  - rake 20.00 into the union's rake wallet (1 ledger row);
  - 74 agent-commission accruals totalling 13.95 on the local copy;
  - VIP points and rakeback stats for all 40 bots.
    These happen at every completion; the fee must be settled for any door to complete the event. It pays no prize money.
- **Optional, separate transaction:** `makegood_optional.sql` in the same folder records the v3 make-good as five 'proposed' `ca_manual_adjustments` rows (121.45 total). Proposed rows don't move money. Rehearsed.

**5. Amounts**

- The paid record stands (180.00, nothing clawed back). The fee settlement moves 20.00.
- Recommended basis, the v3 6-place ladder, which is what was paid. Make-good owed:

| Player        | True place | Owed       |
| ------------- | ---------- | ---------- |
| 1c0dee1e      | 2          | 42.16      |
| c6dc3bfa      | 3          | 30.35      |
| 00000000…0025 | 4          | 21.85      |
| 2d6c5e7a      | 5          | 15.73      |
| 165df98e      | 6          | 11.36      |
| **Total**     |            | **121.45** |

- The same 121.45 is kept as overpayment by the true 10th, 8th, 9th, 13th and 11th finishers.
- If the owner instead treats the 4-place ladder (payout_percent 10) as the contract, the make-good is 5a0cd7e0 19.07, 1c0dee1e 44.57, c6dc3bfa 32.22 and 00000000…0025 25.59, also 121.45. But on that ladder no current door can complete the event.
- All recipients are house bots, so the owner may choose to waive the make-good.

**6. Re-sequence**
The paid range is out of true bust order. The complete true order is in the audit record, and the table above shows where it matters for money. Don't apply the re-sequence: moving even one player (1c0dee1e) makes the completion door refuse locally with "needs a late-entry position normalization but already carries settled place evidence". Honouring the paid result means the paid record has to be the standings of record, as with the 6 AM freeroll ruling.

**7. Code fix**

- Branch `fix/late-status-flip-keeps-paid-ladder`, commit 3aaf4ce0c4, worktree `/Users/smarter.poker/Documents/.agent-trees/club-arena/late-status-flip-keeps-paid-ladder`.
- Adds migration `20260911110000_a_late_status_flip_never_rewrites_a_paid_ladder.sql` and a changelog entry.
- The ladder-refit block in `fn_ca_fund_overlay_on_lock` now runs only when the pool is not yet finalized and no payouts or obligations exist. The overlay funding and Spin handling are unchanged.
- It only replaces the function if it matches the live definition (md5 a18b13b7…) or its own (bb132bf0…), so re-applying does nothing.
- Local proof:
  - replaying the 14:53:50 status change reproduces production's v4 ladder byte for byte before the fix, and keeps v3 after it;
  - a normal start still refits the preset ladder;
  - it doesn't interfere with the ruling transaction.

**8. Risks**

- Like every completion, the ruling briefly holds the global settlement and hand-settlement locks. Apply it outside minute :50–:03.
- If only the ladder change were applied, the engine's retry loop would complete the event by itself within about two minutes, but without the audit record or postflight checks. Apply the whole file.
- Still open: the freeze trigger and six other guards are disabled, and the ruling door is broken for all non-satellite events.

Local temp clusters and fixture files have been removed.

---

## investigate:satellites

**Stuck satellites into the Sunday Funday High Roller PKOs: investigation, fix and proposed ruling**

The problem is bigger than six. As of 11:27 UTC, 14 satellites have a winner and are refused at settlement. Two more are open with no players, and the scheduler opens a new one about every 30 minutes. I recommend refusing to create these satellites now (branch below). The stuck ones can be settled now with a ruling that uses only existing database functions. It was rehearsed on a local PG17 copy of the current production rows and nothing has been applied to production.

## Findings

- **Where the refusal is raised.** In the live function `fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)` (body md5 `83bf8b29…`, from migration `20260909165629`). The engine calls it through `fn_settle_satellite_tournament`. It refuses any target whose `is_bounty`, `is_pko`, `is_mystery_bounty` or `is_premium_spin` is not false (NULL is refused too), or that is a Spin. It does this before deciding seat, ticket or cash, so even a cash payout is impossible.
  - The receipt reader `fn_ca_satellite_settlement_receipt` (`381b3e06…`) also rejects any seat or ticket receipt into a bounty target.
  - On each refusal the engine files a critical alert and retries after 5 seconds.
- **Why bounty targets are refused.** A satellite seat is delivered as one prize-plus-fee transfer, so the target's 35.00 bounty slice would be counted as prize. That already happened last week: PKOs `3f19bd70` and `a21c0cb6` had 66 and 155 entrants, all seated by satellites. Their bounty pools of 2310.00 and 5425.00 held no money (`bounty_in` 0), no bounties were paid, and the critical alerts for this are still open. That is a separate incident, not handled here.
- **How these satellites are created.** Nobody configures them. The engine's `TournamentRecurringService.ensureSatelliteHeadsUps` → `pickSatelliteTargets` automatically opens a heads-up satellite into the three most expensive open events per owner. It never reads the bounty flags, and the most expensive weekly event is this PKO.
  - The satellites are created through `fn_create_seat_first_game_atomic` (47.50 + 2.50, 2 seats, 1 seat awarded, no `schedule_id`).
  - The targets come from weekly schedules `76c70c53` (union `fade0000`) and `42d44815` (club `2a1132b9`): progressive bounty, 67.50 + 7.50 with a 35.00 bounty, 3500 guarantee. Both were spawned at 03:01 on 09-11.
  - The club Create Tournament screen also offers bounty events as satellite targets.
- **State of the stuck satellites.** Besides the six you named, eight more are stuck: `165abcf0`, `9db7f5e3`, `d279d771`, `b997c079`, `46d7e8bc`, `78d1b024`, `9ce2e5a7`, `cc8e105a`. `aa7b7b59` and `b9af829c` are still registering with no players.
  - All 28 entrants are horses.
  - Each stuck satellite: winner holds 600 chips, the other player was eliminated in place 2, pool 95.00 finalized. Escrow is 100 in / 95.00 prize / 5.00 fee, and the 5.00 rake is recorded but not settled. There are no payouts, obligations or settlement records yet.
- **Targets.** Both are still registering and start 2026-09-14 03:00 UTC. Each has one entrant and consistent escrow (32.50 prize / 35.00 bounty / 7.50 fee). No satellite winner is registered in either.
- **Side effects of the retries.** There were 167 refusals in 10 minutes and 1,638 open critical alerts. Each retry briefly takes the platform-wide settlement lock, which pauses hand settlement on every table.
- **Constraint from Phase 3.** The pending Phase-three activation script (`scripts/deploy/phase-three-activate-current-terminal-authorities.sql`) pins the settlement function and the receipt reader by md5 and replaces the settlement function wholesale. Its new verifier also refuses bounty targets. Any bounty support written now would block Phase 3.

**Root cause:** the scheduler creates satellites into events the settlement function refuses by design, and nothing at creation time checks this.

## Recommendation (a): refuse to create these satellites now

I recommend this over adding bounty support in this incident:

- It is small, doesn't touch any function Phase 3 pins, and stops new stuck satellites immediately.
- Bounty support means changing the settlement function, the receipt reader, the seat refund-entitlement trigger, the redemption door for tickets issued when a winner is at the four-table cap, and two Phase-3 guards. That is a large money-path change that has to be built on top of Phase 3.
- The ruling below already gives each winner a correctly funded PKO seat.
- One consequence to decide on: the PKOs lose their satellite feeders until bounty support ships. That is a product call for Dan.

**If bounty support is built later, the seat would be funded like this** (all these pieces already exist):

- The split comes from `fn_tournament_entry_split`: 75.00 = 32.50 prize + 35.00 bounty + 7.50 fee. The source satellite's escrow pays out 75.00.
- The transfer ledger row is tagged `entry_split_version` 2, which puts +67.50 into the target's `gross_in` and +35.00 into `bounty_in`.
- The fee's rake record, tagged the same way, adds +7.50 to `satellite_fee_in`.
- The target's `prize_pool` gets +32.50, `bounty_pool` +35.00, `total_rake` +7.50.
- The winner's roster row is inserted with `current_bounty` = 35.00, so `trg_seed_bounty_head` does not add an unfunded head.
- The refund entitlement goes in the `satellite_gross` bucket (32.50 / 35.00 / 7.50), and the settlement record gets a new `target_bounty` column.

**Branch:** `fix/satellites-never-feed-a-bounty-target`, worktree `/Users/smarter.poker/Documents/.agent-trees/club-arena/satellite-bounty-target`, commits `dfc99c2e35` and `a6cd81594d` (not pushed).

- `server/src/services/TournamentRecurringService.ts`: the scheduler now reads the bounty flags and skips any target the settlement function would refuse (`satelliteTargetIsDeliverable`). Tests added; 24/24 pass and the server type-check is clean.
- `supabase/migrations/20260911110907_a_satellite_never_feeds_a_target_its_finish_refuses.sql`: the same rule in the database, as `fn_satellite_target_is_deliverable` plus a trigger on `tournaments`. It refuses creating or re-pointing a satellite at such a target, and refuses turning a live satellite's target into a bounty or Spin event. Existing rows are untouched. It uses `lock_timeout` 3s because `CREATE TRIGGER` briefly locks `tournaments`.
- `src/components/club/CreateTournamentModal.tsx`: the target picker only lists allowed events, and bounty or Spin main events no longer offer "Generate Satellites".
- A schema-manifest entry and a changelog are included.

## Proposed ruling (b)

Files: `scripts/deploy/2026-09-11-settle-satellites-into-bounty-targets.sql` (one transaction) and `.checks.sql` (read-only preflight and postflight).

**Order:** apply the migration, then run the preflight and paste its counts into the ruling, then the ruling, then deploy the engine. It must run before the Phase-3 bundle is activated, and outside minute :50–:03.

**What it does for each decided satellite:**

- It checks every row is in the expected state first, and aborts with nothing written on any difference or count mismatch.
- It pays the full entry in cash, exactly as the settlement function does when a target can't take the seat: winner +75.00 and bubble +20.00 through `fn_credit_and_log`, 5.00 rake settled, escrow closed at zero.
- With `c_deliver_seats` = true, the winner is then entered into the PKO through the normal paid horse door (`fn_register_horse_for_tournament`): 32.50 prize, 35.00 bounty with the head funded, 7.50 fee.
- Empty unstarted satellites are cancelled through the existing cancellation function, the same way the app's own close action does it.
- The matching drift incidents and alerts are resolved.

**Differences from a true satellite seat:**

- The winners' PKO entries are ordinary paid entries, not satellite seats. Unregistering before the start refunds chips instead of a ticket.
- The ruling registers the horse winners itself. A human winner in the same spot would get the 75.00 and register themselves.
- Settling holds the settlement lock for the whole run, which pauses hand settlement for that time. The run took 0.7 seconds locally for 14 satellites.

**Amounts per satellite:** winner +75.00, then −75.00 into the PKO; bubble +20.00; rake 5.00. No re-sequencing is needed: each is heads-up with a single elimination.

| Target                      | Satellite: winner / bubble                                                                                                                                                                                           | Rake goes to             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 8171f9f6 (club `2a1132b9`)  | af821684 FISH/PHLBandit, 5a600bc0 DrDoc/Jen96, fd092efd squeeze777/xtrey, 165abcf0 ACEWHALE/Ingrid, 9db7f5e3 m.rossi83/FLOPGHOST, d279d771 LazyChamp/brad1978, b997c079 LAKenji/MERCHANT, 46d7e8bc float420/xrungood | club `2a1132b9` treasury |
| e9541c66 (union `fade0000`) | 7f9d37d3 MUCKBANDIT/BigRachel, b1bf0a78 RobD/xrat, 372f3fdc slowninja/Rake710, 78d1b024 maniacc/grace1990, 9ce2e5a7 burrito/MamaVinny, cc8e105a TheMachine/lake11                                                    | union `fade0000`         |

- **Totals:** 1,330.00 of pools = 1,050.00 to winners (spent as 455 prize / 490 bounty / 105 fee into the PKOs) + 280.00 to bubbles. Rake 70.00: 40 to the club, 30 to the union.
- **Cancel:** `aa7b7b59` and `b9af829c`, with nothing to refund.
- **Preflight at 11:23 UTC:** settle 14, cancel 2, in play 0, unexpected 0. Every row passed the pool, escrow, untouched and not-registered checks.

**Rehearsal result:** 14 settled, 14 seated, 2 cancelled. Every receipt passed both the database reader and the engine's TypeScript verifier. The engine's retry call and the outcome resolver both accept all 14. The PKOs' escrow and refund plans stay consistent, and the new trigger refuses a fresh PKO satellite. The local cluster and fixture files have been deleted.

## Risks

- **The list keeps changing until the migration and engine deploy land.** Re-run the preflight immediately before applying. Satellites still in play at that time need the same ruling re-run later.
- **Seat purchase can be refused at the four-table cap.** Each winner's game load must be at most 4 in the preflight; a 5 aborts the whole ruling. Re-run later, or set `c_deliver_seats` = false and winners keep the 75.00.
- **Until the engine deploys,** the scheduler's creation attempts are refused by the new trigger, which only produces log and Sentry noise.
- **Rehearsal fidelity.** The local schema was a 2-day-old dump with the current functions, triggers and constraints laid over it. Local game loads were lower than production because other games weren't copied.
- **Possible bug in the settlement function (not fixed; the function is Phase-3-pinned).** It checks the four-table cap while the satellite is still RUNNING, so the winner's own satellite seat counts. Some winners with 3 other games may therefore get a ticket instead of a seat. There are 38 such tickets vs 116 seats since 09-09.

---

## investigate:sweep

**Stuck tournament sweep, production, 2026-09-11 (checked 12:13 UTC)**

As of 12:13 UTC, 59 tournaments cannot finish on their own: 57 one-player-per-table events, a5aa6984 and c1f15c30. None of them cleared after the 10:55 deploy or the 11:56 restart (build 80769f9bd8). The satellites were settled by your ruling at 12:11:03 (15 COMPLETED, aa7b7b59 CANCELLED).

**What I checked**

- **RUNNING with ≤1 playing for >20 min:** none left. The 15 High Roller PKO heads-up satellites were the only ones, settled at 12:11:03.
- **COMPLETING older than 1 hour:** one, c1f15c30 (class C).
- **Pending bounty obligations:** none pending at all (1,523 settled).
- **Pending knockout candidates older than 30 min:** one, a5aa6984's (since 2026-09-09 06:13).
- **RUNNING with no hand for 30+ min and players left:** 57 one-seat-per-table events plus a5aa6984. There are no RUNNING events with zero hands for 20+ min; 8c5291ad is pre-seated and holds the deal until 13:00 by design.
- **Completed since 08:22 (2,321 events: 18 MTT, 15 satellite, 483 SNG, 1,805 Spin):** none paid places out of true bust order. Every eliminated player has a candidate, and payout positions match roster positions.
- **At risk (RUNNING, paid range out of true bust order):** 7aa16fa7, f922df63, 8e16cdb4, bee519fa, 313a274b, e3ef32fd, d7997aef, plus a5aa6984. No place money has been paid in any of them yet (no place obligations or payout rows), so re-sequencing costs nothing extra.

**A. 57 events where every table holds one player (needs code fix, or the wake script now)**

- **Scale:** 402 funded players, all horses; 17,572.20 in prize pools. Last hands range from 2026-09-10 06:40 (5e1f17e4) to 09:51 today (e3ef32fd). Largest: 7d6f3d3b has 43 players on 43 tables, 2dbc9bb6 has 35 on 35.
- **Evidence:** at 10:56 each one logged "Resumed DURING a break", then "BREAK ENDED" at 11:00:03, then only blind escalation (5e1f17e4 is at level 251 of 40). I watched it happen again: re-adopted at 11:56, "BREAK ENDED" at 12:00:03, no balancing, still 57 at 12:13. Live events balanced normally in the same window.
- **Root cause:** a table with one player can't deal, so these events produce no wake at all. Their only sweep is the one requested at adoption. Adoption happens right after an engine restart, which runs inside the :55 maintenance freeze. The balance stage is skipped while frozen, and nothing asks for another sweep after the thaw.
- **How they got to one player per table:** from 01:31 to 01:55 the balancer tried and was refused ("Table break … incomplete – 0/1 moved"), the seat-exit guard fixed at 08:22. After 08:22 every adoption was frozen.
- **Code fix:** branch `fix/a-frozen-sweep-owes-the-balancer-a-pass-after-the-thaw`, based on 80769f9bd8 (the running build). Commit 26e727c8cc; later commits add docs and scripts.
  - `freezeState.onNextMaintenanceThaw()` runs one-shot listeners when the freeze lifts.
  - When the balance or expansion stage is skipped because of the freeze, the manager arms one urgent sweep for the thaw. That is at most one per manager per freeze; single-table formats never arm, and a manager that stopped before the thaw asks for nothing.
  - The sweeps are spread over the 10-second table-resume window.
  - Type check passes. The new test file, the maintenance tests and the tournament tests pass; one tournament test file couldn't load `pg` from the borrowed node_modules, unrelated to this change. The existing freeze law test still pins both guards unchanged.
- **Unblock without a deploy:** `scripts/deploy/2026-09-11-wake-the-one-seat-tables.sql` emits one wake per event through `fn_emit_tournament_manager_wake(id,'bounty_settled')`. It is guarded on still-57, on being outside :50–:03, and on zero paid-range misorders, so it refuses until the 7 re-sequences are done.
  - I rehearsed it on a local PG17 copy of these events' rows. As-is it refuses with "48 standings out of order"; after applying the 94 toggles it passes and emits 57 wakes.

**At-risk re-sequences, needed before the wake script or a deploy of the fix** (`scripts/deploy/2026-09-11-resequence-inputs.sql` has the ordered lists, earliest true bust first; 94 toggles in total). Amounts are projected; nothing is paid yet.

| Event    | Players toggled | Largest projected moves                                                                                                                       |
| -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| bee519fa | 11              | TightMonk, the_jester, owen move 103–105 → 15–17 (0 → 7.87/7.48/7.11); rosanguyen, Zoe86, DEUCENIT drop out of the money (7.87/7.48/7.11 → 0) |
| f922df63 | 12              | shovemoose, owen, xnines, TinyTurnKid move 131–134 → 17–20 (+5.50/5.25/5.03/4.78); beastroud, pokerruss, robkim, SbWolf lose the same amounts |
| 313a274b | 9               | Jake 25 → 13 (+8.65), HeaterHawk 13 → 14 (−8.65), deep_gumbo/pokerdale swap 8 and 9 (±1.13)                                                   |
| 7aa16fa7 | 26              | 19 players shift by −1.30 to +0.92                                                                                                            |
| e3ef32fd | 5               | NatTheGoat 10 → 8 (+4.98), legendd 8 → 9 (−2.70), TheViking 9 → 10 (−2.28)                                                                    |
| 8e16cdb4 | 11              | 6 players shift up to ±1.51                                                                                                                   |
| d7997aef | 20              | 2 players swap 37/38 (±0.04)                                                                                                                  |

**B. a5aa6984 Early Bird Freeroll (needs a ruling)**

- **What happened:**
  - river222 (dca6c345) busted in hand 8569325 at 2026-09-09 06:13:09; that candidate is still pending.
  - A 1.00 rebuy was charged at 06:28:26 and the roster was set to 2500 chips, but river222 was never seated again.
  - MIAJordan (4f7f8abb) sits alone with 320000. The engine's chip check also flags this event: 320000 on the felt against 317500 issued.
- **Proposal** (`scripts/deploy/2026-09-11-a5aa6984-the-stranded-rebuy-busted-first.sql`):
  - Resolve candidate d0ac2895 as eliminated and set river222's chips to 0.
  - Toggle river222 first, then places 10 → 2 in true order; the file has a 99-toggle version for exact standings and a 10-toggle minimal version.
  - Resulting payouts: MIAJordan 27.85, d.kim94 16.00, Rebuy Gia 11.57, MamaRob 9.19, UncleJules 7.69, RexSr 6.64, tim 5.87, andre 5.27, pokerchad 4.81, lake13 4.41 (total 99.30).
  - Record river222 as owed 1.00 for the rebuy that never reached the table.
- **Not rehearsed.** It writes standings, so run it with your re-sequence script on PG17 first. Without the ruling, zeroing the chips would let the engine pay river222 second place (16.00).

**C. c1f15c30 Breakfast Turbo, COMPLETING since 09-08 (needs a ruling)**

- **Blocker:** every retry is refused with "place obligation outside its derived ladder" (121 in the 10:55 hour).
- **What happened:** all six places were already paid, 180.00, against the six-place ladder set at entry close. The late REGISTERING → COMPLETING flip rewrote `payout_structure` to four places. That trigger is fixed on `fix/late-status-flip-keeps-paid-ladder`, not yet applied.
- **Proposal** (`scripts/deploy/2026-09-11-c1f15c30-keeps-the-ladder-it-paid.sql`): restore the six-place ladder, writing as the service role. The derived ladder then equals the six paid obligations exactly, so the engine completes the event and pays nothing new.
- **Rehearsal:** the whole script ran end to end locally (a second run refuses). The terminal completion itself was not rehearsed.

**Engine error tags, 10:55 build (10:56–11:56)**

- **Stuck events:**
  - `atomic_satellite_finish_refused`: 903, spread over the 15 PKO satellites; resolved at 12:11.
  - `recoverStuckCompleting_terminal_refused`: 121, all c1f15c30.
  - `stale_tournament_left_for_resume`: 32 and `stale_sweep_left_live_field_running`: 4, all among the 57.
  - `tournament_chip_drift`: 2 (7aa16fa7 +10000, a5aa6984 +2500).
- **Noise from other agents' pending fixes:**
  - `satellite_atomic_creation_failed`: 28. The old feeder keeps trying to open PKO satellites and the new database trigger refuses them. It stops when `fix/satellites-never-feed-a-bounty-target` deploys.
  - `seat_first_seat_rpc_failed`: 14, all on the 09-08 REGISTERING leftovers below.
- **Transient:** table_lease_lost 83, watchdog_kill 80, zombie_engine_rebuilt 28, deal_error_attempt_1 28, entry_window_close_refused 8 (one each, all finished events).
- **Live, not stuck:** bust_mutation_grace_granted 37 on e95c30bc, which is progressing (307 playing, no pending busts).

**New on the 11:56 build**

- **Symptom:** `horse_decision_worker_failed` "expired after 8000ms before worker dispatch" is climbing: 5,254 in 20 minutes, about 800 a minute by 12:11, across 397 tables. Related `horse_mind_observation_failed` is at about 1,000.
- **Evidence:** the engine is at about 195% CPU on 3 cores. Hands are still dealing, so nothing is stalled, but it needs a look. The previous build logged none. Its server diff from the 10:55 build is small (the new maintenanceThawV3 module and buyIn config), so load is the likelier cause than code.

**Outside the requested categories**

- 79 REGISTERING events from 09-08 12:49–14:51 are horse-only, played, and never went RUNNING; together they hold 2,164.60 in pools. They need a ruling later. Moving any of them straight from REGISTERING to COMPLETING would also trip the paid-ladder rewrite that broke c1f15c30.

**Risks and notes**

- The 7 re-sequences must commit before the wake script or a deploy of my fix, or those events can finish and pay in the old order.
- 57a417c5 had a bust at 09:15:53 that wasn't recorded until the 10:56 restart. I couldn't explain it from the logs.
- I called `fn_ca_tournament_place_amounts` on production once; it is marked VOLATILE. Its body only reads, so it held a brief row lock on c1f15c30 for the length of the statement and wrote nothing.
- Running vitest through a symlink updated the test cache `server/node_modules/.vite/vitest/results.json` in the main checkout. The staged changes already in the main checkout are not mine.

Files are in /Users/smarter.poker/Documents/.agent-trees/club-arena/thaw-balance-sweep:

- `server/src/maintenance/freezeState.ts`
- `server/src/tournament/TournamentManagerEliminations.ts`
- `server/src/tournament/aFrozenSweepOwesTheBalancerAPass.test.ts`
- `docs/changelog/2026-09-11-a-frozen-sweep-owes-the-balancer-a-pass.md`
- `scripts/deploy/2026-09-11-wake-the-one-seat-tables.sql`
- `scripts/deploy/2026-09-11-resequence-inputs.sql`
- `scripts/deploy/2026-09-11-a5aa6984-the-stranded-rebuy-busted-first.sql`
- `scripts/deploy/2026-09-11-c1f15c30-keeps-the-ladder-it-paid.sql`
