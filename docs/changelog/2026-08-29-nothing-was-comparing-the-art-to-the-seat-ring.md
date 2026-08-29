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

---

## The white edging (added later the same day)

Dan, on seeing the seat-mismatch picture above: _"ALL THAT WHITE EDGING AROUND
THE TABLES MUST NEVER BE THERE EITHER."_

He is right, and it was visible in the diagram I had just drawn for him. It is
not CSS — there is no border or outline on `.table-art`. It is baked into the
assets.

Seven of the fourteen skins were exported from a tool that composited them
against **white** and then wrote an alpha channel. The opaque interior is fine,
but every partially transparent pixel on the silhouette kept its white RGB —
and so did the first fully-opaque ring behind it. Over the app's dark
background those pixels composite as a white halo tracing the whole table.

Measuring it correctly matters more than it sounds. "How white is the edge"
condemns golden sand forever, because a pale gold rail is legitimately
near-white. What a matte actually looks like is **an edge that does not belong
to the picture behind it**: compare each partially transparent pixel with the
solid artwork within two pixels of it. Correct anti-aliasing reads about zero.

| skin            | before | after |     | skin         | reading |
| --------------- | -----: | ----: | --- | ------------ | ------: |
| jade city       |  148.0 |  −1.0 |     | crimson      |    −2.5 |
| electric purple |  116.5 |  −1.2 |     | mahogany red |    −2.0 |
| classic green   |  103.2 |   0.0 |     | ocean blue   |    −1.4 |
| carbon red      |  101.7 |   0.6 |     | final table  |     8.3 |
| carbon ion      |   83.0 |   0.0 |     | neon city    |     8.4 |
| amethyst cavern |   74.3 |  −0.0 |     | arctic white |    10.6 |
| golden sand     |   51.7 |   1.9 |     | ice cavern   |   −72.0 |

**Nothing was redrawn and no alpha was touched** — verified against `HEAD`, the
alpha channel is bit-identical on all seven and the dimensions are unchanged.
The repair bleeds the artwork's _own_ colour outward into the edge pixels,
which is the standard fix for a matte fringe. Between 6,000 and 18,000 pixels
changed per skin, all of them on the silhouette.

One detail worth keeping: the colour has to be sampled **one pixel deeper than
the first opaque ring**. Bleeding from that ring leaves a third of the halo
behind, because on these exports the ring is itself part of the matte — fully
opaque and still white. Eroding the source mask by one pixel takes the colour
from under the matte, and every skin then lands within ±2.4 of neutral instead
of +30.

`scripts/dev/table-skin-defringe.py` does the repair and is safe to re-run;
`tests/table-skin-no-white-edging.law.test.ts` fails any future asset that
arrives with a matte. Checked that the guard is not vacuous by restoring the
old jade city and watching it fail at 148.0 against a limit of 20.

### The limit is one-sided, on purpose

Ice cavern reads **−72**: its outer edge is much darker than the artwork behind
it. That is a painted shadow, it is art, and it is left alone. "No white
edging" is not "every edge must be neutral", and a guard that flattened both
directions would quietly delete somebody's work.
