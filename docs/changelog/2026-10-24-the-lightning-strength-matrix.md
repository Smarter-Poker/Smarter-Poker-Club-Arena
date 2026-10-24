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
