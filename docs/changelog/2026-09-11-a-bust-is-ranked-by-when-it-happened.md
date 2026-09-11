# A bust is ranked by when it happened

2026-09-11. `798866ae` (Early Bird Freeroll (NLH)) froze with three players left
and 100.20 in escrow. The investigation (read-only) found that a bust the knockout
door recorded late was paid a place it did not finish in, on every cash-ladder
tournament, by the engine's own finish. The migration is written and proved; a
human applies it, outside minute :50-:03 UTC. It was amended twice: after an
adversarial review (second pass), and after two verifications of that pass
(third pass, 2026-09-11 ~11:00 UTC).

## The rule

A finishing place is decided by when the bust happened: the commit time of the
accepted hand that took the stack (`hand_atomic_commits.committed_at`). Busts in
different hands are ordered by those commit times, not by hand number. Busts in
one hand rank the smaller hand-start stack first (it busts first and finishes
lower, TDA), then user id, one microsecond apart. Two busts in one hand from
EQUAL starting stacks are ordered by user id, as decided; the TDA would tie them
and split the two places' prize, which this does not model (today that is three
in-the-money pairs in `7aa16fa7`: 14th/15th 4.13/3.90, 21st/22nd 2.98/2.88,
38th/39th 1.86/1.84). Hand-for-hand play, where TDA treats busts at different
tables in one hand-for-hand hand as simultaneous, is out of scope: those busts
are ordered by commit time.

The engine still records busts in hand-number order, because the PKO watermark
settles progressive bounties in that order. The place it hands out while
recording is provisional. The finish re-derives every place.

## What was wrong

1. **The finish paid recording order.** Every cash-ladder tournament (ordinary,
   bounty, PKO, mystery bounty, Spin) finishes through
   `fn_complete_tournament_terminal` -> `fn_complete_tournament_terminal_pre_seat_guard`
   -> `fn_settle_tournament_places`. It renumbered eliminated players by
   `elimination_sequence`, which a trigger stamps when the door records a bust,
   and paid the ladder by those positions. 15 COMPLETED events in 34 hours
   misallocated about 1,437-1,659 chips; 11 of them were bounty events.
2. **Both knockout doors stamped the clock.** The non-bounty write half
   (`fn_eliminate_player_legacy_candidate_20260907`) and the bounty write half
   (`fn_claim_bounty_legacy_candidate_20260907`) set `eliminated_at = now()`,
   the moment they accepted a bust. In `798866ae`, 64 of 83 busts were recorded
   more than a minute late and 26 more than an hour late, the latest 26h42m.
3. **The normalizer moved places without moving their prices** (the prepare and
   ruling path, which the server does not call). The place prepare then refused
   the event for ever with `recorded_prize_disagrees_with_structure`.
4. **An orphaned generation blocked a real bust for ever.** The 2026-09-08/09
   rebuy chain bought players back in without resolving the busted knockout
   generation to `rebought`. Both doors then refused the player's next real bust
   with `unresolved_knockout_generation_chain` (356 refusals of one player in
   39 minutes). Data repairs at 07:04 and 07:23 UTC resolved the four players held
   at 06:20 UTC. At ~11:00 UTC no event in any status holds an older non-rebought
   generation, so the rule below protects the next one.
5. **A player who played on after a rebuy could be recorded at a bust they came
   back from.** When the chain left the generation `pending` and the player kept
   playing, the door still binds the old generation. Seven eliminated rows have
   that shape, none of them in the money: `798866ae` `22af2652`, `6d6b3cc2`,
   `20a40df1`, `45a5e770` (COMPLETED); `7aa16fa7` `71efcdb3` and `a5aa6984`
   `55256246` (RUNNING); and `2e7240ea` `2a763abd` (COMPLETED 09-08). They are
   listed here. This change does not repair them.
6. **The unfinished-finish alarm** (cron 304) measured from `max(eliminated_at)`.
   With a bust-time stamp, a final bust recorded late would raise a critical alarm
   the moment the event became finishable.
7. **The engine** ordered a bust by the EARLIEST pending generation, while the
   door records the LATEST. It also read the generations with no guard against
   PostgREST's silent row cap.

Found by the two verifications of the second pass:

8. **A pruned hand fell back to recording order.** `sp_prune_hand_history`
   (cron 117) deletes a horse-only hand's `hand_atomic_commits` row seven days
   after the hand and spares only hands a PENDING generation names. The second
   pass then fell back to `eliminated_at`, which for every bust recorded before
   this change is the moment it was recorded. The earliest RUNNING witness hand
   becomes prunable about 09-15 17:53 UTC; `7aa16fa7` and `a5aa6984` are the
   events that could run that long.
