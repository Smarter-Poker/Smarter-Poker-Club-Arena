# 2026-09-06 - Phase 7 deep dive: a control is not a description

Phase 7 (squash `71feeebd3c`) shipped and was verified live: the entry chunk
carried every rank word, the replayer's chunk carried the tablist, the felt
carried `4 / 6.4`. All of that was true, and three defects were live underneath
it. Two of them were introduced BY the phase, and both are the same mistake
the phase exists to correct, made while correcting it.

## 1. The phase silenced a control (introduced by Phase 7, live)

To stop the board being announced twice - once as the region's sentence, then
again card by card - Phase 7 put `aria-hidden="true"` on
`.community-cards__container`.

One of the cards in that container becomes the **Squeeze To Reveal button**.
When an all-in river is held for the player entitled to it, that card takes
`role="button"`, `tabIndex={0}` and its own label, and a keyboard user opens
it with Enter or Space - there is a passing test for exactly that.

`aria-hidden` is **inherited by the whole subtree**. Hiding the container took
a focusable, keyboard-operable control out of the accessibility tree and left
it in the **tab order**: focus landed on it and nothing was announced. The ARIA
spec is explicit that `aria-hidden` must never contain focusable content, and
the reason is this exact outcome.

So the phase written to stop cards being read as "A Of spades" shipped a
control read as nothing at all.

**The hiding is per card now.** An ordinary board card is a description and is
hidden; the card that is a control is never hidden. Its children need no
hiding of their own - `role="button"` already makes descendants presentational,
so the reader says "Squeeze To Reveal, button" and not the card's name after
it. The rabbit-hunt card is named by the region's own clause and stays hidden.

**The law was green while this was broken**, and that is the more useful half
of the finding. Its pin read the SOURCE for
`community-cards__container" aria-hidden="true"` - it was watching the
mechanism, so it could not see that the mechanism had swallowed a control. The
property is now pinned where it can be observed at all: against the rendered
DOM in `tests/components/RiverSqueeze.test.tsx`, by walking UP from the control
through every ancestor. The law keeps only the negative - that shape must not
come back.

## 2. The phase fixed every card face and missed the one that is a choice

`PineappleDiscard` labels each discard button:

```
aria-label={`Discard ${card.rank}${card.suit}`}     // "Discard As"
```

A button's `aria-label` **replaces its content** as the accessible name, so the
corrected alt on the `CardImage` inside it is never read here. In Crazy
Pineapple the player is choosing which card to throw away, against a timer
whose own hint says "Miss The Timer And Your Hand Is Folded" - and the only
card in the app still read as its sprite's field values was that one.

"One renderer, one helper" was true and was not enough: a label is written by
hand anywhere somebody needs one. So the pin is the CLASS, not the instance -
the law now sweeps every `.tsx` under `src/` for a spoken label
(`aria-label`/`alt`/`title`) built out of a raw `rank`/`suit`, and names the
file and the line. Reverting the fix turns it red, which is the only evidence
that a pin pins anything.

## 3. The same trap, one level up, left in the other dialog

Phase 7 gave both dialogs a real Tab trap. `HandDetailModal` reads its
`onClose` through a ref and keys its focus effect on `[isOpen]` alone, with a
comment saying why. `HandHistoryPanel` was left on `[isOpen, onClose]`.

That effect's cleanup calls `restoreFocusTo.current.focus()`. Anything that
makes it re-run therefore **pulls focus back to whatever opened the panel while
the panel is still open** - behind a live table, on every websocket tick.

It has not been biting, because `TablePage` happens to wrap
`handleCloseHandHistory` in `useCallback([])` - for an unrelated
stuck-announcement bug fixed on 2026-08-27. A dependency on a caller's
memoisation is not a fix, it is a coincidence, and nothing at the panel
enforces it or tells the next caller. The panel reads its handler through a ref
now, like the modal, and both are pinned together so the pair cannot be
half-fixed again.

## Checked and found correct

- `cardWords` agrees with what `CardImage` will actually render: it uppercases
  the rank and lowercases the suit, so every spelling `RANK_MAP`/`SUIT_MAP`
  accept (`t`, `10`, `hearts`) resolves, and a card those maps REFUSE never
  reaches the helper - it takes the explicit "Card Could Not Be Read" tile
  instead. Refuse rather than invent, still held.
- Both Tab traps handle a dialog with no focusable content, and recover focus
  that has fallen to `<body>`.
- The archive's stagger clears its timers on both paths.
- The deep link cannot collide with the deferral: `?hand=<id>` EXPANDS its
  target, and an expanded card never defers.
- `4 / 6.4` and the hero seat's `margin-top: 36px` are genuinely inside the
  480px block - brace-matched, not eyeballed. The keyboard test's window was
  `slice(indexOf(...))`, which runs to end of file and would have passed with
  the rules sitting outside the block; it is brace-matched now, for the same
  reason as finding 1.
- The other `${c.rank}${c.suit}` sites are the plain-text hand summary a player
  COPIES. Raw poker notation is correct there - that is the tracker format, not
  speech.
