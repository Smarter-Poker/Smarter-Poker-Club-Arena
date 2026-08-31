# 2026-08-31 - Crazy Pineapple: the discard now removes the card you picked

Shipped in #2033 (`e2278b43`). Verified live: `TablePage-BPHjJ3nW-v6.js` on
`smarter.poker/hub/club-arena` carries the new hint string, and
`TablePage-DQBbSKHG-v6.css` serves the docked picker
(`position:fixed; bottom:...; pointer-events:none`, no scrim).

Dan, from a live seat: "THE DISCARD POP UP SHOULDN'T TAKE OVER THE ENTIRE
SCREEN ... IT CURRENTLY BLOCKS THE [W]HOLE FLOP SO YOU CAN'T SEE WHAT YOU
CONNECTED WITH OR NOT, AND IT DOESN'T REMOVE THE CARD FROM YOU HAND AFTER YOU
DISCARD IT."

## What was wrong

**The wrong card was discarded.** `submitDiscard(tableId, cardIndex)` indexes
into `player.cards`, the engine's delivery order. The picker was handed
`hero.holeCards`, which `cards_pre_sort` (Bible V8 11.1, on by default) has
re-sorted rank-high-to-low. Two arrays, one index. On Dan's A-7-6 every one of
the three positions resolved to a different card than the one he clicked.

**The felt never repainted.** `insert_hole_cards` is an upsert - `ON CONFLICT
(table_id, hand_number, user_id) DO UPDATE`. The deal is an INSERT; the engine's
re-push of the remaining two cards after `performDiscard` is an UPDATE on the
same key. `useMasterBusChannel` was subscribed with `event: 'INSERT'`, so the
client was never told. Every hole-card re-push - RESYNC, reconnect - was
invisible for the same reason.

**It covered the board.** `inset: 0`, a 72% black scrim and a blur, centred over
the felt. The discard in this variant is made WITH THE FLOP VISIBLE; that is the
variant. The single input the decision needs was the thing being hidden.

## What changed

- `heroEngineCardOrderRef` records the unsorted delivery order in
  `handleHoleCardPayload`, written before `sortCardsByRank` runs.
  `handlePineappleDiscard` translates the clicked card back into that order by
  identity, and falls back to the display index only when the record is missing.
- The hole-card subscription is `event: '*'`. The accepted discard also removes
  the card from local state immediately, which is what closes the picker
  (`heroPineappleCards` requires exactly three).
- `PineappleDiscard.css` is a bottom-docked panel: no scrim, no blur, no
  full-viewport box, `pointer-events: none` on the wrapper. It covers only the
  hero's own three cards, which it is showing larger. A `max-height: 480px`
  query shrinks it for landscape rather than letting it climb over the board.
- The hint said the table discards your last card on a timeout. False since
  2026-08-21 - `foldForMissedDiscard` folds you. It says so now.

Pinned by `tests/pineapple-discard-picks-the-right-card.test.ts` (8).

## Still open

Two reports from the same session are NOT fixed here and need a repro:

1. a pineapple table that "dealt me in with no other player playing";
2. a hand that announced an auto-fold but only made the cards vanish.

Both happened while the felt read **"Reconnecting To The Table"**.
`table_seats` and `table_hole_cards` hold no row for `kingfish` on any pineapple
table that day, and the three live pineapple tables ran 5-6 handed throughout,
so `minPlayersToDeal()` was not bypassed - this looks like the client painting a
confident, wrong roster under the reconnect pill, not the engine dealing short.

The obvious patch - a "never shrink the roster" rule in the snapshot merge,
mirroring the board's never-shrink guard - was deliberately NOT written: it
would strand a ghost seat every time somebody legitimately stands up. It needs
the socket state captured at the moment it happens.
