# 2026-08-29 — Verifying the straddle and mystery-bounty fixes in production

No code changed in this entry. It records what was _proved_, what was not,
and where the remaining proof will come from — because two fixes were merged
yesterday whose whole point is behaviour that had never once been observed.

## What was proved

**Both fixes are in the running engine.** The production container is
`club-arena-engine:5d68828a2200d7de06b3601844d85ae46fed3ad1`, started
2026-08-29 11:11:18Z. That commit contains `3b61b57fa1` (#1678, straddle) and
`028f290fbf` (#1679, mystery bounty) as ancestors, and grepping that exact
commit's tree — not `main`'s — finds `auto_utg_straddle: config.straddleEnabled
=== true` in `HorseFleetManager.ts` and the `alreadyPaidCents` cap wired from
`TournamentManagerBase.ts:811`. Read from the container, not from `/health`,
which is CDN-cached and cannot be trusted for this (CLAUDE.md §11).

**Straddles now post.** This is the claim the previous session explicitly
refused to make, and it is now true. On table `9bda8a79` (`NLH Straddle
1.00/2.00 #2`), since the restart: 118 hands, **101 `straddle` actions of
exactly 4.00** — 2x the 2.00 big blind, the correct UTG straddle.
`horse_brain_telemetry` shows `v18_straddle` at **1,462 fires today**, last
updated 12:06Z. The V18 straddle brain layer, which had shipped on Aug 26 and
never executed once, is now live. The cause of the earlier zero was exactly as
diagnosed: the engine had cached `tableInfo` before the column was flipped, so
`StraddleEngine` still held `mandatoryUtg: false` until the redeploy re-read it.

**The mystery-bounty arithmetic agrees with the live SQL function.** Read
`fn_mystery_bounty_seed`'s definition from production and compared it to
`mysteryPoolCents`:

|       | SQL seed                                                  | engine                                                                                     |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| half  | `floor(bounty_cents * m / (m+r))`                         | `Math.floor((bountyPoolCents * m) / total)`                                                |
| cap   | `IF half > bounty - paid THEN GREATEST(0, bounty - paid)` | `Math.max(0, Math.min(half, bountyPoolCents - paid))`                                      |
| cents | `round(numeric * 100)`                                    | `poolCentsFromNumeric` → `Math.round(n * 100)`, and it throws on anything not a whole cent |

The two branches are equivalent in both directions, and the rounding is the
same operation on the same non-negative values.

Then replayed the formula read-only across **all 243 real mystery events**:

```
events                        243
old engine would be REFUSED   163      <- inventory_mismatch, the shipped bug
new engine would be REFUSED     0
new engine AGREES             243
```

Three `Pre-Dawn Mystery Bounty (PLO5)` events are the clean demonstration:
pools of 3000 cents with 2100 / 2400 / 2500 already paid flat. The old engine
asked for 1500 in all three and was refused every time; the new engine asks for
900 / 600 / 500, which is exactly what the seed will accept.

## What was NOT proved, and why

`tournament_bounty_awards` is **still empty** and `tournament_bounty_chests`
still holds only the 104 voided rows from Aug 26–27. That is not a failure of
the fix — **no mystery event has run since the fix deployed.** The last one
finished 2026-08-28 20:46Z; the engine restarted with the fix at 11:11Z today.

The every-minute Spins and Heads-Up turbos carry `is_mystery_bounty = true` but
`bounty_pool = 0`, so they exit at the first guard and can never seed a chest.
77 of the 243 events are in that state. Worth a separate look: a 1-chip Spin
advertising a mystery bounty it has no pool to fund is misleading in the lobby
even though it costs nobody money.

## The referees

Two real, funded, correctly configured events will settle this:

| event                 | id                                     | start (UTC)      | pool   | mystery half |
| --------------------- | -------------------------------------- | ---------------- | ------ | ------------ |
| Saturday Mystery      | `ee57f2b3-0055-46d6-aa74-30471ed9b937` | 2026-08-30 01:00 | 432.00 | 21600c       |
| Sunday Funday Mystery | `b205d075-913d-499f-af90-9d3b0fb18100` | 2026-08-31 01:00 | 300.00 | 15000c       |

Both: `is_mystery_bounty` true, 50/50 split, `classic` profile, `at_the_money`
activation, `bounty_pool_paid` currently 0. Proof is a `mystery_bounty_stage`
of `active`, non-void rows in `tournament_bounty_chests`, and the first row
ever written to `tournament_bounty_awards`. A scheduled check runs after the
Saturday bubble and reschedules itself onto Sunday if that one is inconclusive.

Per CLAUDE.md §11.5 the seed was **not** probed against production. It is a
money path; the arithmetic is asserted in unit tests and replayed read-only
above, and the live proof is left to the events themselves.

## Also found: the shared World Hub clone was stranded

`~/Documents/Smarter-Poker-World-Hub` had been sitting mid-`cherry-pick` since
2026-08-27 with live conflict markers in three tracked files
(`pages/training-table-demo.js`, `src/components/poker/TrainingGameTable.jsx`,
`src/components/training/games/UniversalDynamicTable.jsx`), 447 commits behind
`origin/main` and 4 commits ahead. CHECK 4 of the World Hub safety gate blocks
conflict markers, so anything pushed from that clone would have failed — and
the Antigravity `git reset --hard origin/main` loop would have taken the four
local commits with it.

Cleared without deleting anything:

- the 4 local-only commits are preserved on `backup/worldhub-stranded-2026-08-29`
- copies of all four dirty files are in `~/Documents/_stranded-worldhub-backup-2026-08-29/`
- `git cherry-pick --abort` then cleared the unmerged state

The clone is still 447 behind; syncing it is its owner's call
(`scripts/git-unstick.sh` is the sanctioned path). The stranded commit was
`d882541fde fix(training): lock Club Arena gameplay composition`.

## Verification

`npx tsc --noEmit` exit 0. Client suite 8,579 passed (559 files). Server suite
2,308 passed (211 files). Worktree
`~/Documents/.agent-trees/club-arena/cowork-fable`, never the shared clone.
