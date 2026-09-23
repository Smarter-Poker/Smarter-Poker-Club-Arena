# 2026-09-17: one_pair_deep_stackoff - the largest untagged NLH line gets a name

Daily horse audit for 2026-09-16 (full tier, claim held by
`clubcommander45@SmarterPokers-Mac-Studio`).

## What the sweep found

The day's twenty biggest showdown losses were read card by card. The NLH
tournament losses that carried NO leak tag were one shape, repeated: an
overpair or top pair committed on the turn or river for 200bb to 800bb.

| review | hand | board (at showdown) | commit                              | net    |
| ------ | ---- | ------------------- | ----------------------------------- | ------ |
| 511597 | QQ   | 6-J-2-7-T           | turn all-in, 567bb                  | -591bb |
| 504324 | QQ   | 5-3-3-9-K           | turn all-in, 810bb                  | -415bb |
| 509437 | KK   | A-3-2-7-4           | three barrels into an all-in, 329bb | -383bb |
| 504738 | AA   | 3-7-K-8-2           | turn all-in, 397bb                  | -352bb |
| 504828 | AA   | 7-8-Q-5-Q           | turn all-in, 235bb                  | -269bb |
| 509668 | JJ   | T-8-3-2-K           | turn all-in, 222bb                  | -230bb |

Eight of the ten largest untagged tournament losses were this. None carried a
tag because `preflop_stackoff` owns preflop, the V24 block only knows a rag
kicker, and the nut-discipline block knows straights, flushes and boats.

Measured over the seven days to 2026-09-16 in `horse_hand_reviews` (NLH, one
pair on an unpaired board, committed on the turn or river):

| format     | commit    | hands | won | net      |
| ---------- | --------- | ----- | --- | -------- |
| tournament | 150-299bb | 63    | 19  | -5,974bb |
| tournament | 300bb+    | 16    | 2   | -5,420bb |
| cash       | 150-299bb | 123   | 41  | -7,748bb |
| cash       | 300bb+    | 12    | 4   | -1,411bb |

A 27% to 33% win rate on a 150bb+ commitment is not variance. Both sides are
counted, so this is the line's EV and not a sample selected for losing.

## What shipped

`one_pair_deep_stackoff` in `server/src/services/HorseHandReview.ts`: hold em,
showdown, hero's best hand is exactly one pair (`nlhNutStatus` category 2),
committed on the turn or river per `commitStreet`, 150bb+ invested
(`DEEP_ONE_PAIR_BB`). Mirrored (`_won`) like every situation tag so the audit
ranks it by EV. Registered in `HorseDataLedger.TAG_CONSUMERS` as a measurement
and in the `EveryLeakTagHasADenominator` law. Pinned by
`HorseLeakDetectorsV50.test.ts` with the real hands as fixtures.

It is a MEASUREMENT. No strategy dial moves. A deep-stack one-pair commitment
cap is the obvious next step and it is strategy: it needs scenario tests and a
league matchup that resolves at |bb100| > 2\*stderr before it can ship.

## What the audit also read (recorded in `horse_daily_audit.agent_analysis`)

- The decided-but-unpaid tournament backlog was 1,095 at 06:07 UTC and 128 by
  10:05 UTC after #4731 (re-land of #4713) and #4753 reached the engine; the
  residual is 32 events older than 24 hours holding 5,252 zero-chip `playing`
  rows, still draining a few finishes per sweep because bust preparation
  spends its 5s budget on reads (`bust_mutation_grace_granted`, 36 times in
  two hours).
- The self-tuner has applied zero dial changes fleet-wide since 2026-09-14
  (#4578, `observational_only_v1`): 622 proposals a night, none applied.
  Deliberate, and it means the "improve on the new logic" half of the standing
  order is currently paused pending a causal activation path.
