# The chart meets the deck

2026-09-06. The audit's longest-standing open item, answered as far as it
honestly can be.

## The item

> **A real PLO/short-deck solver export.** V46 is published hand-class
> structure, not a solver. Needs a data source that does not exist in this
> estate.

Still true. A solver produces frequencies at a node and there is no PLO solver
here. But there was one reference in the building that had never been pointed
at the chart: **the engine's own equity evaluator**, over the actual deck of
the actual variant. It cannot say how often to 3-bet. It can say whether a
class the chart calls strong is actually strong — and nobody had ever asked.

## What the deck says

Mean all-in equity against random hands, 90 hands per class, six-handed:

| PLO4           | 6-way     |     | short deck       | 6-way     |
| -------------- | --------- | --- | ---------------- | --------- |
| `broadway_ds`  | **.2763** |     | `sd_big_pair`    | **.2603** |
| `aa_ds`        | .2592     |     | `sd_suited_ace`  | .1974     |
| `kk_plus`      | .2262     |     | `sd_suited_conn` | .1859     |
| `aa_dry`       | .2081     |     | `sd_small_pair`  | .1658     |
| `pair_support` | .2049     |     | `sd_other`       | .1448     |
| `rundown`      | .1953     |     |                  |           |
| `dangler`      | .1746     |     |                  |           |
| `trash`        | .1686     |     |                  |           |
| `other`        | .1492     |     |                  |           |
| `trips`        | **.1010** |     |                  |           |

## What it vindicates

**`trips` is folded always, and it deserves to be.** .1010 against a
next-worst of .1492 — a class in a league of its own at the bottom of the
deck. That is precisely the claim V46 makes about it: the hold'em percentile
rates three aces as a monster and the game rates it at nothing. It is now
measured rather than asserted, and pinned by a law.

## What it questions, honestly

Three things the chart does not currently reflect. None is encoded as a
failure, because equity is not playability and pretending otherwise would make
the brain worse.

1. **`broadway_ds` out-equities `aa_ds` six-handed** (.2763 vs .2592), and the
   chart opens `aa_ds` widest. This is exactly what published theory says —
   aces lose value multiway — and the chart does not yet say it.
2. **`trash` (.1686) out-equities `other` (.1492)**, while the chart folds
   trash 100% of the time and plays `other` at normal bars. Defensible:
   `trash` is defined as the hand that can make no nuts, so it wins small pots
   and loses big ones, and reverse-implied odds are invisible to an all-in
   number. But it is a strong claim nobody had checked.
3. **`sd_big_pair` out-equities `sd_suited_ace` by a distance** (.2603 vs
   .1974), and the chart opens the suited ace wider. Also defensible — a nut
   flush draw realises far more of its equity than a pair does in 6+ — and
   also never checked.

## Why the law asserts so little

All-in equity against random hands is **not** playability. A rundown has the
third-lowest equity of the playable classes and is one of the best hands in
Omaha, because it flops draws it can realise and it is never dominated when it
hits. A law that pinned the chart to a strict equity order would be a
misunderstanding of the game encoded as a test.

So it asserts four things only: the worst class in the deck must be one the
chart folds; everything folded must be below the field average; the premium
classes must beat the marginal ones; and the sampler must still find every
class — so a classifier that quietly stops emitting one is caught here rather
than in production, which is how the 2026-09-05 `connectedSpan` defect reached
the fleet.
