# 2026-08-29 — nothing was comparing the art to the seat ring

## The guard

Dan, 2026-08-28: the final table is "broken and distorted around the table
where the seat buttons are".

`skin_final_table.png` is the only one of the fourteen table skins that paints
seat furniture into the rail — gold plates with amber jewels. Its geometry is
fine: 605×1000 RGBA like the other thirteen, and `.table-art` uses
`object-fit: fill`, so a wrong aspect ratio would stretch rather than misalign.
The problem is that the painted plates are not where `SEAT_POSITIONS_9MAX` puts
the seats, so every seat button lands on a plate edge or on a jewel.

It was authored that way in #1431 and shipped, because **nothing has ever
compared an asset against the seat ring**. There is no test that can fail when
art and geometry disagree.

There is now, and it does not need to understand a picture. The two seats on
each side rail sit at the same x (8 left, 92 right) and differ only in y (25
and 58), so whatever the palette they land on the same piece of rail:

1. **`sideRailStep`** — the luminance difference between the two seat patches.
2. **`midpointDeviation`** — how far the rail halfway between them sits from the
   average of its two endpoints.

The second one is what makes this usable. A dark-to-bright gradient (ice
cavern, neon city) can fail (1) loudly and still be perfectly fine art, because
a gradient's midpoint _is_ the average. A painted plate fails both: one seat is
on gold, its neighbour is on bare rail, and the rail between them is neither.

Measured across all fourteen skins with 44×44px patches:

| metric              | healthy 13 | `skin_final_table` | threshold |
| ------------------- | ---------- | ------------------ | --------- |
| `sideRailStep`      | 1 – 52     | **113**            | 70        |
| `midpointDeviation` | 0.4 – 22.9 | **54.7**           | 35        |

Both thresholds sit above every healthy skin with room to spare and still fail
the final table by more than half again. They are deliberately loose — this
catches a _new_ skin authored the same way, it is not a pixel assertion about
art.

The test reads PNGs with `zlib` and about sixty lines of un-filtering rather
than adding a dependency, and refuses anything that is not 8-bit RGBA
non-interlaced instead of guessing.

### The final table's own assertion is skipped, on purpose

The asset is still broken and the fix is redrawn art — a plain premium rail
that keeps the blue neon and gold trim identity and drops the per-seat
furniture. That needs Dan's sign-off on the look, so it is not something to
improvise into production, and a red test would block the World Hub sync for
every agent (CLAUDE.md §5.8).

So the spec is written and `.skip`ped with a note saying what has to be built,
and the commit that redraws the art deletes the `.skip`. A companion test
asserts the final table **still measures as broken**, so that if someone fixes
the art without unskipping, the now-vacuous guard says so out loud instead of
sitting there passing.

## A diagnostic that was crying wolf

`scripts/dev/tournament-health.sql` — read-only, safe against production.

The deadlock check agents have been handing each other reads "players at
`status='playing'` with `chips <= 0` in a RUNNING event — expect 0". It does not
expect 0 and it cannot. Measured this morning on `$100 Freeroll • 6:00 AM`
(355 entrants, 40 tables): **132 zero-chip players, unplaced, 82 minutes in,
and nothing wrong.** That event runs unlimited rebuys through level 6 plus an
add-on period, so a busted player is not out — they are waiting to buy back in.
The same event's four previous runs each recorded their first elimination at 67,
69, 70 and 74 minutes: every one at the moment the rebuy window closed. Today's
flushed at 83 and finished with a perfect 355-place ladder.

About forty minutes went into confirming a healthy tournament was healthy. A
check that fires on healthy systems is worse than none, because the next person
learns to ignore it.

The version in this file adds the two things the old one was missing — has the
rebuy window actually shut, and has the tournament been dealing hands since —
and returned **0 rows** during the exact window the naive query was reporting
6, then 45, then 102, then 132.

It also carries the corrected versions of the ladder, money-owed and
duplicate-seat checks. Two notes worth keeping in the file rather than in a
handoff:

- **multi-tabling is legal.** A player may hold up to `MAX_TABLES` open seats,
  so ">1 open seat" is not a bug; the real signatures are two seats at the same
  _table_ or in the same _tournament_.
- **the money-owed window is `started_at`, not `updated_at`** — see the
  companion change today; `updated_at` is never maintained and holds
  row-creation time.
