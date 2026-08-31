# A contraction is not a word boundary

2026-08-31. Found while writing the painted-text casing gate, whose first
version copied this function and inherited the bug.

## What was wrong

`popupStyle.formatPopupText` applies Dan's house rule to every toast in the
product at render time. Its word-boundary class included the straight
apostrophe:

```ts
const WORD_START = /(^|[\s([{"'‘“-])([a-z])/g;
```

That is correct for `'a quoted phrase'` and wrong for every contraction in
English, so any popup carrying one rendered with a capital letter in the middle
of a word:

```
"You're already seated at seat 3"  ->  "You'Re Already Seated At Seat 3."
"we can't reach the table"         ->  "We Can't Reach The Table"  (was Can'T)
"it's your turn"                   ->  "It'S Your Turn"
```

The live one is `TablePage`'s seat-taken error, shown on the felt to a player
who clicks a seat they already occupy. It is the only call site today, and that
is the point: the bug is in the transform every toast passes through, so it
would have mangled the next contraction anybody wrote without them ever knowing
why.

## The fix

A quote opens a word only when it follows a boundary itself, so
`'quoted phrase'` still capitalises and `You're` is left alone. The straight
apostrophe leaves the boundary class; a second pass handles the opening-quote
case that class no longer covers.

Both behaviours are pinned in `tests/utils/popupStyle.test.tsx` — the quoted
phrase alongside four contractions, including the exact string `TablePage`
sends.

## Verified

`tsc` clean. Client unit **498 files** and non-unit **261 files**, all passing.
`check-title-case`, `check-nav-title-case`, `check-ui-text` and
`check-no-emoji` green.
