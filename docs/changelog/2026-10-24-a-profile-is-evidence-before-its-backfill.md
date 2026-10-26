# A profile is evidence before its back-fill (2026-10-24, phase 4 of 9)

Dan: horses must "USE ANY AND ALL PLAYER DATA ON THE VERY FIRST HAND".

## What was wrong (read from production)

Each durable opponent profile carries `initialized`: whether the one-time
legacy back-fill (hands played before the durable memory existed) has been
folded in. That back-fill runs for one player per read request behind one
database-wide advisory lock. On 2026-10-24 **5,965 of 15,199 profiles** were
still waiting - 1,965 with 60+ hands of their own, **730 with 240+** (626
players), **24 belonging to human players** - and 1,167 of them had been
updated in the last hour. Every reader (the decision read, the completed-hand
read, the worker import) dropped them, so a horse met all of those players,
on the first hand at every new table, as strangers.

## Why using them is exact, not a guess

The counters in an awaiting row are complete for every hand since the memory
began. The back-fill only adds OLDER hands, and the counters decay with a
30-hand half-life (8 in the style-change window), so the older hands carry the
least weight - at 240 own hands the whole missing legacy is under 0.4% of the
read. Leaving it out is a smaller sample, never a biased one, and the Bayesian
credibility gate in `opponentExploitRead` already prices sample size.

## What changed

- `engine/HorseOpponentMemory.opponentProfileVersion` = `observed_hands * 2 +
initialized`: a back-filled row supersedes the awaiting row at the same hand
  count, and nothing ever regresses.
- `services/HorseOpponentMemory` (decision read, completed-hand read, cache) and
  `HorseMind.importDurableOpponentProfiles` (worker) accept every validated row
  and order by that version.
- The back-fill itself is unchanged and still completes rows over time.

## Pins

- `services/HorseOpponentMemory.test.ts`: the two pins that encoded "drop
  uninitialized rows" are replaced in this commit by the new contract (an
  awaiting row is read; a back-filled version supersedes; no regression).
- `engine/HorseOpponentMemoryDonor.test.ts`: an awaiting profile engages a read
  on the first decision (fails on the previous engine), the back-filled
  version replaces it, and a late awaiting snapshot never regresses it.

## Not in this phase (measured, deliberately)

Tuning to "how humans play Lightning" needs human Lightning data: three hours
of production Lightning held 2 human players in 6 seats against 130,681 horse
seats, and all cash play holds about 600 human hands. Tuning to that would be
guessing; the scoreboard (phase 2) and fleet counter-strategy (phase 5) are
built to switch on from real human results instead.
