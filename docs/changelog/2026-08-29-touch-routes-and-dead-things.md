# Data a finger could not reach, and four things that were already dead

**Date:** 2026-08-29

## Touch routes

The estate-wide hover removal earlier today deliberately KEPT the
`onMouseEnter` handlers that deliver **data** rather than paint — chart and
heatmap readouts, the training range viewer, the two Tooltip components — on
the grounds that they are information, not decoration. That was the right call
and it left the real problem standing: they were still reachable only with a
pointer.

Club Arena is mobile-first. A phone has no `mouseenter`. So on the device most
of this product is used from, every one of these delivered its content to
nobody:

| Surface                       | What was unreachable                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/common/Tooltip`   | had `onFocus`/`onBlur` — on a bare `<span>` with **no `tabIndex`**, so nothing ever focused it and the pair had never once fired on its own                          |
| `components/tooltips/Tooltip` | mouse handlers only, on a plain `<div>`                                                                                                                              |
| `ActivityHeatmap`             | the count and the date lived in a `mouseenter` handler; the grid was a wall of coloured squares with no way to learn what any meant                                  |
| `RangeViewer`                 | **the frequency is the entire point of the tool** and it rendered only while `hoveredHand === hand`. A training grid showing 169 coloured squares and not one number |
| `PositionalRadar`             | axis focus, and the table row that highlights its matching axis                                                                                                      |
| `PositionWinRates`            | the per-position readout, on an SVG `<circle>`                                                                                                                       |

Each now answers to tap and to keyboard as well as to a pointer, and is
genuinely focusable so the focus handlers mean something. Both tooltips gained
Escape and (for `common/Tooltip`) tap-outside dismissal — a pointer user moves
away, a finger cannot, so an open-only toggle traps the tooltip on screen.

`HoleCardHeatmap` already had a click route, with a comment saying why. It is
pinned now so it cannot lose it.

The combobox highlight-sync handlers (`Search`, `FindPlayerModal`,
`AdminCommandPalette`) are untouched: on touch you tap the row you want, which
is the same outcome.

## Four dead things

**`public/images/satellite-seat-icon.png`** — 22,434 bytes byte-identical to
`satellite-winner-v3.png`, kept for one day so a browser still running the
previous JS chunk would not draw a broken image. No importer in `src/`, no
reference anywhere in the bundle currently serving from the World Hub, and a
build a day old is not still in flight. Deleted.

**`profiles.streak_days`** — measured against production: **0 non-zero values
across all 1,023 profiles**, and nothing in the estate has ever written it.
`login_streak` is the live one. `SettingsPage` still SELECTed `streak_days`
into a data export and never read the value, which is harmless in itself and is
exactly how a dead column stays alive: the next person greps, finds a reader,
and assumes it means something — which is not hypothetical here, because
`BonusPage` once read it and rendered a hardcoded `day * 10` chips ladder that
disagreed with both `BonusService` and the claim RPC.

Removed from the export. Not dropped: a DROP on a live table four surfaces read
from is a Tier 3 change needing a rollback plan, and it buys nothing when the
column is already all zeroes. What caused the harm was **ambiguity**, so the
migration puts the fact in a `COMMENT` on all four of the streak-ish columns,
where a schema reader looks:

```
login_streak     LIVE  — maintained by onLogin, day-guarded on last_login_date
streak_days      DEAD  — do not wire anything to it
last_login       LIVE  — full timestamptz, for dormancy display
last_login_date  LIVE  — the UTC day; the guard that makes login_streak safe
```

Applied to production and verified.

**`.lock-overlay` in `VIPBenefitsGrid`** — `opacity: 0`, raised to 1 only by
`.benefit-card.locked:hover`. So the lock icon that says WHY a benefit is greyed
out had never appeared on a phone, and after the hover removal could never
appear anywhere: a node React renders on every locked card, painted, and
permanently invisible. Now visible at rest, with the background lightened from
`0.3 + blur(2px)` to `0.12` — that treatment was designed to appear only over a
card the reader had deliberately pointed at, and permanently applied on top of
the card's own 0.5 opacity it buried the benefit text. The lock is the message,
not the dimming.

**`Carousel.css`'s `will-change: transform`** was on the open-items list as "an
element nothing transforms — a permanent compositor layer for nothing".
**Checked, and the note was wrong**: `.sp-carousel__item` has its transform and
opacity written inline every frame by the component's rAF loop, which is the
textbook case for `will-change`, and the rule is already dropped to `auto` under
`prefers-reduced-motion`. Left exactly as it is.

## Fix-first: a red `main` that was not mine

`server/src/services/GuaranteeBankNotify.test.ts:44` bounded a source pin with
`svc.slice(restartAt, restartAt + 1500)`, which turns
`tests/unit/noFixedSizeSourceWindows` red — the gate that exists because a
byte-counted window drifts off the code it guards. It landed on `main` earlier
today and, per CLAUDE.md section 4, fixing it comes before my own work; nothing
ships past a red suite anyway.

Rebound to `sliceEnclosingBlock`. That is also the stronger assertion: the
notification has to be in the same failure branch as the log line for the pin to
mean anything, and now that is what it says rather than "somewhere in the next
1,500 characters".

## Tests

`tests/unit/touchCanReachHoverOnlyData.test.ts`, 18 cases. It pins the
**route** — that a non-pointer user can reach the content — rather than the
implementation, so a better mechanism can replace a handler by moving the pin.
It also asserts the trap that made `common/Tooltip` fail silently: a file with
`onFocus` must have something that can actually take focus.

One case in it was wrong on the first run and worth recording: the lock-overlay
check matched the `opacity: 0` quoted in the comment explaining the fix. A test
that reads a comment is testing prose. It strips comments now.

Full suite: 571 files / 8,787 passing, plus the server suite green.
`npx tsc --noEmit` exit 0.

## Not done

`src/components/metal-ui/MetalIconBox.tsx` has **zero usages** anywhere in
`src/`. The whole component is dead, not merely its `glowEffect` child. Deleting
a design-system component is a call for whoever owns `metal-ui`, so it is
reported rather than removed.
