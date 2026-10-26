# A hand that called the river shows in Previous Hand

Dan, 2026-10-25, verbatim: "WHEN A PLAYER CALLS A BET ON THE RIVER AND HIS
HAND IS MUCKED, USERS SHOULD STILL BE ABLE TO SEE THE HAND 'THEY FOLDED'
INSIDE THE PREVIOUS HAND. BUT ONLY IF THE HAND WAS 'CALLED' ON THE RIVER, IF
THEY MUCK THE HAND SHOULDN'T BE SHOWN."

A player raised it first: his opponent checked the river out of position,
called his bet, lost, and Previous Hand only said "Mucked".

## Why the cards were missing

The engine auto-mucks a showdown hand that cannot win or tie anything
(`HandController.applyShowdownRevealRules`), and `hand_history.hole_cards`
stores only holdings the table saw (the 2026-08-17 leak rule). The caller's
cards existed only in `ca_hand_facts`, whose policy lets a player read their
own row and nobody else's.

## What changed

- `fn_ca_called_river_mucked_cards(uuid[])` (migration `20261026004819`):
  read-only, signed-in players only. Returns a holding only when the reader
  was dealt into the hand (the same predicate as `hand_history`'s own policy),
  the seat was ruled mucked at showdown, and the seat's last river decision
  was a call. Checked-down losers and river folds are never returned. No
  policy changes; the live table still shows MUCKED.
- `HandHistoryService` asks it for every page of hands that holds a muck and
  folds the cards into `hole_cards`, so Previous Hand, the detail view, the
  replayer and the hand-history page all draw them. The record keeps
  `mucked: true`; the copied hand text reads "X mucked Pair (called the
  river)".
- No engine change. Works on every hand back to when `ca_hand_facts` began
  (2026-08-21), horses included (section 10.5).

Measured on production over 30 minutes: 1,869 mucked showdown holdings, 677
river calls (all with cards on record, now shown), 1,189 checked down (still
hidden).

Pinned by `tests/a-called-river-hand-shows-in-previous-hand.law.test.ts`.
