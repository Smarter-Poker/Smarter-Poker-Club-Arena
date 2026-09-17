# The three-handed rake discount is nine-max only

Dan, 2026-09-14, verbatim:

> "HEADS UP GAMES SHOULD BE REDUCED MAX RAKE (50% OF MAX RAKE) AND 3 HANDED
> GAMES 75% MAX RAKE (ON 75% RAKE REDUCTION ON 9HANDED GAMES ONLY). ONCE ANY
> 6-8 HANDED GAME REACHES 3+ PLAYERS FULL RAKE + BBJ IS APPLIED."

Two changes to the one rake spec, and nothing else.

**The three-handed rung moved from 67% to 75% of the cap.**

**It is now seat-gated.** A new rule, `shortHandedMinSeats = 9`: the reduction
exists only on a table with at least nine SEATS. Three-handed means something
different on a 9-max than on a 6-max - on nine seats it is a table that has
emptied out, on six it is most of a game - so a 6-, 7- or 8-max table pays the
FULL cap from three players up. The gate is on `tables.max_players`, not on how
many are sitting; how many are sitting is `playersDealt`, which the pricer
already had.

Heads-up is NOT gated: 50% of the cap and the 5% heads-up rate, at every table
size, exactly as before. BBJ is unchanged - `bbjMinPlayersDealt` has been 3
since FIX 145, so "full rake + BBJ at 3+" is what a 6-8 handed table has always
done on the BBJ side. Only the cap was reduced there, and this is what stops it.

## What moved

`rakeSpec.ts` is the one specification: the factor, the new rule, and
`capsByPlayersDealt(fullCap, seats)`. `getPlayerCountCaps` takes the seat count
and `ServerTableEngineBase.tableSeatCount()` supplies it at all three places the
engine builds a rake config. A table row with no usable `max_players` reads as
"no table in hand" and keeps the nine-max ladder, so a failed load can only ever
price a pot as it was priced yesterday, never higher.

The database mirror moves in the same commit, because it has to: without it
`fn_rake_law_violations` would price every three-handed hand at a 6-max table on
the nine-max ladder and report the engine's correct full-cap rake as an
`over_spec` deviation. `ca_rake_rules` gains `short_handed_min_seats`,
`fn_rake_cap_for_dealt` and `fn_effective_rake` gain a `p_seats` argument, and
the alarm passes `t.max_players`, which is already on the row it joins.
`ca_rake_schedule_caps` keeps its `(bb, players_dealt)` shape and keeps
publishing the nine-max ladder; the gate lives in the functions, which choose
the full-cap rung instead of the three-handed one rather than needing a second
key per table size.

## A float bug the new factor exposed

`RakeSpecParity.law.test.ts` went red on one of its 500 cases the moment the
factor became 0.75, and it was right to. At 0.01/0.02 the cap is 0.30:

```
TS    0.30 * 0.75           = 0.22499999999999998  -> round2 -> 0.22
SQL   round(0.30 * 0.75, 2) = round(0.2250, 2)               -> 0.23
```

Postgres `numeric` is an exact decimal and an IEEE double is not, and 0.225 is
precisely the midpoint they disagree about. 0.67 never produced a midpoint, so
the split did not exist until the factor changed. Half a cent on every
short-handed pot at that stake is a real mischarge, and it would have made the
rake alarm report every one of them. `applyCapFactor` does the multiply in
integer cents - the cap is a two-decimal money value, 0.5 and 0.75 are exact
binary fractions, and `Math.round` on a non-negative exact value is Postgres'
round-half-away-from-zero - so the two sides agree by construction.

The checksum moved twice as a result and is pinned on both sides at
`f9cfc362daedd898780b84f20be3e4e4`.

## Verified

991 tests across `RakeSpecParity.law.test.ts` (901, including all 500
parity cases now carrying a seat count), `RakeSchedule.enforcement.test.ts`,
`HeadsUpRake.test.ts` and `RakeConfig.override.test.ts`. The parity law's 500
cases gained a `seats` dimension taken from the case index rather than from its
LCG, so the 2026-09-02 draw sequence is undisturbed and no pot or override was
silently re-rolled. `check-rakeconfig-parity`, `check-rake-schedule-parity` and
`check-rake-bbj-collection-law` all pass. The migration proves itself in its own
transaction: the self-check, the 60 caps rows, six known answers (including
three-handed at 9-max = 3.75 and at 6-max = 5.00) and the checksum.
