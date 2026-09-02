# The Tier Outranks The Column On A Spin, And The Draw Now Reaches Memory Whole

**Date:** 2026-08-31
**Branch:** `cowork-claude-spintruth`

A Spin's real payout ladder lives in `SPIN_TIERS` (`server/src/config/spinSpec.ts`):
10x pays `[0.8, 0.2]`, and 25x / 50x / 100x pay `[0.8, 0.12, 0.08]`. Only the
sub-10x tiers are winner-take-all. Three places believed otherwise, and two of
them reached money.

## 1. The draw was synced to memory four fields out of five

`TournamentManagerBase.start()` draws the tier, writes ONE patch
(`spinRowPatch`: prize pool, multiplier, premium flag, starting stack, blind
ladder, payout structure, reveal lag) to `tournaments`, and then makes the
in-memory copies agree because the row is never re-read.

That sync was a hand-written list of field names and it copied FOUR of the five
fields the patch carried. `payout_structure` was the one it dropped, so for the
whole life of a started Spin `this.tournamentCache` held the **pre-draw
winner-take-all placeholder**. `recalculateEliminatedPrizes`
(`TournamentManagerEliminations.ts`) and the hand-for-hand bubble check both
read that cache, so an eliminated player's top-up was computed against a
different structure than the payment it was topping up. The sync block's own
comment already promised the cache "must agree with what was just written"; a
list of names cannot keep that promise.

`server/src/tournament/spinDrawSync.ts` (`applySpinDrawPatch`) makes it
mechanical: every key of the patch lands on every target, so the patch is the
only list there is and a sixth field is synced by construction.

The pins in `SpinDrawIntegrity.guard.test.ts` are deliberately **not** today's
five field names — a name list is what failed. They are: the helper copies
whatever it is handed (including a field invented inside the test), and the
draw site hands over the whole patch and re-copies nothing by name. Verified by
mutation: re-adding a single `this.tournamentCache.blind_structure = ...` line
turns the guard red.

## 2. `resolvePayoutStructure` preferred a stale placeholder over the tier

It preferred the stored `payout_structure` column for every format, falling
back to the spec only when the column was missing or corrupt.

**The rule now:**

1. A Spin whose multiplier the ladder knows — **the tier wins, always.**
2. A Spin whose multiplier the ladder does not know (not yet drawn; a retired
   tier such as the old 500x) — the stored column, the only thing left.
3. Anything else — the stored column, then null. **Unchanged**, deliberately:
   an operator's MTT ladder is a decision and still outranks anything derived.

The reasoning is that a Spin has no payout decision to store. Its split is a
pure function of the multiplier and nobody, operator included, may author a
different one — so a stored structure on a Spin is only ever a COPY of the tier,
and one that disagrees is stale rather than chosen. Below 10x the derived and
the honest stored value are the same `[{1,100}]`, so nothing moves on ~98.9% of
spins; where they differ, the tier is the one the reserve pool settled against.

`spinStoredStructureIsStale()` is exported alongside it for diagnostics: this
module keeps its no-imports-but-spinSpec discipline, so it cannot report the
divergence itself, but a caller with a reporter can now say out loud that the
start-time rewrite did not land.

## 3. The horse's "winner take all" comments were false above 10x

`HorseLogic.ts` (5 sites) and `HorsePreflop.ts` (2 sites) all asserted that a
spin is winner-take-all chip EV. True for ~98.9% of spins by frequency, false
for the 10x-and-up tiers that carry the biggest prizes on the platform.

**No strategy branch was keyed on the false premise, and none is changed:**

- `icmRisk` already tested `spotsPaid <= 1`, not the format, so a multi-place
  spin already fell through to the full ICM model. The code was right and only
  the comment lied. It gets _more_ right with fix 2, because `spotsPaid` comes
  from `TournamentBrainContext` -> `resolvePayoutStructure`, which now reports
  2 or 3 on a 10x+ carrying a stale placeholder instead of 1.
- The V23 spin overlay and the V12 preflop widen stay ON at every tier. What
  they price is the STRUCTURE — three seats, shallow stacks, 3-minute levels —
  which is identical across the ladder. The ladder itself is priced in exactly
  one place, `icmRisk`, and it already reaches both call sites through
  `riskAdd` / `bluffScale`. A second tier-aware damper would count it twice.

## 4. Historical damage — reported, not repaired

Live SELECTs, 2026-08-31 (no writes of any kind; CLAUDE.md 11.5):

|           | games  | pool         | paid to 1st  | owed 2nd   | owed 3rd |
| --------- | ------ | ------------ | ------------ | ---------- | -------- |
| 10x       | 60     | 1,160.00     | 1,160.00     | 232.00     | —        |
| 25x       | 2      | 100.00       | 100.00       | 12.00      | 8.00     |
| **total** | **62** | **1,260.00** | **1,260.00** | **244.00** | **8.00** |

**252.00 chips were paid to first place that the tier owed to second and third**
across 62 COMPLETED spins carrying `[{place:1,percentage:100}]` at 10x or above.
Every one of those games paid out exactly 100% of its pool, so the pool is
whole — the money went to the wrong seat, it did not vanish. **This is an open
item for Dan: whether to back-pay the 62 second/third finishers, and from
where.**

A further 148 rows at 10x+ carry the same placeholder but are CANCELLED and
never paid. Three of the 60 10x games have no `position = 2` row recorded at
all (`5f724500`, `f10ff237`, `f37f96a5`) — a separate reporting gap, worth a
look but not this change.

**Nothing needs fixing forward.** Every in-flight spin today (39 RUNNING, 30
REGISTERING, 1 COMPLETING) is either pre-draw or sub-10x, where winner-take-all
is correct. For a future high-tier spin the start-time rewrite plus fix 1 and
fix 2 are together sufficient: fix 2 means even a failed row write now pays by
the tier, and fix 1 means the cache the top-up reads agrees with it.

## Tests

- server: `297 files / 3346 tests` pass; `npx tsc --noEmit` clean.
- client: root `tsc --noEmit` clean; `tests/config/spinSpec.test.ts` +
  `tests/unit/TournamentFromTableConfig.test.ts` pass (69).
- `payoutStructure.test.ts`: the pin "prefers the stored column when it is
  usable" asserted a stored winner-take-all beating the 25x tier — i.e. the bug
  as law. Re-encoded to the new rule in this commit, with the non-Spin half kept
  on an MTT where it is still true.

## Not touched

`src/lib/tournamentFromTableConfig.ts` — draft PR #2334 is already rewriting the
same "a spin is winner-take-all by definition" comment there.
