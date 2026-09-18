# A rule refusal stops asking every five seconds (2026-09-18)

## What was wrong

`finishTournament` gives a definitively refused finish back to the elimination
scheduler after `TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS`, five seconds.
That is the 2026-09-09 law working as intended: a refusal is not dropped on the
floor, it asks for another pass.

It asks for another pass whatever the refusal was. Measured on the engine at
03:46 UTC:

| Metric                                                                | Value                   |
| --------------------------------------------------------------------- | ----------------------- |
| `poker_tournament_elimination_scheduler_queue_depth`                  | 652                     |
| `poker_tournament_elimination_scheduler_slots_inflight`               | 5 (cap 4, one stalled)  |
| `poker_tournament_elimination_scheduler_oldest_wait_ms`               | 469,125                 |
| `poker_tournaments_decided_unfinished`                                | 547                     |
| `poker_tournament_finish_refusals_total{reason="fee_reconciliation"}` | 1,462 in thirty minutes |

547 decided tournaments were asking, every five seconds, a question the database
had already answered 1,462 times with the same rule refusal. Their entry fees
were charged before the accounting cutover at 2026-09-17 18:24:02 and cannot be
batched, so `fn_accounting_tournament_fee_net_plan` refuses them with
`tournament_fee_sources_require_reconciliation` and will keep refusing them.

Two things followed. The elimination scheduler's four slots were occupied by
tournaments that could not finish, and a healthy tournament's elimination waited
nearly eight minutes to be recorded: players sat at tables waiting for a bust to
be processed. And every one of those passes raised its own critical money alert,
which is where the 3,076 unread critical money alerts came from.

## What changed

`TRANSIENT_FINISH_REFUSALS` names the two reasons a retry can clear on its own:
`deadlock` and `timeout`. The database chose this transaction as a victim, or a
statement ran long; the same call can succeed on the next pass, and
`aFinishThatDeadlocksIsRetried` pins that it is allowed to try.

Every other classified reason is the database saying "not like this".
`finishRefusalRetryDelayMs` gives such a refusal one pass at the unchanged
five-second base, then doubles: 5s, 10s, 20s, up to a fifteen-minute cap. The
cap sits inside the hour between maintenance breaks, so a fee that does get
reconciled is picked up well before the next release window.

`noteFinishRefusal` records the reason and the streak on the manager and answers
whether an operator has already been told this about this tournament.
`alertFinishRefusalOnce` raises the critical alert on the first report of a
reason and counts the repeats in
`poker_tournament_finish_refusal_alerts_suppressed_total{reason}` instead of
sending them. Nothing is hidden: the refusal rate is
`poker_tournament_finish_refusals_total{reason}`, which a rule already reads, and
the suppression itself is a series.

A changed reason is new information and alerts again. A committed settlement
clears the streak.

## What this does not do

It does not finish those 547 tournaments. They remain decided and unfinished,
`poker_tournaments_decided_unfinished` still counts them, and the fee refusal is
still a defect in the accounting cutover that has to be resolved on its own
terms. This change stops that defect from spending the platform's whole
elimination budget and the operator's whole alert channel while it waits.

## Verified

`tsc --noEmit` clean. Seventeen new cases in
`aRuleRefusalStopsAskingEveryFiveSeconds.law.test.ts`, and the existing
`aRefusedFinishAsksForAnotherPass` and `aFinishThatDeadlocksIsRetried` laws pass
unchanged, along with the rest of `src/tournament`.
`check-monitoring-drift.mjs` passes with the new counter's producer in place.
