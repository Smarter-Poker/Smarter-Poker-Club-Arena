# Cashing Players Are Told, And Places Are True From The First Bust

Dan, 2026-10-21: "fully build, fix and enhance all of these", after the
real-time payout follow-ups were listed. Migration `20261022013120`, applied
to production 01:31 UTC 2026-10-22.

## 1. A Cashing Player Gets A Bell And A Push

**Before.** No tournament prize ever produced a notification: the only record
of a cash was the wallet line.

**Now.** `zzz_notify_tournament_cash` on `tournament_obligations` writes one
`tournament_cash` notification the moment a place, Bubble Protection, satellite
seat or satellite cash obligation becomes fully paid: at the bust for a
real-time place, at the finish for the winner. The existing notification to
`push_outbox` mirror sends the push under its normal preference, quiet-hour and
device gates. Exactly once per obligation, and a failure is a warning in its own
subtransaction, so a notice can never roll back the payment that caused it.
Diamond events are worded in Diamonds. The bell shows the trophy glyph
(`tournament*` types) and the tap opens the tournament.

Examples: "You Finished 12th: You Won 3.50 Chips For 12th Place In Afternoon
Free Buy (NLH). It Is Already In Your Wallet." / "You Won A Seat To Friday Night
Feature From Friday Feature Satellite 5."

**Proof.** Self-aborting probe over real settled obligations of every kind: each
notice written once on a replay, pushed as pending. Live after the apply: 13 of
13 obligations settled in the first minute carried a notice and a push row; none
missing.

## 2. The Place Is True From The First Bust After The Field Is Fixed

**Before.** `fn_ca_pay_tournament_finishers_now` returned before restamping the
standings until somebody was in the money, so between late registration closing
and the bubble every bust kept the engine's provisional place (a 222-entry event
showed places 2 to 200 with 25 players left).

**Now.** Once the pool is finalized the standings and prize cache are restamped
on every bust, in the money or not. Before the pool is finalized the field can
still grow, so nothing moves. Payment gates and doors are unchanged. The engine's
bust message reads the restamped row (merged in #7632, ships in the daily engine
window). Live after the apply: every running finalized event has contiguous true
places from live field plus one.

## 3. Satellite Cash Was Already Paid At The Bust

Measured on the last three satellites, the satellite remainder goes to the bust
that ends the satellite and was credited five seconds after it by the cohort
settlement that bust triggers (01:21:52 to 01:21:57, 01:11:01 to 01:11:06,
00:53:02 to 00:53:07). No second payment path was added; the notice above now
tells that player and every seat winner.

Pinned by `tests/a-cashing-player-is-told-and-every-place-is-true.law.test.ts`.
