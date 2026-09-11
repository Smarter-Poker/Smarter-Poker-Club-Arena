# A bust is ranked by when it happened

2026-09-11. `798866ae` (Early Bird Freeroll (NLH)) froze with three players left
and 100.20 in escrow. The investigation (read-only) found that a bust the knockout
door recorded late was paid a place it did not finish in, on every tournament, by
the engine's own finish. The migration is written and proved; a human applies it,
outside minute :50-:03 UTC.

## The rule

A finishing place is decided by when the bust happened: the commit time of the
accepted hand that took the stack (`hand_atomic_commits.committed_at`). Busts in
different hands are ordered by those commit times, not by hand number. Busts in
one hand rank the smaller hand-start stack first (it busts first and finishes
lower, TDA), then user id, one microsecond apart. Hand-for-hand play, where TDA
treats busts at different tables in one hand-for-hand hand as simultaneous, is
out of scope: those busts are ordered by commit time.

The engine still records busts in hand-number order, because the PKO watermark
settles progressive bounties in that order. The place it hands out while
recording is provisional. The finish re-derives every place.

## What was wrong

1. **The finish paid recording order.** Every tournament finishes through
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
   at 06:20 UTC. At ~09:00 UTC no RUNNING event holds an older non-rebought
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

## What changed

`supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql`
is one transaction. It replaces seven functions with their live bodies plus these
changes (same signatures, owner, settings and grants; md5-pinned before and after):

- **`fn_settle_tournament_places` ranks every place by the bust.** The bust time
  is derived in the statements that use it, from what the door proved: the commit
  of the accepted hand of the player's latest `eliminated` knockout generation,
  plus the same-hand microsecond rank. A row with no such witness falls back to
  `eliminated_at`. A row with neither is refused. Equal times fall back to
  `elimination_sequence`, then id. `elimination_sequence` still alone names the
  last elimination, and so the winner. The same order decides whether anything
  moves, so a ladder already in true order is left alone. Places that carry money
  are never relabelled. The one case that is not a relabel: a COMPLETING event
  whose places are exactly the recording-order ladder, which the old rule already
  paid. It is replayed as paid. COMPLETED events are never renumbered.
- **Both doors stamp the bust hand**, by the same rule. They refuse
  (`knockout_bust_time_unproven`) a bust whose hand cannot be read. They also
  refuse a generation the player provably played on from: a posted rebuy leg
  after it AND a later hand of this event that deals the player in.
- **Both doors resolve a generation a rebuy paid for.** An older `pending`
  generation becomes `rebought` only when a posted wallet-to-pool `rebuy` leg was
  written after it was captured and before the player's next generation. The
  bounty door also requires that generation's head to be closed: no bounty
  obligation names it, or every one that does is settled with its complete
  marker. An obligation still owed keeps the generation refused.
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
  hand order is provisional.

No data is written and no backfill is needed. The settlement derives each bust
from the witnesses the door already proved, so rows recorded before this change
are ranked by their hands exactly like rows recorded after it.

`eliminated_at` is a mixed column from here on. Older rows carry the moment they
were recorded; newer rows carry the bust. Nothing that decides a place relies on
it where a witness exists. The normalizer and the place prepare still rank by
`eliminated_at`. They are not called by the server.

## Measured on production (read-only, 2026-09-11 09:35 UTC)

Settled today under the old rule versus this one, 8 RUNNING events would pay a
different player for at least one place, 92.54 chips in all:

| event                                           | kind    | players | chips moved |
| ----------------------------------------------- | ------- | ------- | ----------- |
| `9536150e` DSS Wednesday $11 NLH Mystery Bounty | mystery | 2       | 30.06       |
| `bee519fa` Afternoon Free Buy (NLH)             |         | 6       | 22.46       |
| `f922df63` Midday Free Buy (NLH)                |         | 8       | 20.56       |
| `313a274b` Afternoon Free Buy (NLH)             |         | 4       | 9.78        |
| `7aa16fa7` $100 Freeroll 12:00 PM               |         | 19      | 6.08        |
| `8e16cdb4` Prime Time Free Buy (NLH)            |         | 6       | 2.51        |
| `a5aa6984` Early Bird Freeroll (NLH)            |         | 2       | 1.05        |
| `d7997aef` $100 Freeroll 6:00 AM                |         | 2       | 0.04        |

For every player whose money moves, the witness hand is the last hand of that
event that deals them in, and no rebuy leg follows it. The two events hand
re-sequenced at 08:38 UTC (`fe72385b`, `5aa7eeba`) are already in true order and
do not move. No RUNNING event carries place evidence. The only COMPLETING event,
`c1f15c30` (09-08, paid), is exactly its recording-order ladder, so it replays as
paid.

## Proof

- `scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh` runs 25
  scenarios against byte-exact captures of the live bodies. The captures cover the
  settlement, both doors and their write halves, the normalizer, the place prepare
  and the alarm. 17 FIXED scenarios must fail there, on a probe assertion. 8 KEPT
  scenarios must pass. The script then applies the migration twice and every
  scenario must pass. The `accounting_postgres` CI job runs it.
- `server/src/tournament/bustOrder.test.ts` covers the engine rule and the
  truncation guard.
- `tests/a-bust-is-ranked-by-when-it-happened.law.test.ts` pins the migration
  text and the engine source. It checks that outside the new ranking block the
  settlement is its live body byte for byte.

## Deploy order

The engine half deploys with or before the migration. The doors now resolve
orphaned generations. An engine still ordering by the earliest pending
generation would record such a player out of hand order, which advances the PKO
watermark past earlier busts.

## Not covered

- Hand-for-hand simultaneity: the TDA's tie rule for hand-for-hand busts at
  different tables.
- The seven played-on rows listed above. They keep the generation they were
  recorded under. All of them are out of the money.
- `a5aa6984` `dca6c345` holds 2500 chips with no seat. Its only generation (hand
  8569325, 09-09 06:13) is pending, and a posted 1.00 rebuy leg follows it with
  no later hand. The door cannot record it while it holds chips. If it is ever
  recorded through the door, it is ranked at that hand: 100th of 100, where the
  old rule would have paid it second. Whether its unseated 1.00 rebuy is refunded
  is a decision for an operator.
