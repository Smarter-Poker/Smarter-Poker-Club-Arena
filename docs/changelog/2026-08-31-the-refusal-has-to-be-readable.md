# The rake refusal has to be readable, not just reported

2026-08-31, follow-up to #2267.

#2267 stopped the engine taking rake on hands that never saw a flop, and
reported the disagreement — `sawFlop` true, board empty — to Sentry as
`HandController.saw_flop_without_board`. Verified in production: 3,817 cash
hands dealt after the deploy, 2,846 of them ending before a flop, zero raked,
and the 17:40 UTC alarm run logged nothing new.

That closed the money leak. It did not close the bug, and it put the only
evidence of the bug somewhere the rest of the investigation cannot reach.
Sentry is not queryable next to `ledger_reconcile_log`, so the alarm's half of
each incident (a hand id, a stake, a pot) and the engine's half (the stage, the
board, what the hand was doing) live in two systems that cannot be joined.

## What this adds

The refusal now also raises a durable `critical` on `financial_alerts` via
`fn_raise_server_financial_alert` — the server's own money-alarm path, already
used for street-integrity violations, already readable by SQL. Context carries
what is needed to reconstruct the hand by hand: table id, hand number, stage,
pot, seat count, board length and contents, second board length, variant,
whether it was a bomb pot, and the last six actions **with the stage each was
taken at**.

That last field is the point. On every violating hand the alarm caught, the
ordinary preflop folds are recorded with `stage: "showdown"`, where the same
table's clean hands record `"preflop"`. The stage is read from
`handController.getState().stage` at the moment the action is handled, so the
controller was parked at showdown while betting was still live. That is the
corruption; the rake was only its most expensive symptom. Carrying the per-
action stage into the alert is what will confirm or kill that reading the next
time it fires.

## Why it may be quiet for a while

The violations arrived in bursts — 08-30 09:00-11:00, 16:00-18:00, 08-31
04:00-05:00, 12:00-13:00 — with hours of silence between. That is the shape of
per-instance state that goes bad and stays bad until the process is recycled,
not of a uniformly random race. The #2267 deploy recycled the engine, so the
current quiet is at least partly a restart and should not be read as the
corruption being gone. This alert is what will say when it comes back.

Fire-and-forget on the settlement hot path; `raiseFinancialAlert` never throws,
never rejects, and re-escalates a throttled critical to Sentry by itself.

## Pins

`HandController.noFlopNoDrop.law.test.ts` gains a fifth: the refusal raises a
critical on the right source with the hand number, a zero board length and the
per-action stages intact. Server suite 3271 passed, 290 files. `tsc --noEmit`
clean.

## Still open

The 12.51 chips already taken from players (32 hands since 2026-08-29, plus a
thin tail before it) are unrepaid, for the reason given in #2267: the rake was
attributed downstream to VIP points, agent and super-agent commissions and the
rakeback basis, so repaying without unwinding double-counts and unwinding
silently moves other people's earned commissions. Dan's call, still.
