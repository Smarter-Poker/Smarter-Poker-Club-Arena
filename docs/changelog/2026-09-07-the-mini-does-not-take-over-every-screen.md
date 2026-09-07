# The Mini jackpot does not take over every screen

2026-09-07, immediately after BBJ phase 6 merged. A line-by-line trace of every
consumer of the ledger the mini now writes to, and the three surfaces that could
not tell the two jackpots apart.

## What was wrong

`fn_bbj_mini_payout` writes a `bbj_winners` row, exactly like the main jackpot -
which is the right design: one ledger, one reconciliation, one Previous Winners
list. But **three separate subscribers listen to that INSERT**, and none of them
read the `kind` column phase 6 added:

| surface                            | what it does on an INSERT                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/lib/bbjHitFeed.ts`            | emits `BBJ_HIT_GLOBAL`, which `BBJHitAnnouncer` turns into a full announcement on **every page every player has open** |
| `src/components/bbj/BBJTicker.tsx` | prepends the hit to the scrolling strip                                                                                |
| World Hub `BBJDisplay.js`          | three heavy haptics, a two-second audio fanfare and a full-screen "JACKPOT HIT!" takeover                              |

The main jackpot fires **about once a fortnight** and pays six figures, which is
what earns a takeover. A mini fires **about four times a day** for a few hundred
chips. Shipped as it was, every player's screen would have been interrupted
every six hours and every phone in the club buzzed three times — and within a
week the real jackpot would have been indistinguishable from background noise.
That is CLAUDE.md 10.84's "an alarm that is always on is an alarm that gets
muted", except the thing being muted is the biggest moment on the platform.

Nothing had fired yet: no mini has hit in production, so this was caught in the
gap between merging and the first real one.

## What changed

**A mini is not hidden — it just does not interrupt.**

- `bbjHitFeed` refuses a non-main row on the **first line** of `announce()`,
  before any enrichment: four skipped announcements a day should also be four
  RPCs and two table reads that never happen.
- `BBJTicker` carries minis in the strip with a quiet `MINI` marker beside the
  amount. A 700-chip mini printed next to a 7,883.92 main with nothing between
  them reads as the big one having paid almost nothing.
- `BBJRecentHits` already badges them (phase 6).
- World Hub `BBJDisplay` skips the haptics, the fanfare and the takeover for a
  mini, still refreshes its data so the winners list updates, labels the row
  "Mini Jackpot", and titles the overlay "MINI JACKPOT HIT!" if one is ever
  shown deliberately. `pages/api/club-arena/bbj.js` passes `kind` through.

A mini still gets the **full celebration at its own table** from the engine's
own `bbj_hit` event, which is where the people it happened to are sitting.

**A row with no `kind` is a main jackpot** everywhere this is read. Every row
written before 2026-09-07 has none, so the behaviour for all 29 historical hits
is unchanged.

## Pinned

`tests/unit/theMiniDoesNotTakeOverEveryScreen.test.ts` — the announcement fires
for `main`, fires for a row with no `kind` at all, does not fire for `mini`, and
refuses the mini before doing any enrichment work.
