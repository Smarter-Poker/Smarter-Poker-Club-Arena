# The entries list, rendered at 375px for the first time

**Date:** 2026-08-29

The 2026-08-28 flex-fill change removed `.et-scroll`'s `max-height` cap so the
list fills its panel instead of leaving 340px of void beside a scrollbar. It was
measured on an 860px desktop panel, and its own note then reasoned the rest:

> The fill is correct on a phone for the same reason it is correct here — the
> panel's height is the constraint, and the panel knows it.

The handoff was honest that nobody had actually rendered the page at 375px; the
geometry had only been checked by injecting CSS and measuring. So I rendered it,
on production, at 375×812.

## What the render showed

```
.et-panel          321px
  .tl-section-head  18px
  .et-stats        128px    <- 40% of the panel
  .et-scroll       160px    <- its own min-height, NOT what was available
```

Setting the floor to 0 in the live page dropped the list to **129px**, which is
the truth: it was overflowing its parent by 31px and being held up by its own
minimum. `.et-panel` had turned its overflow on to cope, so the reader got **two
nested scrollbars** — the exact shape the flex-fill change existed to remove —
and about **2.7 of 49 rows** visible.

The cause is not the list. `.tl-stat-grid` is shared and asks for
`repeat(auto-fit, minmax(104px, 1fr))`; at Entries' 309px inner width that
resolves to **two** columns, so its **three** tiles take two rows and the second
row is half empty. Sixty-four pixels of nothing, on the screen with the least to
spare.

## The fix, measured on the same live page

Three tiles, one row, below 480px; and a floor low enough that it can never
exceed the panel.

|                        | before                      | after                          |
| ---------------------- | --------------------------- | ------------------------------ |
| `.et-stats`            | 128px (2 rows)              | **64px** (1 row of 3)          |
| `.et-scroll`           | 160px, propped by its floor | **195px**, genuinely available |
| overflowing its parent | yes, by 31px                | **no**                         |
| panel's own scrollbar  | engaged                     | **gone**                       |
| visible rows           | 2.7                         | **4.1**                        |
| stat text clipped      | —                           | none                           |
| page scrolls sideways  | no                          | no                             |

Removing the floor after the fix leaves the list at 195px, not 129px — so it is
sized by the fill now, not propped by the minimum. That is the difference
between a fix and a bigger prop.

## The rest of the page at 375px, also verified

- **No horizontal overflow.** `documentElement.scrollWidth === 375`. The four
  elements that extend past the viewport are all inside proper
  `overflow-x: auto` containers (the tab strip, the nav list) — correct.
- **Satellite badge passes.** 123×26px, `white-space: nowrap`, and none of the
  13 badges on the page wraps. Rows stay a uniform 48px. `.et-marks` holds its
  148px cap. This is what the previous session predicted by injection; it is now
  confirmed by a real render.
- **Band 4 is fixed and live.** `padding: 9px 10px` — the phone rule applies,
  where the hardcoded inline `16px` used to block it. Section background is a
  real colour where `var(--surface)` (undefined estate-wide, confirmed again
  here) painted nothing.
- **No clipped text** anywhere in the info grid or the stat tiles.

## The satellite fixes, confirmed in production

The Detail tab now shows what it never has: real prize pools (540, 104, 180,
86, 270, 45, 72, 36 — previously **0** on every card), real buy-ins (25, 5, 10 —
previously **0**), `STRUCTURE: Turbo` / `Regular` read from the actual level
length instead of a hardcoded string, TURBO speed badges, and
"Late Reg Through Lvl 4/5/6" countdowns that had never once rendered.

## Only one tab needed this

`RankingTab`'s `.rk-list` uses `min-height: 0` with a `max-height` cap, so it can
always shrink and cannot prop itself past its parent. `.dov-info` likewise. A
test asserts no sibling tab grows a non-zero floor on a scroll container, so the
fix stays a fix in one place rather than a pattern six files copy.

## Tests

`tests/unit/entriesListFitsAPhone.test.ts`, 6 cases, verified red without the
fix (3 of 6 fail when the phone block is removed). jsdom does not lay out, so it
pins the two rules the measurement produced plus the invariant that made the bug
possible — a floor larger than the space available is not a floor, it is an
overflow.

One case was wrong first: it used `lastIndexOf('.et-scroll {')`, which finds the
phone override rather than the base rule, and so asserted the flex fill against
a block that only carries a min-height.

Full suite: 583 files / 8,918 passing. `npx tsc --noEmit` exit 0.
