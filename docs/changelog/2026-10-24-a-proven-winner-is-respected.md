# A proven winner is respected (2026-10-24, phase 5 of 9)

Dan: track the players beating the horses and switch the fleet to a
counter-strategy against them.

## What a winner is

`server/src/engine/HorseWinnerRead.ts`: every completed hand now carries every
dealt player's net (chips out less chips in; `CompletedHandObservation.results`,
from the physical hand commit and from Lightning settlement). Every worker shard
learns it - owner and mirror alike - deduplicated by hand key. A player is a
proven winner when the decayed mean net per hand (1,000-hand half-life, each
hand clipped to 100bb so one cooler cannot make a winner) clears 2.326 standard
errors of their own swings, over at least 300 effective hands: about 40bb/100
over a horse-sized sample. A break-even player on a heater is misread about one
time in a hundred. Only public information is used - what a person at the table
sees - never who is a horse.

## What changes against one

`HorseMind.exploit` applies `respectWinner`: every horse bluffs a proven winner
less (x0.6) and stops thin value into them (capped at x0.85). Every read of HOW
they play stays. Switching reads off against winners was rejected on purpose:
it would undo the maniac adjustments exactly when the maniac is the one
winning.

## Pins

`server/src/engine/HorseWinnerRead.test.ts`: 20 seeded break-even players never
read as winners over 3,000 hands; a 70bb/100 winner read only after the minimum
sample; a winner who stops winning stops being one; one cooler cannot make a
winner; a hand is learned once; the counter is what the brain's exploit profile
returns; nets are chips out less chips in. The Lightning law pins that a
settled hand carries every player's net, conserving the pot less the drop.
