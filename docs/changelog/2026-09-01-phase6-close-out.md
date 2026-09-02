# Phase 6 close-out - every item, the regressions the full suite caught, and one revert

2026-09-01. Branch `phase6/seat-fill-and-headsup` (consolidated).

This branch carries the whole of Phase 6. The seven earlier Phase 6 branches
were stacked or independent and all seven are merged into this one lineage, so
there is a single reviewable diff and a single CI run instead of eight that
conflict on `SpinWheel.tsx`, `TablePage.tsx` and `docs/LAWS.md`.

## Every item

| #   | Item                                         | State                                                                                                                      |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Spin card said "300 chips / Turbo"           | fixed - prints the stack RANGE from `SPIN_TIERS` until the wheel turns                                                     |
| 2   | 100x celebration two-thirds invisible        | fixed - spread and delay derive from the real piece count                                                                  |
| 3   | One tile's wheel blanked all four            | fixed - scoped to its tile, still plays on an inactive one                                                                 |
| 4   | 14 seconds of dead felt                      | fixed - the wheel holds until the engine deals, with a live count                                                          |
| 5   | Late arrival got a flicker then nothing      | fixed - mounts into the result                                                                                             |
| 6   | Animation Speed did nothing to the wheel     | fixed - in the clamp                                                                                                       |
| 7   | Fallback wheel ran off a different column    | fixed - one deadline from one spec                                                                                         |
| 8   | Play Again onto a full table                 | fixed - capacity checked, dead query string removed                                                                        |
| 9   | Nothing said what the prize was              | fixed - badge reads `4x │ 40`                                                                                              |
| 10  | Paid 2nd/3rd through the bust door           | fixed - celebrated and held like a win                                                                                     |
| 11  | Heads-up never announced on a Spin           | **REVERTED - see below**                                                                                                   |
| 12  | Accessibility                                | fixed - no `aria-modal` without a trap, no `role="table"` over divs, and the buy-in sheet now has the whole focus contract |
| 13  | Short viewport clipped the reveal            | fixed - height media queries, scrollable buy-in sheet                                                                      |
| 14  | No seat-fill indicator                       | fixed - one indicator, both footers, no invented ETA                                                                       |
| 15  | Registration retried with no idempotency key | fixed - a retried "already registered" is adopted                                                                          |

## Item 11 is reverted, and the reason is a standing ruling

I built it: a Spin ran the same authoritative heads-up check and got a quiet
state-driven pill instead of the blocking takeover.

Then the full suite went red on `tests/unit/headsUpIsAnnounced.test.ts`, which
carries this:

> Dan 2026-08-23: "you never have to announce 'heads up' with an animation or
> final table on a spin" - it is three-handed from the first card.

A quiet static pill is arguably not "an animation or final table". That is
exactly the reading that would let me talk myself past a ruling Dan already
made, and this repo has been burned twice by an agent reinterpreting his words
narrowly (CLAUDE.md 10.7, the hamburger revert war). CLAUDE.md 10.8 rule 1 is
explicit: when a change collides with a standing law, STOP and ask - never
write a third law, never delete the other side on your own authority.

So the exclusion is restored exactly as it was, the pill and its CSS and its
law test are gone, and the question goes to Dan:

**The audit says a Spin never acknowledges becoming heads-up. Your 2026-08-23
ruling says it never has to. Do you want a quiet, non-animated marker there, or
is the silence deliberate?** Either answer is one small change.

## Five regressions the full suite caught, all fixed here

Worth naming, because four of them were mine and the targeted suites were green:

1. **`spinSpec` client/server copies must be byte-identical.** I added
   `spinStartingStackRange()` to the client copy only. Two separate tests exist
   to catch exactly that, and both fired. Mirrored.
2. **`headsUpIsAnnounced`** - the item 11 collision above.
3. **`lobbyMobileCards`** pinned "calls a 300-chip spin a turbo", which is the
   bug item 1 fixes. Deliberate replacement, so the pin moved in the same
   commit (rule 8) and now asserts the rule instead: an undrawn Spin has no
   depth label, a drawn one reads the column exactly as before.
4. **`gameplay-wears-the-house-colours`** - my seat-fill dots used `#22c55e`.
   The house green is `#3fb950` and one test keeps all 47 literals honest.
   Changed.
5. A **stale-state gap I found myself**, not a test: `spinPrizePool` is
   captured from one tournament and this component survives the next one
   starting on the same table - Spins recycle a table in seconds. Without a
   reset the badge would carry the PREVIOUS game's prize into the new one until
   its wheel finished. Wrong in the most believable way possible: a number that
   looks right. Cleared on `tournamentId` change, and pinned.

## Verification

- `npx tsc --noEmit`, client and server: clean.
- **Full client suite: 818 files, 11,226 tests, all green.**
- Full server suite runs in CI on this pull request.
- 9 new law tests across Phase 6, all registered in `docs/LAWS.md`.

## Still not verifiable from here

No logged-in browser session is available to this agent, so everything visual -
the confetti spread, the seat-fill dots, a wheel inside a tile, 375px landscape,
and how any of it reads in a screen reader - is argued from arithmetic and
markup rather than from having looked at it. That is the one gap this work
cannot close on its own.
