# 2026-08-30 — Audit round five: a loose-cannon selector, an unreserved band, and main red again

Third pass over the same surface. Two real bugs in code I own, one of them
long-standing and one introduced this morning, plus main red for the second
time on the same rule.

## 1. `header` was a loose cannon in the ticker's anchor list

`TOP_CHROME_SELECTORS` carried a bare `'header'` alongside `'#global-header'`,
and `measureTopChromeBottom` takes the LOWEST bottom edge among its matches.

`document.querySelector('header')` returns the FIRST `<header>` in the
document — not the top chrome. This app renders more than twenty of them: game
cards (`agc-premium-header`, `agc-mtt-header`), the lobby and filter panels,
every BBJ panel, hand detail, hand replay, Club Buttons, the union and profile
modals. Any of those, anywhere down the page, beat the real header and dragged
the ticker onto the felt. Open the BBJ panel on a table with an MTT five
minutes out and the announcement relocated to the bottom of that panel.

The fallback was there for "routes that predate the id". **There are none.**
`GlobalHeader.tsx` sets `id="global-header"` unconditionally, and the only
other candidate — `Shell.tsx`'s `.shell-header` — is imported by nothing. So it
covered no route and cost every route. Removed.

Belt and braces on top: `TOP_CHROME_MAX_TOP_PX = 64`, and anything starting
further down the viewport than that is skipped. A sticky header sits at y=0 and
pays the notch as _padding_, so its own rect starts at 0; 64px keeps any
plausible top bar and excludes content headers below.

## 2. Nothing reserved the ticker's band when no table was open

The in-flow clearance slot in `AppLayout` expands only under
`body[data-ca-pinned-bar='1']`, which is set while a table is open. In a lobby
with **no** tables open there was no reservation at all, so a live ticker sat on
top of the first 34px of the club card — the strip Dan had raised on 2026-08-24
to sit "1 pixel under where the ticker runs through under the global header".
The layout was already written as if this reservation existed.

The base rule reserves `var(--mtt-ticker-h, 0px)` now. The pinned rule still
spends `--ca-pinned-bar-offset`, which `MultiTablePage.css` already defines as
`calc(48px + var(--mtt-ticker-h, 0px))` — one slot, both strips, each counted
once. Absent a ticker the property is unset and the slot is still zero.

## 3. Main was red again, same rule, a different file

`noFixedSizeSourceWindows` was failing on `rebuyNeverRaces.guard.test.ts`, which
bounded three windows with `+ 1600`, `+ 4000` and `+ 1400`. All three now use
`sliceEnclosingBlock` from `server/src/testHelpers/sourceWindow.js`.

Worth recording for the next person: `sliceStatement` is the wrong extractor
when the anchor sits **inside a block comment** — it scans forward from the
anchor for the statement's own semicolon and returns the comment. The
`.lte('chips', 0)` pin needs the enclosing block.

And the negative pin in that file (`not.toMatch(/needsRebuyPause = true/)`) is
the strongest argument for the whole rule: a window bounded by a byte count
that stops short passes by looking at nothing at all.

## 4. Reduced motion truncated the announcement with no sign it had

With `prefers-reduced-motion` the marquee stops and the first copy of the
message is shown static — correct, motion collapses and meaning does not. But
`.mtt-ticker__scroll` is `inline-flex`, sized by its content, so it stayed wider
than the bar and the line was cut dead at the edge with nothing to say it
continued. It now ellipsises: `max-width: 100%` + `min-width: 0` on the
scroller, `text-overflow: ellipsis` on the message. The strip is a button on to
the event either way, and the copy is built most-important-part-first
("505 Overlay Right Now - <event> - ..."), so what survives the truncation is
the part worth reading.

## Also checked, and deliberately left alone

- **`--sp-page-h` over-states by the ticker's height on `/table/*`.** The felt
  is sized from viewport math that does not know the tab bar moved down. Adding
  `--mtt-ticker-h` to that expression is forbidden — it is JavaScript-written
  and the ticker arrives mid-hand, which is exactly what
  `feltReserveIsStatic.test.ts` refuses. The consequence is bounded and benign:
  since 2026-08-18 the art and the seat ring stretch by the same linear map
  (`object-fit: fill`), so the felt reads marginally squatter for the five
  minutes a ticker is up rather than putting seats off the rail. Left as is,
  with the reasoning in the stylesheet.
- **`insideClub` uses `pathname.startsWith('/table')`**, which would also match
  a `/tables` route. `App.tsx` declares only `table/:tableId`, so there is
  nothing to collide with, and tightening route matching carries more risk than
  it removes.

## Pins

`tests/unit/mttTickerAnchor.test.ts` gains three:

- **never follows a bare `<header>`** — the selector list is exactly
  `['#global-header']`.
- **ignores top chrome that is not actually at the top** — at the threshold it
  counts, one pixel past it does not.
- **the ticker gets in-flow clearance even with no action bar open** — the base
  rule reserves it, and the pinned rule must NOT name `--mtt-ticker-h` itself,
  so the band can never be counted twice.

The existing zero-height case was retargeted: with no bare-`header` fallback
there is no second candidate, so a header measuring 0 mid-mount yields 0.

## Verification

- Client suite: **9709 passed / 9709** (670 files).
- Server suite: **2749 passed / 2749** (244 files).
- `tsc --noEmit` clean; eslint clean on every file touched.
