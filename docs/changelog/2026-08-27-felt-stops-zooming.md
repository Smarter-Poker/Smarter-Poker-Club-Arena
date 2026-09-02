# The felt stops zooming in and out

**Dan, 2026-08-27, verbatim:** "THE CLUB ARENA GAME TABLE IS DOING THIS WEIRD
THING WHERE THE SCREEN IS MOVING IN AND OUT CONSTANTLY... THAT SHOULD NEVER BE
HAPPENING. ITS HAPPENING ON ALL TABLES."

## Root cause

`.table-scaler` has no height. It has `aspect-ratio: 605/1000` and a **width
derived from the height it is allowed to have**:

```
--sp-table-h    = --sp-page-h - --sp-table-top - --sp-table-bottom
.table-scaler   width: calc(var(--sp-table-h) * 605 / 1000)
```

That is a good design and it stays. Its consequence is the part that was
forgotten: **`--sp-table-bottom` is not a padding, it is the table's size.**
Every pixel that moves in that expression rescales the felt, the seat ring, the
pot, the board and every chip on it.

One term of it was `--sp-action-h`: the live, ResizeObserver'd border-box height
of `.action-panel-wrapper` (TablePage.tsx). That box legitimately changes height
several times in **every hand**:

| when                                                     | height                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| hero has no action (between hands, folded, all-in, away) | 1px — `[data-hero-action='none'] … :not(:has(*))`              |
| spectating                                               | 22px — the one-line footer                                     |
| hero's turn, or waiting on another player                | `--sp-bottom-row-h` + safe area (97px desktop, 53px phone)     |
| showdown                                                 | plus `.footer-action-bar` ("Show Hand"), which is flow content |

Measured on production (Chromium, 1204px wide, table
`f2c86e7a-e7c9-4d3c-b496-cd09ab33215d`) by setting the variable by hand:

```
--sp-action-h: 1px    ->  scaler 664.3 x 1098
--sp-action-h: 53px   ->  scaler 632.8 x 1046
--sp-action-h: 97px   ->  scaler 606.2 x 1002
```

So the felt swung about a tenth of its own size, with no transition, at least
twice a hand, on every table. Nothing was broken and every individual rule was
correct — **the bug was that a reserve for a box that comes and goes was a
measurement of that box**, so the reserve moved exactly when the box did, which
is precisely when nothing on screen may move.

Three more surfaces read the same variable and walked up and down the screen with
it: the HUD stack, the chat button (`--sp-hud-line`) and the post-BB-to-enter
pill — the last of which renders _only_ when the hero has no hand, i.e. only in
the state where the wrapper collapses.

## The fix

`--sp-action-reserve`, declared in CSS on `.table-page`, is the most the bottom
chrome may ever occupy. It takes two values and changes **only** when the player
sits down or stands up:

```css
.table-page {
  --sp-action-reserve: calc(var(--sp-bottom-row-h) + env(safe-area-inset-bottom));
}
.table-page[data-hero='false'] {
  --sp-action-reserve: calc(var(--sp-spectator-line-h) + env(safe-area-inset-bottom));
}
```

All four consumers read it. The ResizeObserver and `--sp-action-h` are **deleted**,
not merely unused — a live-looking variable is an invitation to read it.

`--sp-spectator-line-h: 22px` is declared in ActionPanel.css beside the padding
that produces it (3 + 15 + 4), the same way `--sp-bottom-row-h` already is.

**What this does not undo.** Dan's 2026-08-27 items 3 and 6 ("the bottom action
bar should not be dark when the hero doesn't have a hand... not a dark void") are
a paint concern and are untouched: the empty wrapper still drops its background,
its border and its pointer-events. What that rule may no longer do is change the
felt's size.

**The trade, stated plainly.** The felt no longer grows into the bar's space
between hands. It sits permanently at the size it already had whenever it was the
hero's turn. You cannot have both "the table grows into the bar's space" and "the
table never moves" when the bar comes and goes.

Measured on the live page with the new sheet injected (1477x1230 viewport,
embedded):

| state               | before       | after                    |
| ------------------- | ------------ | ------------------------ |
| spectating          | 651.6 x 1077 | 651.6 x 1077 (identical) |
| seated, hero acting | 574.1 x 949  | 574.1 x 949              |
| seated, hero idle   | 631 x 1044   | **574.1 x 949**          |

## Two more defects found in the same pass

Both are the same shape — a per-instance component reaching for a document-level
singleton — and both matter because **MultiTablePage keeps up to four TablePage
instances mounted and laid out at once** (an inactive slot is only
`pointer-events: none`, not `display: none`).

1. **`useTableEnvironment(tableId)` was called twice**, on consecutive lines in
   TablePage.tsx. The hook's viewport effect saves the meta tag's original
   content so it can restore it on unmount; the second copy ran after the first
   had already replaced it, so it saved the **poker** viewport as the original
   and wrote that back on the way out. Leaving a table could leave the entire app
   at `maximum-scale=1, user-scalable=no` — no pinch-zoom anywhere, until a
   reload. Fixed by calling it once, and by refcounting the viewport lock so the
   first table in takes it and the last table out gives it back.

2. **The background-tab pause wrote to `document.querySelector('.table-page')`** —
   the first such element in the document. All four instances fought over table
   one's root, and tables two to four kept every animation running in a hidden
   tab. It takes the caller's own root ref now. (The deleted ResizeObserver had
   the identical defect: four tables published their own bar's height onto table
   one, and tables two to four were never given a value at all.)

## Guard

`tests/unit/feltReserveIsStatic.test.ts` resolves the `var()` graph under
`--sp-table-bottom`, `--sp-table-h`, `--sp-page-h`, `--sp-table-top` and
`--sp-hud-line` across every stylesheet in `src/`, and fails if any property in
it is written from JavaScript anywhere in `src/`. It also fails on a global
`document.querySelector('.table-page')`.

A pixel-value test would not have caught this and would not catch the next one:
every individual value was correct. What has to be pinned is the shape.

Verified the guard actually fails: adding a throwaway
`el.style.setProperty('--sp-hero-clear', …)` turned two of its five tests red,
naming the file.

The four tests that pinned the old mechanism (`bottomBarReserve`,
`mobileBoardAndActionBar`, `actionBarSliderAndFooter`, `tableChatSheet`) were
rewritten in this same commit, not left asserting the rules this replaces.

## Results

```
npx tsc --noEmit          exit 0
npx vitest run tests/     509 files, 7981 tests, 0 failed
NODE_ENV=production vite build   built in 6.62s, exit 0
```
