# Phase 6 item 3 - a wheel belongs to its own table

2026-09-01. Branch `phase6/wheel-stays-on-its-tile`.

## What it did

`.sw` — the Spin wheel's root — is:

```css
.sw {
  position: fixed;
  inset: 0;
  z-index: 99997;
  pointer-events: auto;
}
```

Right for a single table. Wrong for tile view, where four `TablePage`
instances are on screen at once. A Spin firing on one table painted over **all
four** and swallowed their input for the entire hold, roughly fifteen seconds.

Two harms, and the second is the one that costs money:

1. three tables you are playing are covered by a wheel belonging to a fourth;
2. you cannot act on any of them. You can be **timed out on a table you cannot
   see, behind a wheel you are not watching** — and you cannot even click the
   tile to bring it forward, because the overlay eats the click that
   `.multi-table-grid__cell`'s `onClick` was waiting for.

Two fixed-position layers rendered within a hundred lines of it already handle
this correctly (`isOpen={isActive && !!heroPineappleCards}`,
`isVisible={… && (!isMultiTable || isActive)}`). The wheel was simply never
given the same treatment.

## The fix is scoping, not suppression

That distinction is the whole point, and it is now a law.

The obvious fix is to stop rendering the wheel on an inactive tile. That would
pass "does not cover the other three" and break **CLAUDE.md 10.6**: an
animation plays every time it is owed, for its full duration. The draw is owed
on ITS table. Suppress it and a player who switches to that tile after the
shared clock has run finds the moment their format exists for already gone —
and the Spin reveal is the single defining beat of the format.

So the wheel keeps playing and stops escaping:

- `scoped` swaps `position: fixed` for `position: absolute`.
  `.multi-table-grid__stage` is already `position: relative; overflow: hidden`,
  so the wheel is clipped to the tile that owns it. No layout change was needed
  in the grid;
- the scoped z-index drops from 99997 to 60. It only has to sit above its own
  felt, and a five-digit z-index inside a tile is an invitation to escape it
  again later;
- `captureInput` is false on a tile the player is not looking at, so the click
  that SELECTS that tile reaches the cell underneath. The player moves their
  own view — the same principle as the no-auto-switch law.

Single-table play is untouched: `scoped={isMultiTable}` and
`captureInput={!isMultiTable || isActive}` both collapse to the old behaviour.

## The law

`tests/a-wheel-belongs-to-its-own-table.law.test.ts`, registered in
`docs/LAWS.md`. Four pins, and the fourth is the important one:

- scoped to the tile, absolute, in multi-table view;
- a local z-index rather than the viewport-level one;
- input passes through on an inactive tile;
- **it still plays on an inactive tile** — nothing may gate the component's
  mount, its data or its sequence on being active. That pin exists so the next
  person to read "wheel covers other tiles" does not reach for the suppression
  fix, which is how a 10.6 violation would enter through a bug report.

## Verification

- `npx tsc --noEmit`: clean.
- `a-wheel-belongs-to-its-own-table` (4), `law-registry` (40),
  `animations-always-play` (59), `no-auto-table-switch` (5): **108 tests, all
  green** — the last two included deliberately, because this change is in the
  blast radius of both.
- The full client suite runs in CI on this pull request.

Not verifiable from here: what it looks like. There is no logged-in browser
session available to this agent, so the containment is argued from
`.multi-table-grid__stage` already being `position: relative; overflow: hidden`
rather than from having watched a wheel spin inside a tile.
