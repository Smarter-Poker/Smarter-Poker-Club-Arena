# Every page scrolled 48px for nothing

**Date:** 2026-08-29

Found while re-measuring the tournament page at 375×812 after the day's merges.

## The arithmetic

When the pinned table bar is up, `body[data-ca-pinned-bar='1']` takes
`48px + env(safe-area-inset-top)` of `padding-top` so the bar covers nothing —
correct, and well documented in `MultiTablePage.css`.

`#root` then asked for `min-height: 100dvh`. A **whole** viewport, inside a body
that had already spent 48px of it.

```
body padding-top   48px
#root             812px   (100dvh)
                 ------
body              860px   on an 812px viewport
```

So every page in Club Arena scrolled 48px it did not have to. On the tournament
page that is 48px taken off a content column already tight enough that the
entries list sits near its floor — the same 48px I had just spent an entire
commit recovering from the stat grid.

## The fix was already designed, just not implemented

`MultiTablePage.css` says, in the comment directly above the rule:

> Set as a variable on `<body>` by MultiTablePage so a single number drives both
> the offset and any page that wants to know.

It was a literal. Nothing could read it, so nothing did, and the shells went on
claiming a full viewport. Making it an actual custom property is the whole fix:

```css
body[data-ca-pinned-bar='1'] {
  --ca-pinned-bar-offset: calc(48px + env(safe-area-inset-top, 0px));
  padding-top: var(--ca-pinned-bar-offset);
}

#root {
  min-height: calc(100dvh - var(--ca-pinned-bar-offset, 0px));
}
.layout {
  min-height: calc(100dvh - var(--ca-pinned-bar-offset, 0px));
}
```

`#root` is declared in **both** `globals.css` and `club-engine.css`; whichever
loads last wins, so both were changed — otherwise the bug returns through the
other one. `.layout` is the flex child of `#root` and needed it too: left at a
bare `100dvh` it overflows a correctly shortened root by exactly the offset
again. That is what the first probe showed — `.layout` fell to 764px and the
page was still 860px, because `#root` had not moved.

The `0px` fallback is the safety: a page rendered without the bar is byte-for-
byte unchanged. The pre-`dvh` `100vh` fallback line is deliberately untouched —
a browser without `dvh` is not one to trust `env()` arithmetic on, and an
over-tall page beats a clipped one.

## Measured on the live page, before and after

Injecting exactly the rules above into production at 375×812 with the bar up:

|                           | before | after            |
| ------------------------- | ------ | ---------------- |
| body height               | 860px  | **812px**        |
| overflow past viewport    | 48px   | **0**            |
| page scrolls vertically   | yes    | **no**           |
| `#root`                   | 812px  | 764px            |
| entries list              | 150px  | 150px, unchanged |
| list propped by its floor | no     | **no**           |
| panel nested scrollbar    | none   | **none**         |
| page scrolls sideways     | no     | no               |

The entries list is deliberately in that table: this change shortens the shell,
and the thing most likely to break is the column that was already tightest. It
did not move.

## Tests

`tests/unit/pinnedBarOffsetIsSubtracted.test.ts`, 6 cases, verified red without
the fix (2 of 6 fail when either `#root` declaration reverts to a bare
`100dvh`). It pins all three rules, that both `#root` declarations agree, and
that every one carries the `0px` fallback — because the regression risk of this
fix is shortening pages that never had the padding.

Full suite **609 files / 9,154 passing**, `npx tsc --noEmit` exit 0.
