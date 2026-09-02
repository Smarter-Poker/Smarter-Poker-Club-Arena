# Tournament money: the last four items on the 2026-08-27 handoff

Session 2026-08-28. Picks up the handoff left by the 2026-08-27 Cowork session.
Everything below was applied to production and verified by a second measurement.

## What the handoff left, and what it turned out to be

| Handoff item                                                                | Reality found                                                                                                                                                                                                                                            | Outcome                                                      |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A. 13 Heads-Up events, ~589 chips, "no identifiable winner - needs a human" | Not ambiguous. All 13 identical: two players, one stamped eliminated/place 2 with 0 chips, one never eliminated holding the stack. The engine even paid a prize labelled "1st place" to that survivor - it just never wrote status/position back         | **Paid. 589.00 chips, 13 events, backlog 0**                 |
| B. 1 unexplained conservation finding                                       | Late Night Grind (PLO4) paid place 2 twice and never paid place 3. Overpay = 2nd prize minus 3rd = exactly the 3.50 delta. Root cause already fixed overnight by another agent (free-place walk, PR #1442, plus the collision trigger applied 01:35 UTC) | **Explained. Residual money folded into item B-prime below** |
| C. Midway Union treasury negative                                           | Still negative, -4,346.80. I first reported it recovered - I had read `club_wallets.chip_balance` (1,019,914.65), which is NOT the treasury                                                                                                              | **Still open, watching. See "two pools" below**              |
| D. Silent `payout_structure` parse default                                  | Worse than the handoff's "bounded consequence" - see below                                                                                                                                                                                               | **Fixed**                                                    |
| E. (new) Rake attribution failure                                           | Alerted and never retried                                                                                                                                                                                                                                | **Fixed**                                                    |

## A. The Heads-Up rule

Dan, 2026-08-28: in a two-handed event with exactly one player eliminated and
exactly one never eliminated, the survivor won. That is the definition, not a
judgement call.

No new ranking logic was written. `fn_rank_survivors` (from
`guard_completed_ranks_survivors`) already implements exactly that rule and was
already deployed - its trigger is BEFORE UPDATE on the flip into COMPLETED, so
it protects new events and could never reach the 13 already finished. The
back-pay sweep now calls it first, and the existing `winners = 1` resolution
then just works.

Two defects in the sweep itself were fixed in the same place:

1. **It had already stopped running.** The window was a literal
   `ended_at > '2026-08-01' AND ended_at < '2026-08-28T00:00:00Z'`. Today is
   2026-08-28. It would have reported a clean `paid: 0` forever. Rolling 30 days
   now, with a 30-minute settling grace.
2. **Three copies of the scope predicate** (candidates, unpayable count, alert)
   that had to agree and could drift. One definition now,
   `fn_hu_shortfall_candidates`.

Probed inside a rolled-back transaction first (`ranked 13, paid 13, chips
589.00, owed 589.00 -> 0`), then run live with the same numbers. All six
`fn_backpay_hu_winner_shortfalls` alerts self-resolved.

## B-prime. 206 duplicate finishing places

Dan's call: renumber the records, no clawback from players, hosting club
absorbs the overpay.

**Rule:** within a contested place, the player eliminated LATER finished HIGHER
and keeps it; the others move DOWN into free places. 177 of the 206 groups are
two busts inside the same two-minute endgame, where this is just the poker
result.

**259 rows moved across 136 events; 0 promotions.** Duplicate groups 206 -> 12.

**Two events are excluded and remain for Dan.** Sunday Freeroll Special and
Bounty Builder Turbo each declared TWO winners at place 1, both never
eliminated - two tables ran separate endgames and each crowned a champion. In
Bounty Builder Turbo both hold exactly 10,000 chips. Nothing in the data decides
it and the rule above cannot either. Demoting somebody from first place on a
tiebreak an agent invented is not a record correction.

**Money:** 19 demoted rows had collected more than their corrected place is
worth - 190.22 chips. Charged to the hosting clubs through `fn_debit_treasury`
(audited as `chip_transactions` type `treasury_debit`):

- SHARK CLUB 34.40 - charged
- Club JAQK 29.00 - charged
- Midway Union 126.82 - **blocked**, treasury is -4,346.80 and the guard
  correctly refuses to overdraw. Queued; `fn_charge_place_overpays` retries
  hourly and it clears at the weekly rakeback close.

The rest of the historical overpay (~389) sits inside the two excluded events
and moves only when Dan decides them.

## C. Two pools both called "the treasury"

`clubs.chip_treasury` is the canonical one - it is what `fn_debit_treasury` and
`credit_club_rake_to_treasury` read and write, and what the guarantee-overlay
alert reports. `club_wallets.chip_balance` is something else. For Midway Union
they read **-4,346.80** and **1,019,914.65**.

I checked the wrong one and told Dan the negative treasury had cleared. It had
not. Anything watching club solvency must read `clubs.chip_treasury`.

Whether these two are meant to reconcile at all is not answered here and is
worth a session of its own.

## D. The bubble's own parser

`TournamentManagerEliminations.ts` hand-rolled a parse of `payout_structure`
four lines below a long comment explaining that an unreadable count is UNKNOWN
and must never read as zero:

    try { payouts = JSON.parse(payouts); } catch { payouts = []; }
    if (Array.isArray(payouts)) payoutCount = payouts.length;

The handoff called the consequence bounded. It is not. Line 591 is the **only**
exit from hand-for-hand for a running tournament (the other reset is on engine
restart), and it tests `playingNow <= payoutCount`. With `payoutCount = 0` that
is `playingNow <= 0`, which a live field never satisfies - so a column that goes
bad while the bubble is active leaves the event dealing in lock-step through the
money to the finish. Silently: no log, no alert.

It also **disagreed with the code that pays**. Every other site in that file
resolves through `payoutStructure.ts`, which rejects an array with no place 1 or
percentages summing to zero. This counted the length of whatever parsed, so the
bubble could be defended at a place count the payout path would never honour.

Now: one parser (the strict one), and an unusable structure is reported once per
tournament and leaves bubble state unchanged. Six tests pin the contract in
`tests/unit/payoutStructureBubble.test.ts` - asserting return values, not
caller formatting, because a guard test here has already been broken by prettier
rewrapping a signature.

## E. Attribution that failed was announced, never retried

`fn_settle_tournament_rake` banks the rake, then attributes it per player (VIP
points, agent commission, rakeback stats). Attribution is allowed to fail
without rolling the settlement back - correct, the chips are already banked.
But the entire remedy was a `financial_alert`, and an alert is not a remedy, it
is a request that a human become one.

Live: tournament 72c185e8, 2026-08-27 22:45, attribution lost to `deadlock
detected`. Every player in that event short their VIP points, permanently.

`tournament_rake_settlements` now carries `attributed_at` / `attribution_error`;
the settle path records the outcome; `fn_repair_tournament_rake_attribution`
re-runs the (idempotent) attribution and resolves the alert. `no_club` is
treated as terminal so it cannot pin the head of the queue. Baseline is honest:
31,699 pre-existing settlements are stamped from `settled_at`, then re-NULLed
for every tournament named in an unresolved alert - so the queue started at
exactly the one failure we have evidence for. Ran: queue 1 -> 0.

## Every repair has its own clock

The handoff's trap 3 ("it ran once is not it runs") cost the previous session
hours. Both new sweeps are wired into `GameServer` with their own timers -
`fn_charge_place_overpays` hourly, `fn_repair_tournament_rake_attribution`
every 15 minutes - not piggybacked on another job's window. The stale comment
claiming the HU backlog "can only shrink because of the cutoff date" is
corrected in the same file; that cutoff was the thing that expired.

## Still open for Dan

1. **Two events with two winners each** (above). ~389 chips of overpay ride on
   the answer.
2. **699 unranked survivors across 125 completed MTTs** (counted by
   `guard_completed_ranks_survivors`, untouched by it - the trigger is
   forward-only). Ranking them decides finishing positions for real people and
   unblocks `fn_tournament_payout_reconcile` to pay places it currently refuses.
   Union Grand Championship alone: 30 entrants, 2,500 pool, one credit of 750
   and the other 70% never emitted. Bigger than everything in this document.
3. **`clubs.chip_treasury` vs `club_wallets.chip_balance`** - see C.
4. **Midway Union at -4,346.80**, plus 126.82 queued behind it.

## Concurrent session, same hour: the amnesty came off

While this work was in flight another agent applied
`watchdog_remove_conservation_delta_amnesty` (02:20:06),
`watchdog_conservation_scan_full_window` (02:21:04) and
`watchdog_schedule_tournament_money_jobs` (02:24:29). The first strips the
grandfather term out of `fn_tournament_conservation_delta` - the clause that
forgave pre-2026-08-27 pool inflation - and the third put the sweep on pg_cron,
which fired at 02:24:50.

**Open `fn_tournament_money_conservation` alerts went from 1 to 1,007** in that
pass: 1,006 events, delta -258,156.73. This is not a new leak and not a
regression. Every one of them ended before 2026-08-27 06:35, 923 of them carry a
guarantee, and none has a row in `tournament_guarantee_overlays`. It is the
historical unfunded-guarantee backlog, now measured without the amnesty.

Worst single event, Sunday Midway Major (2026-08-23): guaranteed 10,000,
collected 800, raked 80, paid 9,750. The club funded a 9,030 overlay and nothing
recorded it.

Zeroing these means writing the overlay rows retroactively for money the clubs
already paid. That is a decision about ~258k chips and it belongs to whoever
took the amnesty off, together with Dan - it is deliberately not touched here.

Nothing in this document was computed under the old definition and left stale:
the Heads-Up figures were re-verified after the amnesty was removed and still
read 0 owing. Those events were never grandfathered anyway - their pools were
smaller than what they collected, so the term was already zero.

**No double-scheduling.** The new pg_cron entries cover the conservation and
payout sweeps. `fn_charge_place_overpays` and
`fn_repair_tournament_rake_attribution` run only from their own GameServer
timers, and `fn_backpay_hu_winner_shortfalls` still runs only from its. All
three are idempotent regardless.
