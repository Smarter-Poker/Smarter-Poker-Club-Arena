# Tile band audit: the empty smudge and the inert z-index

Follow-up audit of the Variant A tile band (PR #2015). Two real defects, both
found by measuring the shipped CSS in a browser rather than reading it.

## 1. A dead pseudo-element painted over the Fold button

`.multi-table-grid__cell::after` was `content: attr(data-table-name)`. Nothing
in this repo has ever set `data-table-name` — grep across `src/` and `tests/`
returns only the CSS rule itself. `attr()` on a missing attribute resolves to
the empty string, and `content: ""` does NOT suppress a pseudo-element: it
still generates a box. That box carried `padding: 2px 8px`, a 60%-black
background, a radius and a 4px blur, pinned `bottom: 8px; left: 8px` of the
cell.

While the cell's bottom-left was felt, this was an invisible-ish smudge on the
table. After Variant A the cell is a flex column and its bottom-left is the
ACTION BAND, so it painted over the Fold button's corner. Measured on a
300x400 tile before removal:

    ::after box   top 385.6  bottom 400  left 16
    Fold button   top 365    bottom 400  left 16   -> overlapping

Deleted rather than repositioned. A rule that can only ever render an empty
smudge has no correct position, and the tab bar already names every table.

## 2. The band's z-index was inert

The band shipped as `position: static` with `z-index: 20`. z-index does not
apply to static boxes, so the declaration was silently ignored — the band
LOOKED protected in the stylesheet and was not. That is exactly how defect 1
got to paint on top of it.

Now `position: relative; z-index: 20`. Relative keeps the band fully in flow,
so it still RESERVES its height, which is the whole point of Variant A.

## Verification

Measured in Chromium against the real stylesheet, after the fix:

    afterContent  none      beforeContent none      (smudge gone)
    bandPosition  relative  bandZIndex    20        (z-index real)
    stageHeight   350       bandHeight    50
    reservesSpace true (350 + 50 = 400)   bandBelowStage true

The stage shrank to make room for the band rather than the band covering the
stage — the hero's cards keep their size on the felt and are never covered.

## Pins

- The Variant A structural test no longer asserts the literal `static`, which
  forbade the `relative` the band now needs. It asserts the INTENT: the band is
  never `absolute`/`fixed`/`sticky`. It also fails a band that declares a
  z-index while static, so the inert-z-index bug cannot return.
- New pin: no cell-level `::before`/`::after` may generate a paintable box.

`npx tsc --noEmit` clean; 9763 tests across 676 files pass.
