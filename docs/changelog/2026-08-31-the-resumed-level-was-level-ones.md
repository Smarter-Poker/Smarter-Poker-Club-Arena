# 2026-08-31 — The resumed level's clock was level 1's (and now there is a guard)

Found while auditing Spins (Phase 4). It is not a Spin bug — every Spin level
is 180 seconds, so a Spin cannot see it — but it sits in the shared tournament
base that Spins run on.

## What was wrong

`TournamentManagerBase.resume()` restores the blind clock mid-level from the
persisted `level_started_at`. To do that it needs the current level's duration,
and it read the array directly:

```ts
const levelData =
  (tournament.blind_structure || [])[this.currentLevel] || (tournament.blind_structure || [])[0];
```

Past the end of the structure, `blind_structure[currentLevel]` is `undefined`
and the expression falls through to `[0]` — **level 1**. That is precisely the
case `resolveBlindLevel` exists to answer, and every other reader in the file
already goes through it.

It failed in the expensive direction. Most structures SHORTEN toward the end,
because that is what makes a final table: a live Mystery Bounty on this
platform opens on 4-minute levels and closes on 2-minute ones. A tournament
past its structure therefore resumed a 2-minute level as a 4-minute one, and
the blinds stalled for twice as long at exactly the depth where blind speed
decides the tournament. The same wrong number also fed the staleness window
below it (`elapsed < durationMs * 4`), doubling it, so a level that had
genuinely gone stale was accepted as resumable.

Measured over 14 days: 14,906 non-Spin tournaments, 7,315 with level lengths
that vary across the structure, 1,590 that ran past the end of it, and **1,499
that were both**.

## What this PR actually ships

**The one-line source fix landed on main while this branch was in review**, in
Phase 2.3 of the heads-up work (#2196 line of work), written independently and
**byte-for-byte identical** to the fix here. Two people reaching the same line
from different directions is a good sign about the line. It is a bad sign about
the file: this is now the _third_ time this rule has been broken in
`TournamentManagerBase`, and the second time it has been fixed without a guard.

So the merge takes main's source and this PR keeps the part main does not have:
**the guard**. `TournamentIntegrity.2026-08-27.guard.test.ts` currently has
zero assertions mentioning `resume` — its A1 rule ("every level read goes
through resolveBlindLevel, not a clamped index") was written around the
_shape_ that caused the 2026-08-27 incident, `blindStructure[Math.min(...)]`,
rather than around the rule itself. That is exactly why the same rule, broken a
slightly different way in `resume()`, went on passing for four days.

The new assertion is scoped to `resume()` via `sliceMethod` and verified in
both directions **against main's own implementation**, not just my phrasing of
it: reverting that source to the old shape turns the new guard red and leaves
the other twenty green; restoring it makes all twenty-one pass.

## Verification

`npx tsc --noEmit` clean. All 459 server tournament tests pass.