9. **A refusal that cannot clear by itself stranded its event in silence.**
   `knockout_bust_time_unproven` for a generation the player played on from, and
   `unresolved_knockout_generation_chain`, leave the player `playing` at zero
   chips, so the event can never finish. The engine skips the player after three
   refusals and logs to Sentry; cron 304 only looks at events with one player
   left; nothing reached the money board.
10. **The bounty door resolved a generation whose head was never collected.** A
    generation no bounty obligation names never had its head claimed, and a
    rebuy adds the new head on top of it (`current_bounty + head`), so resolving
    it handed both heads to the player's next knocker.
11. **The header overclaimed.** Satellites and final-table deals do not finish
    through `fn_settle_tournament_places` (below).

## What changed

`supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql`
is one transaction. It replaces seven functions with their live bodies plus these
changes (same signatures, owner, settings and grants; md5-pinned before and after):

- **`fn_settle_tournament_places` ranks every place by the bust.** The bust time
  is derived in the statements that use it, from what the door proved: the commit
  of the accepted hand of the player's latest `eliminated` knockout generation,
  plus the same-hand microsecond rank. When the prune has taken that hand's
  commit row, the hand is timed by its first capture: the earliest `created_at`
  of that hand's generations, one time for the whole hand so the stack rank still
  decides within it (a hand's captures are up to 2.1 s apart and in stack order in
  only 545 of 1,313 multi-bust hands). Across the 33,318 generations that have
  both, capture precedes commit by 4 ms at the median, 236 ms at p99 and 6.9 s at
  most, and never follows it. Generation rows are never deleted. A row with no
  such witness falls back to `eliminated_at`; a row with neither is refused.
  Equal times fall back to `elimination_sequence`, then id.
  `elimination_sequence` still alone names the last elimination, and so the
  winner. The same order decides whether anything moves, so a ladder already in
  true order is left alone. Places that carry money are never relabelled. The one
  case that is not a relabel: a COMPLETING event whose places are exactly the
  recording-order ladder, which the old rule already paid. It is replayed as paid.
  COMPLETED events are never renumbered.
- **Both doors stamp the bust hand**, by the same rule. They refuse
  (`knockout_bust_time_unproven`) a bust whose hand cannot be read. They also
  refuse a generation the player provably played on from: a posted rebuy leg
  after it AND a later hand of this event that deals the player in.
- **A refusal that cannot clear by itself raises one alert.** For that
  played-on refusal and for `unresolved_knockout_generation_chain`, the door
  writes one critical `financial_alerts` row per player
  (`knockout_door.payout_blocked_by_unrecordable_bust`, context names the
  tournament, user, reason and hand) while an open one does not already exist.
  `fn_ca_financial_alert_to_incident` promotes it to an incident, classified
  `settlement_error`. No player has either shape today, so nothing fires on apply.
- **Both doors resolve a generation a rebuy paid for.** An older `pending`
  generation becomes `rebought` only when a posted wallet-to-pool `rebuy` leg was
  written after it was captured and before the player's next generation. The
  bounty door also requires that generation's head to have been collected: its
  own bounty obligation exists, and every obligation naming its hand or its chair
  is settled with its complete marker. A head no obligation names, or one still
  owed, keeps the generation refused (and raises the alert above).
- **The normalizer re-prices what it moves**, by the place prepare's own rule.
  Only place money holds it: a payout from any source but a bounty or a satellite
  seat, or a place or Bubble Protection obligation. A bounty payout no longer
  blocks it.
- **The alarm counts from the recording**: `GREATEST(max(eliminated_at), the
latest resolved_at of a generation the door consumed)`.
- **Engine** (`server/src/tournament/bustOrder.ts`,
  `TournamentManagerEliminations.ts`): the sweep binds each player's latest
  generation. It asks for the exact row count with the generations and treats a
  short read as an unreadable order. The comments say the place it hands out in
  hand order is provisional, what the finish does when a commit is pruned, and
  that satellites and final-table deals are not covered.
- **Rollback.** `docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql`
  restores the seven live bodies byte for byte (pg_get_functiondef, 10:50 UTC).
  Its preflight accepts only what the migration leaves or its own result; its
  postflight proves the pre-migration md5s. It writes no data.

No data is written and no backfill is needed. The settlement derives each bust
from the witnesses the door already proved, so rows recorded before this change
are ranked by their hands exactly like rows recorded after it.

`eliminated_at` is a mixed column from here on. Older rows carry the moment they
were recorded; newer rows carry the bust. Nothing that decides a place relies on
it where a witness exists. The normalizer and the place prepare still rank by
`eliminated_at`. They are not called by the server.

## Not changed: satellites and final-table deals

