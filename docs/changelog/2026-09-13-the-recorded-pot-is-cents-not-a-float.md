# The recorded pot is cents, not a float (2026-09-13)

Follow-up to `2026-09-05-run-it-twice-hardening.md`, found while verifying
that fix on the live table eight days on.

## What was verified

- PR #3162 (`aa6b6387a`) is an ancestor of the engine's live release
  (`de406ca9`) and of the published client (`93a24a665`).
- 285 of 285 run-it-twice / three-times hands in the trailing 24 hours
  conserve money per board: the sum of `winners_by_board[].amount` equals
  `pot_size - rake_amount - bbj_amount` on every one, and every hand
  records `pots` and `winners_by_board`.

## What was wrong

`hand_history.pots[].amount` was persisted as the raw float from the live
pot, which is a running sum of float bets. 30 of the 307 pot rows written in
that same day read like `66.46000000000001`, `4.199999999999999` and
`23.599999999999998`, beside awards that were all cents-exact. No chips were
wrong; the record disagreed with the money it described, and any reader
comparing a pot to `pot_size` got a false mismatch.

## The fix

Both capture sites (`ServerTableEngineHandEvents.ts` in the WINNERS handler
and `ServerTableEngineRunout.ts` on the RIT path) round to cents at capture.
`RunItTwice.parity.test.ts` pins it with a hand whose three-way 12.1 main
pot is `36.300000000000004` in float arithmetic; the test fails on the
previous code with `42.39999999999999`.

Existing rows are left as written: they are history, and every reader
already formats to two places.
