# A read is scoped to the game it was learned in (V45)

2026-09-05. From the deep audit, section 4.6: _"Reads are one bucket per
player. A player's PLO6 VPIP (~60% by structure) pollutes their NLH read;
their HU stats pollute their 6-max read."_

`HorseMind.stats` was keyed by user id alone. Every read the fleet owns -
exploit profile, range bands, fold-to-c-bet, fold-to-3-bet, big-bet value
tendency, river fold rate, the V43 tempo reads - priced a player's NLH
decisions with their Omaha frequencies and their 6-max decisions with their
heads-up ones.

## What changes

A scoped overlay, keyed `${scope}|${userId}` where the scope is the two
things that change what a frequency MEANS: the card family (`holdem` or
`omaha`) and the table size (`hu` up to 2 dealt, `short` 3-5, `full` 6+).
`readScopeOf(variant, dealtCount)` names it.

- `HorseLogic.decide` sets the decision scope from the hand on entry and
  clears it in `finally`, so it survives a throw and never leaks to the next
  horse.
- `HorseMind.observe` mirrors every increment it makes on the pooled bucket
  into the scoped one as a delta at the end of the action; the deep reads in
  `observeHandComplete` do the same (settlement passes the hand's scope).
  The recency window (`r*`) stays pooled: "did they just change gears" is
  not a per-scope question, and `exploit()` blends it from the pooled row.
- Every accessor that prices a decision reads through `readStats`: the
  scoped bucket once it holds `SCOPE_MIN_HANDS = 40`, else the pooled
  bucket exactly as before. Below 40 nothing changes; a player the fleet
  has seen in one game reads the same as yesterday.
- Persisted in `horse_mind_stats_scoped` (`upsert_horse_mind_stats_scoped`,
  GREATEST merge, no recency columns) on the same five-minute timer and the
  same boot hydration as the pooled row, with its own fail-safe. A read that
  resets on deploy is a read for nobody.
- Sandboxed like `stats`: a league run's scoped counters cannot leak into
  the fleet or into the next run (the determinism test caught this).

## Tests

`HorseV45ScopedReads.test.ts` (6): the scope names family and size; one
observation feeds both buckets and only the scope in flight, recency stays
pooled; a player who is a station in Omaha and a nit in hold em reads as
each in the matching decision and falls back to pooled under 40 hands;
`decide()` sets and clears the scope, including on a throw; settlement
lands the deep reads in the scoped bucket; export / import round-trips and
never downgrades memory. Migration applied; manifests regenerated; ledger
row for the table.
