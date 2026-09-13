# Deep-stack preflop discipline applies in tournaments

2026-09-11 (daily horse audit analysis for 2026-09-10)

## What was wrong

V21 deep-stack discipline (2026-08-27) scales the 4-bet and 5-bet stack-off
bars with depth past 120bb, because bars calibrated at 100bb put the whole
stack in when the stack is 2.5x that. It was gated to `ctx.mode === 'cash'`
with the note "tournaments are untouched (shallow, and the M-zones own short
play)", and `HorseRiverEndgame.test.ts` pinned that a 250bb tournament stack
still jams.

The fleet's events are not shallow at their early levels. A 30,000 starting
stack at 25/50 is 600 big blinds, and the Phase 6 tournament atlas clamps depth
at 100bb (`interpolateTournamentDepth`), so nothing in the tournament path knew
the difference between 100bb and 600bb. The GTO sweep of the twenty biggest
showdown losses of 2026-09-10 found six preflop jams at 500-600bb effective:

| review | hand | line                   | loss   |
| ------ | ---- | ---------------------- | ------ |
| 399558 | AKo  | 4-bet jam over a 3-bet | -600bb |
| 399571 | AKo  | 5-bet jam              | -600bb |
| 399778 | QQ   | cold 5-bet jam         | -599bb |
| 399735 | KK   | 5-bet jam into a 4-bet | -591bb |
| 400053 | AJs  | 4-bet jam              | -500bb |
| 400754 | TT   | 5-bet jam              | -498bb |

Seven days to 2026-09-10: 178 losing tournament NLH preflop stack-offs of
150bb or more (-63,663bb) against 148 wins (+53,489bb). A human at those
tables only has to wait for aces.

## What changed

`server/src/engine/HorsePreflop.ts`: `deepT` no longer requires cash mode.
It is still zero at 120bb and below, so spins, SNGs, every M-zone decision and
every ordinary tournament stack are byte-for-byte unchanged; only stacks deeper
than 120bb see the bar rise, exactly as cash stacks have since V21. Still
inside the default-on `v21Deep` flag (`deepDiscipline`), so the ablation is
one option.

`server/src/engine/HorseRiverEndgame.test.ts`: the "tournaments are untouched"
pin is replaced by the new behaviour - a 0.955 hand calls a 5-bet pot at 250bb
and at 600bb in a tournament; aces at 600bb flat an ordinary 4-bet and jam one
worth half the stack (the same relief window cash stacks have had since V21);
a 100bb tournament stack still jams; and with the layer off the 600bb jam (the
leak) is reproduced.

## What this does not claim

The league deals cash only, so this is validated by scenario tests rather than
a matchup - the same position V16 real ICM and the V20 M-zones shipped from.
The cash side of the same layer is measured nightly as `v21_deep_250bb`
(+2.92 +/- 2.24 on 2026-09-11, unresolved). The postflop mirror - AA and JJ
overpairs stacking off 470-600bb in tournaments on the same day (reviews
399521, 399839, 400340, 400615) - is recorded in the 2026-09-10 audit analysis
and is not touched here.
