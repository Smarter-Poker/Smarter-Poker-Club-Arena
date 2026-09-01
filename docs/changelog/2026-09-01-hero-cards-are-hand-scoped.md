# 2026-09-01 - How two 9 of hearts were on screen at once, and the four doors

Follow-up to `2026-09-01-danimal-hole-cards-settings-pill.md`. That entry fixed
one of the ways a dead hand could reach the felt. Dan came back with the
screenshot and the right question: how was it possible at all, and what makes it
impossible.

Shipped as PR #2444 (first pass) and PR #2491 (this one).

## The hand, from the database

Hand **3992164**, table `0dc28772-165e-4f2a-abec-6299e769bea9`, started
2026-08-31 20:21:57 UTC. Board **Kd 9h Qd**. Four players: lazyAggro (341),
Equinox (1422.90), KnockOUT (502.10), danimal5022 (1000.40, seat 8). KnockOUT
won 10.20. Every figure on the screenshot reconciles with that row, including
the stacks and the pot.

The engine dealt it correctly. What the client was showing in the hero's hand
was a holding from a hand that had already ended.

## The four doors

A holding reaches the hero's seat by exactly four paths. On the day of the
report, two of them checked nothing:

| door | path                                      | checked                      |
| ---- | ----------------------------------------- | ---------------------------- |
| 1    | the realtime push from `table_hole_cards` | nothing                      |
| 2    | the bounded recovery poll                 | hand + board                 |
| 3    | the hold across engine snapshots          | board (added the day before) |
| 4    | the `GAME_START` full-state merge         | nothing                      |

**Door 1 is why the first fix did not hold.** It is the only path that
overwrites cards already on screen, and since the Crazy Pineapple discard fix it
listens on `'*'` rather than `INSERT` - so an UPDATE, or any re-push, carrying
hand N lands after hand N+1 has begun and repaints hand N's holding onto hand
N+1's felt. Door 3's new board check would drop the stale hand, and door 1 would
put it straight back on the next payload. Guarding one door in a four-door room
is not a fix, it is a delay.

**Door 4 is the quiet one.** It is dispatched by `requestResync()` on a
websocket sequence gap - which is precisely the event that loses `HAND_STARTED`

- and it carried `existing?.holeCards` forward without looking at the board that
  arrived in the same payload.

## What could not be determined, and why it matters

Whether the J9h came from the previous hand on that table (3991946) or from the
other table Danimal had open cannot be established. He was two-tabling: hand
3992125 on `16f75832` ran 20:21:40 to 22:47 and overlapped this one.

It cannot be established because `hand_history.hole_cards` is written only for
hands that reach **showdown**. Hand 3992164 folded out, so there is no server
record of what any of those four players held. Neither guard cares - both
mechanisms are closed - but the platform should be able to answer "what was this
player dealt" for any hand, and today it cannot for the majority of them.

## The rule, in one place

`heroHoleCardsAreForThisHand` in `src/lib/tableCardDisplay.ts`. All four doors
ask it. The checks run in order of certainty:

1. **identity** - a row for another table is never ours. The realtime channel is
   filtered by `table_id` server-side, so this can only fire if that filter is
   ever lost. It costs one string compare, and the reporter was multi-tabling.
2. **emptiness**
3. **the hand** - only an OLDER hand is refused. A newer one is the next deal
   arriving before this client processed `HAND_STARTED`, and blinding the hero at
   the moment they are dealt in is the worse bug. An older row can never be
   right, so it can never win.
4. **the board** - last, and it outranks everything. A card cannot be in the
   hero's hand and on the felt at the same time whatever the metadata claims.

A refusal is reported with the row's hand and the live hand side by side, and it
re-arms the recovery read rather than leaving the hero holding nothing.

## The net

The four doors prevent it. Under them, the invariant is re-checked on the
FINISHED state after every commit, independent of which of the ~80
`setTableState` call sites in TablePage produced it. If a fifth door is ever
added, or one of the four is edited badly, the impossible holding is cleared,
reported as `TablePage.hero_card_board_collision` and re-read instead of sat on.

No reviewer can hold eighty call sites in their head. That is what the net is
for.

## Pinned

`tests/unit/heroCardsAreForThisHand.law.test.ts` - the rule against the real
hands from the incident, one source pin per door, and one that fails if the rule
is ever inlined back into TablePage. That last pin is the important one: this
survived two fixes because the same decision was written four times in one
15,000-line file and only two copies were ever updated.

Two existing pins were updated in the same commit, per the house rule. The
`GAME_START` preserve grew one condition in front of it, so
`heroNeverLosesTheirCards` and `timeBankSeatFeedbackAndCards` name the new shape.
The property they defend is unchanged and still pinned: length decides, and a
snapshot carrying no cards preserves rather than wipes.

## Verified in production

`smarter.poker/api/health` served `a01fd132`, which contains World Hub
`bcf287bc90` ("sync build 4e9c9097"), which contains the merge of #2491. The
live bundle at `/hub/club-arena/assets/TablePage-*.js` was fetched and contains
`hole_card_push_refused`, `hero_card_board_collision` and
`hole_card_channel_failed` - the three new telemetry tags. Not merged: running.

## Not done, deliberately

- **The engine does not record what it dealt.** See above. There is an
  `EngineRecordsWhatItDealt` test in flight from another agent in that exact
  seam; this belongs with that work rather than bolted on from the client side.
- **Hole cards are delivered by writing to Postgres and waiting for a realtime
  echo.** Roughly 110k WAL writes per stats window, which is what tempted the
  publication trim that blinded every player for four hours on 2026-08-31. A
  private frame on the socket the player already holds would remove the cost and
  give a real mid-hand reconnect replay. Architectural, and Dan's call.
- **`insert_hole_cards` takes `p_hand_number integer` against a `bigint`
  column.** Recorded here because an earlier note of mine overstated it: the
  ceiling is int4's 2.1 billion against a sequence at ~4 million growing ~221k a
  day, which is about twenty-six years away. `hand_history.hand_number` is
  `integer` too. It is a real inconsistency and not a live risk, and closing it
  costs a schema-cache reload that the DDL policy asks us to spend carefully.
