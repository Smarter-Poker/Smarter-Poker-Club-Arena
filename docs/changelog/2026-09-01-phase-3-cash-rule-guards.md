# 2026-09-01 - Phase 3 of 6: cash rule guards, verified against the running build

Phase 3 was handed over as seven suspicions. Six of them are now settled with
production evidence rather than by reading code, and the seventh is a house
rule that is Dan's to set, not mine to change. No code changed in this phase:
two of the items had already been fixed the previous afternoon and the rest
were correct. What follows is the measurement, because "I read it and it looked
right" is not verification.

Everything below is measured on the build the engine is ACTUALLY running,
`bda90d71`, which claimed its leases at 04:11:25 UTC. 21,503 cash hands have
been dealt on it.

## 1. "No flop, no drop" - CLOSED

The handover reported 34 cash hands raked with no board in 24h, 19 of them
ending preflop with no showdown, including a 2/4 heads-up walk raked 0.20.

It is fixed, and the fix is datable to the minute. `316c97efa` - "no flop, no
drop is settled by the board, not by a flag" - merged at **16:09:07 UTC on
2026-08-31**. The last violation in production is at **16:12:04 UTC**. Nothing
since: 21,503 cash hands on the current build, zero.

The mechanism is right, not just the outcome. `priceDeductions` no longer
trusts `sawFlop`; a drop now needs three community cards in the controller's
own state, or `markFlopSeen()` for the run-it-twice path that legitimately
builds its boards elsewhere. When the flag and the board disagree the money is
refused AND the disagreement is reported as
`HandController.saw_flop_without_board`, a critical in `financial_alerts` that
carries the hand id and the last six actions. **That alert has fired zero times
in the 8h+ this build has been running**, which is the second half of the
evidence: the flag itself has stopped going wrong, most likely fixed by
`b9fc364de` - "a stale runout continuation cannot reach the next hand".

## 2. Empty `community_cards` on hands that reached showdown - CLOSED

Same window, same conclusion. Zero in 21,503 hands, and zero hands carrying a
partial board of one or two cards either.

## 3. Sit-out eviction treats horses identically - VERIFIED, WITH AN HONEST GAP

`fn_evict_sitting_out_cash_players` contains no reference to `is_horse` in any
of its three branches. The 2026-08-27 exemption has not come back.

The gap is that the rule has never been exercised against a horse and cannot be
today: of 94 live cash seats, all 94 are horses and **none has a `sit_out_at`
at all**. A horse never sits out because HorseLogic always acts. That is an
unreached condition, not an exclusion - the law is about not writing horses out
of rules, and this rule does not - but it should be said out loud rather than
reported as a passing test.

## 4. Bad Beat Jackpot contributions on cash hands - CORRECT

Of 4,390 flopped cash hands with three or more players dealt in on this build,
3,363 dropped a BBJ fee and 1,027 did not. Every single one of the 1,027 is
PLO6 or Short Deck:

| variant        | flopped 3+ hands | no drop |
| -------------- | ---------------- | ------- |
| plo6 1/2       | 521              | 521     |
| short_deck 1/2 | 508              | 508     |

Both carry `eligible: false` in `BBJ_RULES` with player-facing copy that says
so ("BBJ Not Available For Short Deck"). Nothing else skipped a drop.

## 5. The 60-second waitlist seat hold - BOTH HALVES SHIPPED

The server half is the `SEAT_RESERVED` guard in `atomic_table_buyin`, which
counts `notified` waitlist rows whose `hold_expires_at` (defaulting to
`notified_at + 60 seconds`) is still in the future and refuses the seat to
anyone else. The client half shipped too, and the handover was not sure it had:
`WaitlistBanner.tsx` renders the countdown, `GlobalWaitlistListener.tsx` reads
`hold_expires_at` off the realtime row, `MasterBus` carries
`WAITLIST_SEAT_OFFERED` with `holdExpiresAt`, and `WaitlistService` types it.

## 6. Cash features are exercised on the server path

24 hours of cash play, so this is the horse fleet exercising the engine, not
humans:

| feature          | hands                             |
| ---------------- | --------------------------------- |
| straddle         | 4,899                             |
| run it twice     | 626                               |
| bomb pots        | 36 (36 second boards, consistent) |
| insurance offers | 332                               |

Two are thinner than they look. **Insurance has been offered 596 times in its
life and bought 3 times, most recently on 2026-08-29** - the offer path runs
constantly, the purchase and settlement path has executed three times ever.
**Rabbit hunt has zero offers and zero reveals, ever.** Both are player-initiated
by design and there have been no humans seated, so neither is evidence of a
defect; both are evidence that Phase 5 is where the remaining risk lives.

## 7. Rathole prevention - WORKS, AND HAS ONE DESIGN QUESTION FOR DAN

The rule in `atomic_table_buyin` is correct as written: when a table sets
`no_rathole`, a returning player's buy-in floor is the stack they left with,
capped at the table maximum, and a shorter buy-in is refused with
`NO_RATHOLE`.

Two things worth knowing. It is effectively dormant - `no_rathole` is on for
**1 of 976** cash tables and none of the 26 currently running. And the memory
is **unbounded in time**: it reads the player's most recent exit from that
table with no window at all, so someone who left three weeks ago with 900 must
still return with 900 today. Live poker rathole rules are session-bounded,
usually to the rest of the session or an hour. I have not changed it, because
how long a rathole memory lasts is a house rule and Dan sets those. If he wants
a window, it is one `AND ts.left_at > now() - <window>` in that query.

## Not in this phase

Three tournament-side money alarms are firing right now and belong to whoever
holds tournament liveness, not to this audit:
`Tournament.winner_prize_credit_failed` (36 in 48h, last 11:11 UTC today),
`Tournament.prize_credit_failed` (41), and `fn_detect_results_without_a_hand`
(4, last 12:20 UTC).
