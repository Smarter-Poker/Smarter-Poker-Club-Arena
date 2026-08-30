# 2026-08-30 — The ticker takes the band under the header, and the Club Arena background becomes one black

Dan, with two screenshots:

> THE TICKER, MUST ALWAYS BE AT THE VERY TOP OF THE PAGE, DIRECTLY UNDER THE
> GLOBAL HEADER, THE "ACTION TAB" SHOULD NEVER BE ABOVE IT ... NOTICE THE
> BACKGROUND OF THE CLUB ARENA. ITS NOT ALL THE SAME COLOR AND YOU CAN SEE SOME
> OLD BORDER IMAGES ON THE SIDES. THE WHOLE BACKGROUND SHOULD BE SOLID BLACK AND
> ALL THE SAME COLOR. (INCLUDING THE ACTION TAB AREA.)

## 1. The ticker sat below the action tab because it was measuring it

On 2026-08-23 the ticker and the multi-table tab bar collided on `/table/*`: the
strip is fixed and 34px tall at z-index 9400, the bar stacks at 200, and every
tap on "+" hit the ticker's marquee instead. That was fixed by adding
`.table-tab-bar` to `TOP_CHROME_SELECTORS` so the ticker starts below the lowest
piece of top chrome — which is exactly what put the action tab above the ticker
in the lobby, and is the arrangement in Dan's screenshot.

The same collision is solved the other way round now. **The ticker anchors to
the global header alone; the bar moves.**

- `TOP_CHROME_SELECTORS` is back to `['#global-header', 'header']`.
- `TournamentStartingTicker` measures itself and publishes `--mtt-ticker-h` on
  the document element. It **removes** the property rather than setting it to
  zero when no bar is up, so the `var(--mtt-ticker-h, 0px)` fallback is what
  applies on a quiet schedule and nothing moves.
- The pinned bar starts at `calc(header + ticker)`; the in-flow bar on
  `/table/*` takes the same offset as a `margin-top`; `--ca-pinned-bar-offset`
  (AppLayout's in-flow clearance) grows by the same amount, so page content
  clears both strips.
- The notch is still paid exactly once. When the ticker is topmost (no global
  header, i.e. `/table/*`) it has paid `env(safe-area-inset-top)` itself and
  publishes `--sp-tabbar-inset: 0px`, which the tab bar's `padding-top` reads.
  Paying it twice is the ~47px dead band this pairing has produced once already.

The "+" is safer under the new rule than the old one: the two are never in the
same pixels on any route, rather than depending on a measurement finding a bar
that mounts late.

**One thing was written and then reverted, deliberately.** Subtracting
`--mtt-ticker-h` from `--sp-page-h` looks obviously right — the strip does take
a band off the viewport on `/table/*`. It is a bug. `--sp-page-h` is the felt's
SIZE, not a padding, and `--mtt-ticker-h` is written by JavaScript when an MTT
enters its five-minute window, which is mid-hand. Feeding it in would rescale
the felt, the seat ring, the pot and every chip on the table while a hand is
live — precisely what `tests/unit/feltReserveIsStatic.test.ts` refuses. Its
closing instruction is the answer: reserve in CSS and let what varies overlay
the felt. The tab bar moves for the ticker; the felt does not.

## 2. The background is one black now

`.casinoStage` — the route shell `<main>` — was three things at once, all of
them visible in the gutter either side of the 1400px content column, which is
exactly where `.club-home`'s own `#000` stops:

- a vault photograph under a translucent wash, so the gutter read as a dark
  blue-grey that never quite matched the page;
- `::before`, the **route art**: a club / wallet / tile PNG bleeding in from the
  right edge at 0.28 opacity — the "old border images on the sides";
- `inset 1px` highlights down both edges plus `::after`, a blue hairline across
  the top — two more borders on the background he asked to be one colour.

All of it is gone for one opaque `#000`, and everything around it was brought to
the same value:

| Surface | Was | Now |
| --- | --- | --- |
| `.casinoStage` (route shell) | photo + route art + inset borders | `#000` |
| `.layout` (app shell) | `--club-black` `#050507` | `#000` |
| `body` (club-engine.css, the live rule) | `--club-black` `#050507` | `#000` |
| `.table-tab-bar` | translucent gradient + blur + saturate | `#000` |
| `.multi-table-page__tab-bar-wrapper` | same gradient + blur + inset sheen | `#000` |

Five points of grey is invisible on its own and obvious next to true black,
which is what "not all the same color" was. The tokens (`--club-black`,
`--near-black`) stay defined for the raised surfaces that want them; only the
page ground changed.

The tab bar keeps a 1px bottom border, coloured black: that pixel is a term in
the `--sp-tabbar-h` sum which `TablePage.css` subtracts to size the felt, so
removing it would have silently changed the table's height. The bar's
`backdrop-filter` went with the alpha — there is nothing left to blur through an
opaque surface, and it was costing a compositor layer per table.

`--casino-route-art` is still set in `AppLayout.tsx` and deliberately unread:
one line to restore if a themed stage ever comes back.

## Pins

- `tests/unit/mttTickerAnchor.test.ts` — rewritten. Pins the reversed rule (the
  ticker anchors to the header; `.table-tab-bar` is *not* measured), the offset
  on both bar variants and on page clearance, the notch being paid once, that
  `--sp-page-h` must **not** depend on the ticker, and that the shell, the body
  and both bar surfaces are `#000` with no art, no alpha and no side borders.
- `tests/action-bar-never-leaves.law.test.ts` and
  `tests/unit/pinnedBarOffsetIsSubtracted.test.ts` — updated in the same commit,
  as rule 8 requires: they pinned the pre-change `top` and offset strings.

`tsc --noEmit` clean. Full suite green: 9591 tests.