The terminal guard refuses a satellite and sends a deal event to its own
authority. `fn_settle_satellite_tournament` ->
`fn_settle_satellite_tournament_pre_money_path_gate` and
`fn_settle_tournament_final_table_deal` still number places by
`elimination_sequence DESC` (the recording order) and award seats, the remainder
and a deal's fixed tail by it. Measured read-only at ~11:00 UTC: no RUNNING
satellite would award a seat or remainder differently. `01f1a800` swaps 4th and
7th, but its 600.00 pool buys exactly three tickets at 200.00 (180.00 buy-in plus
20.00 fee), so its remainder is 0.00. None of the 159 satellites completed in the
prior 48 hours would have, and one event settled a final-table deal in seven
days (two payouts, 09-06). They are a follow-up.

## Measured on production (read-only, 2026-09-11 ~11:10 UTC)

Settled today under the old rule versus this one, 8 RUNNING events would pay a
different player for at least one place, 67.46 chips in all. The ladder is each
event's own `fn_ca_tournament_place_amounts`, run on a local copy of its pool,
structure and field; the pool is its current pool or its guarantee, whichever is
larger.

| event                                | kind | players | chips moved | why the orders differ                            |
| ------------------------------------ | ---- | ------- | ----------- | ------------------------------------------------ |
| `bee519fa` Afternoon Free Buy (NLH)  |      | 6       | 22.46       | recorded hours late                              |
| `f922df63` Midday Free Buy (NLH)     |      | 8       | 20.56       | recorded hours late                              |
| `313a274b` Afternoon Free Buy (NLH)  |      | 4       | 9.78        | busts 0.9-4.8 s apart at different tables        |
| `7aa16fa7` $100 Freeroll 12:00 PM    |      | 19      | 6.08        | busts 34 ms-33 s apart at different tables       |
| `e3ef32fd` Thursday Night PKO        | PKO  | 3       | 4.98        | busts 5.2-5.5 s apart at different tables        |
| `8e16cdb4` Prime Time Free Buy (NLH) |      | 6       | 2.51        | busts 19 ms and 246 ms apart at different tables |
| `a5aa6984` Early Bird Freeroll (NLH) |      | 2       | 1.05        | busts 2.3 s apart at different tables            |
| `d7997aef` $100 Freeroll 6:00 AM     |      | 2       | 0.04        | busts 1.4 s apart at different tables            |

Only `bee519fa` and `f922df63` (43.02) are late recordings in the sense of the
headline. The other 24.44 move because the engine records in deal order and the
finish ranks by completion order: the decided rule working as designed. No
witness commit is pruned yet, so the capture fallback changes nothing today.
`9536150e` (30.06 at 09:35) was re-sequenced and COMPLETED at 10:17, paying the
player the new rule would. `fe72385b` and `5aa7eeba` (re-sequenced at 08:38) are
already in true order. No RUNNING event carries place evidence, and no eliminated
row lacks both a witness and a time. The only COMPLETING event, `c1f15c30`
(09-08, paid), is exactly its recording-order ladder, so it replays as paid.

## Proof

- `scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh` runs 27
  scenarios against byte-exact captures of the live bodies. 19 FIXED scenarios
  must fail there, on a probe assertion. 8 KEPT scenarios must pass. The script
  then applies the migration twice and every scenario must pass; then it applies
  the rollback twice, proves every body is its captured live body again, and
  applies the migration once more. The `accounting_postgres` CI job runs it.
- `server/src/tournament/bustOrder.test.ts` covers the engine rule and the
  truncation guard.
- `tests/a-bust-is-ranked-by-when-it-happened.law.test.ts` pins the migration
  text, the rollback and the engine source. It checks that outside the new
  ranking block the settlement is its live body byte for byte, and that every
  rollback body is its captured live body.

## Deploy order

The engine half deploys with or before the migration. The doors now resolve
orphaned generations. An engine still ordering by the earliest pending
generation would record such a player out of hand order, which advances the PKO
watermark past earlier busts.

## Not covered

- Satellites and final-table deals (above).
- Hand-for-hand simultaneity, and the TDA split for equal-stack busts in one
  hand.
- The seven played-on rows listed above. They keep the generation they were
  recorded under. All of them are out of the money.
- The played-on guard reads `hand_history`, which the prune deletes for
  horse-only hands after seven days. On an event older than that, a player whose
  later hands are gone would be stamped at the old generation instead of
  refused.
- `a5aa6984` `dca6c345` holds 2,500 chips with no seat. Its only generation (hand
  8569325, 09-09 06:13) is pending, and a posted 1.00 rebuy leg follows it with
  no later hand. The door cannot record it while it holds chips, so the event
  cannot finish. If an operator zeroes it, the door records it at that hand:
  100th, where the old rule would have paid it second. Whether its unseated
  1.00 rebuy is refunded is a decision for an operator.
- A lead, not investigated: since generations were first captured (09-08 15:03),
  22 rebuy legs were posted within 10 s of the same player's previous rebuy leg
  in the same event with no bust captured between them (22 player-events in 5
  events, 142.00, the last 09-09 05:10). `2e7240ea` `2a763abd` is one. They may
  be double charges by the 09-08/09 rebuy chain.
