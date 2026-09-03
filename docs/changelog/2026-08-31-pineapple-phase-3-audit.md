# Phase 3 audit - three silent gaps, and two gates that stopped at the door

**2026-08-31**, after #2208 merged and deployed. Dan asked for a full check of
Phase 3 before Phase 4 begins. Five real defects, three of them mine.

## 1. The discard was never recorded on the hand

`HandController.performDiscard` emitted `PLAYER_ACTION` but never wrote to
`state.actionHistory` - only `processAction` does that, and a discard does not
go through it. `getTableState()` publishes that array as `action_history`, and
`mapEngineSnapshot.derivePerSeatLastAction` builds every seat's on-felt action
label from it.

So the very next snapshot of the discard round told the client that nobody had
acted. Two consequences, both live in production since Phase 3 shipped:

- the seat's "Discard" label appeared on the event and was wiped a moment later;
- `lastAction` fell and rose again, and a fall-then-rise re-triggers the toss.
  A seat could throw the same card twice.

Fixed at the source. The record carries the same shape and the same stage as
any other action, so it lives exactly as long as the round it belongs to. Every
consumer filters on stage and on bet/raise/all_in (`isFixedLimitCapped`,
`canReopenBetting`, `readInitiative`, `isBettingRoundComplete`), so a
zero-amount discard on a stage none of them bet in is inert to all of them. It
also makes the in-memory history agree with the persisted one, which is what
HorseMind hydrates from.

Belt to those braces: `SeatSlot` now refuses to start a second flight while one
is in the air. A seat discards exactly once per hand, so a second toss is never
correct however `lastAction` gets there.

## 2. An all-in seat's discard was silent on every layer

`resolvePendingPineappleDiscards` spliced the card and emitted `CARDS_DEALT`
only. No `PLAYER_ACTION` meant no toss, no cue, three backs left on the felt for
the rest of the hand, and the discard missing from `hand_history.actions` - so
it would have been missing from the Phase 4 replay too. That is the exact Phase
3 bug, still alive on the one path the player cannot see coming. Announced now,
identically, before the cards go out.

## 3. The tab strip would have flashed a lowercase "discard"

`TableTabBar` renders `ACTION_LABEL[flash] ?? flash` - the raw engine token when
an entry is missing. `'discard'` was unreachable there until Phase 3 made the
client aware of it. The moment fix 1 above made it durable, the multi-table tab
would have flashed lowercase copy, against CLAUDE.md 5.7.

## 4. Two CI gates stopped at src/

`check-ui-text` and `check-title-case` walked `src/` and nothing else, so the
APP SHELL was never scanned. `index.html` carries the page title, the meta
description, the Open Graph and Twitter cards, and the boot-failure screen.
It was holding:

- three em dashes in copy that every search result and every shared link renders;
- `Loading failed` and `Please clear your browser cache and reload.` - sentence
  case, on the one page guaranteed to be read by somebody already having a bad
  time.

Both gates now cover `index.html` and `public/`. `check-ui-text` learned to
strip HTML comments and inline `<script>` comments; `check-title-case` gets a
narrow HTML pass over heading, paragraph, button and title text. Both were
proven to bite by reintroducing a violation and watching them fail.

## 5. State that outlived its hand

`discardedSeats` and `heroDiscardFlight` were cleared on `HAND_STARTED` alone.
That is a single WS event, and a dropped one meant a seat played the NEXT hand
visibly one card short, or hero's ghost flew carrying the previous hand's card.
Both are stamped with the hand they belong to now and read back only for it.
A stamp cannot be dropped.

## Also

The avatar gesture map still has no `discard` entry, deliberately, and now says
why: the rigged library is push / check / fold / celebrate / lose / alert, and
none of them means "throws one card away and keeps playing". `fold` is the
tempting one and the worst - it is the slump that tells the table a hand has
died, played over a player still in the pot, which is precisely the confusion
Dan reported.

Four new pins (53 -> 57 in `tests/animations-always-play.law.test.ts`).
