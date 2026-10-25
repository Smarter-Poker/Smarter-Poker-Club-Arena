# The Lightning strength matrix (2026-10-24, phase 6 of 9)

Dan: a brain change has to prove it still wins in Lightning before it ships.

`server/src/testing/lightningStrengthMatrix.ts` plays Lightning hands through
the real LightningHandHost, HandController and horse brain - learning the way
the production worker learns (HorseMind live, every completed hand observed,
the winner read fed) - against one archetype who meets a brand-new table of
brand-new horses every hand: a maniac (raises or shoves), a calling station, a
nit (top ~12% of hands) and a simple tight-aggressive regular.

`server/src/lightning/aBrainChangeMustWinInLightning.law.test.ts` seeds the deck
and the brain's jitter, so each matchup is a fixed experiment, and requires the
horses to win against all four in hold'em and PLO5. Measured 2026-10-24, 250
hands each, horses' bb/100:

| archetype | NLH    | PLO5   |
| --------- | ------ | ------ |
| maniac    | +244.1 | +167.7 |
| station   | +3,246 | +1,691 |
| nit       | +41.5  | +54.7  |
| regular   | +138.8 | +75.1  |

Floors sit well under these (maniac +50, station +500, nit +10, regular +20),
so ordinary tuning moves the numbers freely; a change that makes the horses
lose to any archetype fails the build. About 140 seconds on one core.

## October 25 continuation: deterministic inputs and retained archetypes

The prior latest PR had removed both maniac gates after differing outcomes.
That removal is reversed: all eight matchups must pass, including positive
horse results against each maniac. The harness now fixes the mood clock,
physical hand number and equity governor, saves/restores the brain RNG, and
uses the existing offline evidence mode to isolate host-speed budget variance.
The real host, controller, decisions and learning remain in the experiment.
Host and timer cleanup runs even on failure.

The fixed experiment measured NLH maniac316.7/station3377.0/nit58.1/reg151.2
and PLO5 maniac357.2/station1740.0/nit63.7/reg164.8 bb/100, 250 hands per cell.
These finite synthetic opponents do not establish future production profits.
A separate connected worker regression crosses the 300-effective-hand winner
threshold and verifies duplicate observation refusal on owner and mirror lanes.
