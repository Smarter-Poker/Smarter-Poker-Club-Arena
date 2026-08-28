# 2026-08-28 — The hero's bet lift finally lands on main

## What Dan saw

Five separate reports that the hero's bet chips were still on the rail, five
claims that it was fixed, zero change on screen.

## Why nothing ever changed

The fix was real: commit `ad156cc146` ("fix(table): raise the hero's bet - the
one seat off the oval, by Dan's ruling") added `HERO_CHIP_LIFT_WIDTH_PCT = 6`
and applied it AFTER `clampIntoFelt` — the only place it can work, because the
hero's chair at y=100 overshoots the felt and the projection swallows any
addition to the rail itself.

But that commit was pushed to branch `agent/cowork-mobile3/feat/mobile-round-3`
on 2026-08-27 and **never merged**. Main is ruleset-protected: no pull request,
no merge, no World Hub sync, no deploy. Production has never contained the
lift. Every "it's fixed" report since was describing a branch nobody landed.

## What this commit is

A port of `ad156cc146` alone onto current main (the rest of the round-3 branch
is 67 commits stale and is NOT brought along):

- `src/components/table/tableGeometry.ts`: `HERO_CHIP_LIFT_WIDTH_PCT = 6`,
  `isHeroSeat()`, and the post-clamp lift in `chipRestPosition`. Hero bet moves
  from y ≈ 87.7% to ≈ 84.1% of the scaler at every table size; every other
  seat is bit-for-bit unchanged.
- `tests/table-geometry-chips.test.ts`: the two one-oval specs branch on the
  hero and pin the exception to the constant.
- `tests/unit/tourneyUxSweep20260825.test.tsx`: "hero is not the outlier"
  subtracts the lift, then makes its original assertion unchanged.

Branch-only imports from the unlanded `898817e62f` (isOnChipMarker,
chipMarkerHalf*, CHIP_AMOUNT_*) were removed from the test imports — they do
not exist on main.

## Lesson (again)

A fix is not deployed when it is committed, or pushed, or even green. It is
deployed when the PR is merged and the World Hub sync served it. Section 1.4:
claim success only on that evidence.
