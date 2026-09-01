# Phase 7 of 7 - no result without a hand

2026-09-01. Closes the MTT tournament audit.

## What was wrong

Seven tournaments between 2026-08-15 and 2026-08-30 were COMPLETED with a full
set of finishing places, a stamped winner, and in five of them real chips paid
to the podium. Not one hand was ever dealt in any of them.

| event                          | entrants | ranked | seconds start to end | chips paid |
| ------------------------------ | -------: | -----: | -------------------: | ---------: |
| $100 Freeroll 6:00 PM          |      313 |    312 |                   58 |       0.00 |
| $100 Freeroll 12:00 PM         |      326 |    325 |                   89 |       0.00 |
| Friday Six-Card Nightcap       |       24 |     23 |                  216 |     216.00 |
| Sunday Deep Stack Satellite $5 |       24 |     23 |                   84 |     108.00 |
| Turbo Tuesday PLO Deepstack    |       24 |     23 |                   89 |     216.00 |
| All-In or Fold Frenzy          |       16 |     15 |                   91 |      32.00 |
| Afternoon Bounty (NLH)         |       18 |     17 |                  199 |     203.00 |

775.00 chips were disbursed against those podiums. Every recipient happened to
be a horse. That is luck, not a mitigation: under HORSES ARE PLAYERS a horse
paid a prize it did not win is the same defect as a human paid one, and the
field composition that spared us here is not a control.

## Where it came from

Not the elimination sweep. Every player on every one of the seven events still
holds their full starting stack in `tournament_players.chips`, so the sweep's
`chips <= 0` bust list never saw them.

It is `recoverStuckCompletingTournaments`. That rescue exists for a tournament
that died between its finish and its payout: it ranks whoever is left by chip
count and pays the published structure. On an event that never dealt, every
survivor holds exactly `starting_chips`, so the sort is not a ranking - it is
whatever order Postgres returned the rows in. The shape is identical every
time: one arbitrary row stamped `winner`, the entire rest of the field stamped
`eliminated` with a place, positions written 1..N by a single sequential loop
that takes a few seconds. That loop is visible in the data as the 4 to 51
seconds between the first and last `eliminated_at`.

Two guards were already standing there and both missed.

`anyDealtIn` (2026-08-31) asks whether any survivor is `status = 'playing'` and
treats that as evidence a card was dealt. It is a proxy, and the wrong one: a
tournament promotes its whole field to `playing` when it starts, before a card
exists. All seven fields were `playing`.

`fieldIsStillLive` (2026-08-30) asks whether the field is bigger than the number
of paid places, and returns false when `paidPlaces` is 0 by deliberate design,
so as not to swallow an unresolved payout structure. Both $100 Freerolls carried
the unfunded guarantee Phase 6 documented, so their prize pool was 0.00, so
their structure paid 0 places, so the guard abstained on a 313-player field.
Phase 6 and Phase 7 are the same event seen from two ends.

## What changed

`server/src/tournament/recoveryRankEvidence.ts`, two pure predicates, and the
wiring in `tournamentRecovery.ts` ahead of the loop that credits places.

1. **The sort must actually sort.** `chipsCannotRank(alive)`: two or more
   survivors holding an identical stack to the chip is not a result, and the
   rescue pays nobody. Costs no query, is immune to the hand-history prune, and
   a genuine crash-at-finish never trips it - a lone survivor is skipped by
   design and a real finish has a chip leader.
2. **And no hand was dealt at all.** `noHandWasEverDealt(...)`: stated outright
   rather than inferred, for a field whose stacks differ for some reason that is
   not poker. Bounded to events younger than the horse-only retention window,
   because past that an empty `hand_history` means `sp_prune_hand_history` ran,
   not that nothing happened. An unreadable hand list is UNKNOWN and refuses
   too.

Refusing is the safe side and matches the stance the two older guards already
take: the tournament stays COMPLETING, which is where it already was, every step
below is idempotent, the next pass retries, and the alert names the numbers so a
human settles it deliberately.

## What makes the class visible

`fn_detect_results_without_a_hand()`, migration
`20260901122006_no_result_without_a_hand_detector.sql`, applied to production.
A second migration, `20260901122350_..._close_browser_access.sql`, revokes
EXECUTE from PUBLIC, anon and authenticated: `check-definer-authorization`
refuses a SECURITY DEFINER writer a browser role can reach that never asks who
is calling, and it caught this one on the first push attempt. Nobody in a
browser calls a sweep. The two files are kept separate and each is byte-identical
to what production ran, rather than folding the revoke back into the first file
and leaving the repo saying something the database never executed. Flags
any COMPLETED tournament carrying finishing places with no hand in
`hand_history`, one deduped critical `financial_alerts` row per offender. It
moves no money, exactly like `fn_spin_unpaid_check`. Called on its own six-hour
timer from `GameServer`, per the lesson recorded on the overpay charge that a
repair gated on another job's clock runs once at boot and then never.

Run live twice on 2026-09-01: 4 flagged inside the 6-day window, 324.00 chips,
4 alerts raised on the first pass and 0 on the second, 4 alert rows in total.
`parked_completing` 0.

## Evidence

- Server suite 3400/3400 green, `tsc --noEmit` clean.
- 14 new pins in `NoResultWithoutAHand.law.test.ts`, every one a field shape
  taken from the seven events above.
- The detector was probed against production and is idempotent (above). No
  money path was executed.

## Not done, and why

The 775.00 chips already paid are **not** clawed back and the seven events are
not re-ranked. There is no result to re-rank them to - no hand was dealt - so
the only honest options are leaving them settled or reversing them, and which of
those happens is Dan's money decision, not a sweep's. The alerts name each
event, its field size and its amount so the decision can be made on the numbers.

The engine half deploys at the next 7pm restart window under the standing
7am/7pm restart policy. The detector is already live in the database.
