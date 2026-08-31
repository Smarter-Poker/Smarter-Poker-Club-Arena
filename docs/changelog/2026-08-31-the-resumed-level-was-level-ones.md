# 2026-08-31 — The resumed level's clock was level 1's

Found while auditing Spins (Phase 4). It is not a Spin bug — every Spin level
is 180 seconds, so a Spin cannot see it. It is an MTT bug, sitting in the
shared tournament base, and it had been there since the fix that was supposed
to have removed exactly this class of defect.

## What was wrong

`TournamentManagerBase.resume()` restores the blind clock mid-level from the
persisted `level_started_at`, rather than granting a fresh full level on every
restart. To do that it needs the current level's duration, and it read it like
this:

```ts
const levelData =
  (tournament.blind_structure || [])[this.currentLevel] || (tournament.blind_structure || [])[0];
```

Past the end of the structure, `blind_structure[currentLevel]` is `undefined`
and the expression falls through to `[0]` — **level 1**. That is precisely the
case `resolveBlindLevel` exists to answer, and every other reader in the file
already goes through it.

## Why it mattered, and in which direction

It failed the expensive way. Most structures SHORTEN toward the end, because
that is what makes a final table: a live Mystery Bounty on this platform opens
on 4-minute levels and closes on 2-minute ones. A tournament past its structure
therefore resumed a 2-minute level as a 4-minute one, and the blinds stalled
for twice as long at exactly the depth where blind speed decides the
tournament.

The same wrong number also fed the staleness window just below it
(`elapsed < durationMs * 4`), doubling it, so a level that had genuinely gone
stale was accepted as resumable instead of being restarted.

Measured over 14 days: 14,906 non-Spin tournaments, 7,315 of them with level
lengths that vary across the structure, 1,590 that ran past the end of it, and
**1,499 that were both** — every one of which, on any restart, resumed its
clock on level 1's number.

## The part worth noticing

The comment directly above this code already describes this defect —
"granting a fresh full level on every restart (which nearly froze blind
escalation across restarts)" — and `resolveBlindLevel` carries a long note
about blinds past the end of the structure being derived, never stored. The
2026-08-27 audit fixed the in-structure case, added a guard test forbidding
`blindStructure[Math.min(...)]`, and left this one site indexing the array
directly. The guard was written around the shape that had caused the incident
rather than around the rule, so the same rule broken a slightly different way
went on passing.

## The fix

One call, through the resolver every other reader already uses:

```ts
const levelData =
  this.resolveBlindLevel(tournament.blind_structure || [], this.currentLevel) ||
  (tournament.blind_structure || [])[0];
```

`resolveBlindLevel` derives the level for any index, identically across
restarts (it never mutates the cached array — that was the 2026-08-27
incident), and keeps a Spin on the spin ladder rather than the generic
doubling.

## The guard

Added to `TournamentIntegrity.2026-08-27.guard.test.ts` beside the rule it
belongs to, and verified in BOTH directions rather than just asserted:
reverting the source to the old shape turns the new guard red and leaves the
other twenty green; restoring the fix makes all twenty-one pass.

`npx tsc --noEmit` is clean and all 459 server tournament tests pass.
