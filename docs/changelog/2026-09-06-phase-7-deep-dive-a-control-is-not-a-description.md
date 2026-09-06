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

## 4. The pre-push test gate never ran on a new branch, and that is why I shipped 2

The fix for finding 2 broke `tests/pineapple-discard.test.tsx`, which pins the
old label. I pushed anyway and CI went red. The interesting part is that the
push was green, and it should not have been: `vitest related` finds that test
from `PineappleDiscard.tsx` in four seconds.

The hook's new-branch arm read:

```sh
FILES=$(git diff --name-only "$LOCAL_SHA")     # working tree vs that commit
```

One ref, not two - so it compares the **working tree** against the commit being
pushed. At push time the tree is clean, so it returns **nothing**, which is the
exact opposite of the comment above it ("check all commits up to current").
Empty `FILES` gives empty `CHANGED_SRC` and `CHANGED_TESTS`, and the vitest gate
below them is skipped in silence. Measured on this branch: **0 files that way,
7 the right way** - and the diff it saw as empty contained the failing test.

Every other guard still ran and printed OK, so the push read as thoroughly
checked. That is 10.86 exactly: an answer it could not give, coerced into an
empty one, reported as good news. It is also 10.86 rule 3 - the guard rule 8
calls "the seatbelt" had no reader, because nothing said it had not run.

**And it is the path every agent now takes.** Section 10.82, binding since the
same day, requires a NEW BRANCH off main for every follow-up commit. So the rule
written to stop commits vanishing routes all of them through the one arm where
the test gate is blind - and the faster CI gets, the more follow-up branches
there are. On a DIRTY tree it was worse than empty: it listed precisely the
files you had _not_ committed.

The arm now gets the same ladder the remote-tip arm has had all along - resolve
the merge base, diff two refs, and fall back to the whole tree if there is no
common base. Never nothing. Pinned in `tests/the-guards-are-wired.law.test.ts`,
which goes red if the one-ref diff comes back.

## 5. The same button's VISIBLE text, found in the shipped bundle

After 1-4 merged and published, I read the live chunks rather than the source
and found this still in them:

```
Discard ${t[g].rank}${t[g].suit}
```

Fifty lines below the `aria-label` finding 2 had already fixed, in the same
component, the **confirm button** - the last thing anybody reads before the
card is gone - printed `Discard As`, `Discard Kh`, `Discard 2d`. Not an
attribute: visible text, on screen, for every player, sighted or not. Not Title
Cased either, so it was also a standing violation of CLAUDE.md 5.7 that the
painted-text checker cannot see through an interpolation.

**The pin I wrote for finding 2 was green, because I pinned the shape I had
just fixed rather than the property.** It matched `aria-label`/`alt`/`title`
only. The rule is now "a card named in raw field values **wherever a player
reads it**" - a raw rank immediately followed by a raw suit, in a template that
also contains prose.

The prose test is what keeps the law usable. `${c.rank}${c.suit}` on its own is
how this codebase KEYS a card - React keys, `indexOf` against the engine's card
order, the PokerStars export's own notation - and there are eight such lines
that are all correct. Flagging them would have put eight false positives in
front of the next agent, and a law that cries wolf is a law that gets deleted.
Stripping the interpolations and requiring a word is what separates
`Discard ${...}` from `${...}-${i}`.

Lesson, three times in one deep dive: **pin the property, not the mechanism you
happened to use.** Finding 1's law watched a container attribute, finding 2's
watched an attribute name, and both were green over a live defect.

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
