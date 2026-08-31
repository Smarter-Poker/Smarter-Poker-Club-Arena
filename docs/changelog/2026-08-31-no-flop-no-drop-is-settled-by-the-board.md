# No flop, no drop is settled by the board, not by a flag

2026-08-31

## What the alarm found

The rake-law alarm shipped in `20260831140000_the_rake_law_gets_an_alarm.sql`
(#2191, corrected by #2210 and #2229) has been filing `no_flop_no_drop`
criticals into `ledger_reconcile_log` since it first ran. Twenty of them, 9.15
chips, across 2026-08-30 16:45 UTC to 2026-08-31 13:34 UTC, on eight different
cash tables at four stakes and four variants. Nobody had said they were fixed,
because they were not.

They are not alarm calibration. Two read in full:

- **Hand 3900820**, NLH 2.00/4.00 heads-up. SB posts 2, BB posts 4, SB folds, 2
  returned. A walk. Pot 4.00, raked 0.20 — the 5% heads-up rate — and the
  winner was credited 3.80. `community_cards` empty, no showdown, four actions
  in the whole hand.
- **Hand 3805102**, NLH 1.00/2.00 seven-handed. One raise to 6, everyone folds,
  4 returned. Pot 5.00, raked 0.50 — 10%. Empty board again.

Every violating hand's rake is exactly the schedule rate applied to that hand's
own pot, so the pricer ran on the live pot and decided a flop had been seen.
`calculateRake` short-circuits on `noFlopNoDrop && !sawFlop`, and `noFlopNoDrop`
is hard-coded `true` on every cash table in `ServerTableEngineDealing`. So
`state.sawFlop` was `true` on a hand with no board.

One other fingerprint, recorded but not yet explained: on these hands every
non-blind action carries `stage: "showdown"` in `hand_history.actions`, where
the same table's clean preflop folds all carry `stage: "preflop"`. The stage is
read from `handController.getState().stage` at the moment the action is
handled, so the controller was already parked at showdown while the hand was
still being played. That is the flag's corruption, and it is still open.

## What this changes

`sawFlop` is a mutable flag written in five places. The board is the evidence.
Every time the two have disagreed, the flag has been the wrong one —
`HandFuzzer` has asserted `sawFlop === board.length >= 3` since the 2026-08-18
rake-leak fix, and the alarm has now caught the same disagreement in production,
on hands the fuzzer's seeded paths never reach.

`HandController.priceDeductions` no longer takes the flag's word for it. A drop
now needs a board:

- three community cards in this controller's own `state.communityCards`, or
- `markFlopSeen()` — the run-it-twice path, which builds its boards in
  `dealAndResolveRIT` outside this state and is the one legitimate way a
  fully-dealt hand has no board here. It now records that fact in
  `boardDealtOutsideState` rather than only flipping `sawFlop`.

Anything else is priced as what the record shows: no flop, no drop, and no BBJ
drop either. The disagreement is reported to Sentry as
`HandController.saw_flop_without_board` with the hand number, stage, pot and
seat count — refusing the money must not also hide the bug that asked for it.

`computeRakeAndBBJ(true)` — the preflop insurance dialog pricing a runout that
has not been dealt yet — is exempt via a `forecast` option. It moves no chips
and must keep quoting what the completed hand will pay.

## Pins

`server/src/engine/HandController.noFlopNoDrop.law.test.ts`. The first test
reproduces hand 3900820's shape exactly: a preflop fold with `sawFlop` forced
true and no card dealt. Against `origin/main` it fails with
`expected 0.2 to be +0` — the same 0.20 the live walk was charged. The other
three pin that a real flop is still raked, that `markFlopSeen()` still
authorises the drop, and that the insurance forecast still quotes it.

`RakeBBJCollection.law.test.ts` passed `flopSeen = true` to controllers sitting
preflop with no board. Every pin in that file that does so means "a hand that
saw the flop", so `mkHC` now deals one. The pins themselves are unchanged and
their expected values are identical.

Server suite: 3262 passed, 288 files. `tsc --noEmit` clean.

## Still open

1. **Why `sawFlop` goes true with no board.** This change refuses the money and
   makes the event loud; it does not explain it. The showdown-stage fingerprint
   above is the thread to pull, and the Sentry breadcrumb is now there to pull
   it with. The alarm stays the check either way — it measures the engine, not
   this fix.
2. **The 9.15 chips already taken.** They left player wallets and were
   attributed downstream — `rake_records`, `rake_attributions`, VIP points,
   agent and super-agent commissions, rakeback basis. Repaying the players
   without unwinding that attribution double-counts, and unwinding it silently
   moves other people's earned commissions. That is a money decision with two
   defensible answers, so it is Dan's, not an agent's. Raised, not taken.
