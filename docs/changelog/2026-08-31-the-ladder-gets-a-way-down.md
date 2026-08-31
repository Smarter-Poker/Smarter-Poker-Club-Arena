# 2026-08-31 — The ladder gets a way down

Phase 5 of the bankroll re-land, recovered from `ef1f656003` (#2128).

## Why it was impossible, not merely missing

`stakeBandAllows` is an EXACT MATCH: a horse banded `mid` may sit `mid` tables
and nothing else. So a horse whose roll can no longer carry its own band does
not move down — it stops playing. Measured before any reset:

| band  | horses | state                                    |
| ----- | ------ | ---------------------------------------- |
| micro | 127    | NO OPEN TABLE (every micro table closed) |
| low   | 336    | all can sit                              |
| mid   | 73     | nits cannot sit at a 10,000 roll         |
| high  | 48     | NO OPEN TABLE (nothing above 2/5 exists) |

175 of 584 — 30% of the fleet — banded into a stake with no table in it, and no
legal way anywhere else.

## The rule: merit is a ceiling, the bankroll picks beneath it

A band is EARNED, on bb/100. That stays exactly as it is as an upper bound:
nothing here ever lets a horse play ABOVE its band. What changes is that the
band stops being the only game it may play.

This does not reopen the escape hatch `stakeBandAllows` deliberately refuses.
That hatch was about seating a nosebleed regular in a micro game FOR
CONVENIENCE while it could perfectly well afford its own stake. A descent only
happens when the horse genuinely cannot afford its band any more, and a broke
high-stakes player grinding back up from a small game is the single most
recognisable story in poker.

## Hysteresis, which is why there are three thresholds

One threshold makes a horse flap: at exactly the sit bar it drops a rung, the
smaller game re-qualifies it, and it climbs straight back — every cycle,
forever. The policy already carried the three figures, used here for the first
time: `canSit` 25 buy-ins to enter, `shouldMoveDown` 17 to leave, `canMoveUp`
35 to climb back. Between 17 and 25 a horse stays put.

## Both self-found bug fixes kept

**The `anyPriced` empty-ladder guard.** With an empty ladder the descent loop
falls through every band and lands on the cheapest, so one cycle where the
table read came back empty would have re-banded the ENTIRE FLEET to `micro` —
and the latch would then persist it until each horse individually clawed back
up. An empty ladder is an unknown, not a verdict.

**The `here > home` merit clamp.** Without it a demoted horse plays above its
earned band.

## The rotator's other half

The seating gate only ever runs BEFORE a horse sits, so the ladder could demote
a horse in principle while it went on playing a game it could not afford in
practice. `left_underrolled` stands it up, at the looser bar so leaving and
re-sitting cannot chase each other.

## A pin that was missing

The reverted work shipped the rotator stand-up with no pin at all: deleting it
outright left every existing descent test green. Four pins added and mutated —
the count without the departure, the stricter bar, standing up on an unreadable
roll, and surplus tables pricing a rung.

That last one caught a weak pin of my own. `for (const t of tables) { if
(surplusTableIds.has(t.id)) continue;` also matches the ladder-exhausted gauge
block, so the assertion stayed green with the bandRef skip deleted. Re-anchored
to the bandRef loop by slice, re-mutated, confirmed biting.

## Two pins moved, not deleted

`HorseStakeBands.test.ts` and `HorseBankrollWiring.test.ts` both pinned
`stakeBandAllows(h.id, table.big_blind)`. Both now pin `resolveStakeBand({` and,
in the bands case, `if (tableBand !== allowedBand) return false;` — the ceiling
that replaces the exact match. What each test guards is unchanged.

## Dead helpers retired

`isBroke` and `bestAffordableGame` — correct, tested, zero callers. Both were
superseded the moment something real needed the job: `resolveStakeBand` picks
against the bands and tables that actually exist and adds the hysteresis
`bestAffordableGame` lacked, and the freeroll router asks the better question
than `isBroke` did, against the cheapest PAID event on the board rather than a
constant. Deleted rather than kept "just in case": dead code with passing tests
reads as working machinery, and this layer has been bitten by that once.

`sessionVerdict` is NOT deleted — it sits between the two in the file and my
first deletion window swallowed it. Caught by `tsc`, restored intact.

## Behavioural proof to look for after deploy

`seated_below_band > 0` in a band-join query — it was 0 of 129 before.

server 3205/285 green, client 10419 passed 2 skipped/742 green, both tsc clean.
