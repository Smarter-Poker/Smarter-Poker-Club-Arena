# The query was fixed and the mapping was not

Date: 2026-08-23
Author: cowork-embedaudit
Scope: the three components PR #329 repaired — HandReplayViewer,
BlockedPlayersList, TableService.getSeatedPlayers / TableOperationsPanel.

## 1. The headline

PR #329 made three broken selects return rows. For two of the three that was
the whole fix. For `HandReplayViewer` it was not: **every field of every row
was then read under a name the row does not use**, so the repaired query fed a
component that still rendered nothing usable.

And the reason nobody noticed is worse than the bug: **HandReplayViewer is not
reachable from the UI.** `TournamentPage.tsx` imported it and never rendered
it. PR #329 — my own earlier work — fixed a query in dead code.

## 2. The stored shape versus what the component read

Verified against production (`kuklfnapbkmacvwxktbh`) on 2026-08-23 over 11.8M
action rows:

    actions[]  { action, amount, seat, stage, timestamp, userId }
    players[]  { cards, seat, stack, userId, username }
    winners[]  { amount, hand: { name, ranking }, potIndex, userId }

| Component read                                     | Row actually has                         | Consequence                                                     |
| -------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| `action.playerName`                                | nothing — only `userId`/`seat`           | every action rendered a blank name                              |
| `action.street`                                    | `stage`                                  | **no branch ever matched, so the board never revealed a card**  |
| `'all-in'`                                         | `'all_in'`                               | 236,898 all-ins printed as the raw token, unstyled              |
| —                                                  | `'discard'`                              | 74,631 draw/pineapple actions had no case at all                |
| —                                                  | `rit_board_2:<cards>`                    | run-it-twice boards rendered as a raw string in the action list |
| `player.id` / `.name` / `.position` / `.holeCards` | `userId` / `username` / `seat` / `cards` | player list unusable                                            |
| `winner.playerId`                                  | `userId`                                 | see below                                                       |
| `"Kh"`                                             | `"Khearts"`                              | `parseCard` produced `{ rank: 'Kheart', suit: 's' }`            |

The winners bug deserves naming. The lookup was
`hand.players.find(p => p.id === w.playerId)`. Neither `p.id` nor `w.playerId`
exists, so it compared `undefined === undefined`, matched the **first** entry,
and named that player the winner of every hand. Not "Unknown" — confidently
wrong.

Cards had a further insult: `src/utils/deckCards.ts` already exists for exactly
this, and its header says "Every past attempt to bridge that gap did it inline
and got it wrong in a different way, so it lives here once." The replay was a
live instance of the mistake that file was written to end.

## 3. What was changed

- **`src/utils/handHistoryShape.ts` (new).** The stored shape and one pure
  `normaliseStoredHand()`, so the mapping is testable instead of buried in a
  component. Resolves action names through `userId`, falling back to `seat`.
  Lifts `rit_board_2:` entries out of the action stream into a second board.
  Degrades on malformed rows rather than throwing — a replay is a record of
  something that already happened.
- **`HandReplayViewer.tsx`.** Uses the normaliser and `toDeckCards`. Adds the
  `all_in` and `discard` cases. Reveals the board by `stage`, with
  `pineapple_discard` treated as pre-board. Renders the run-it-twice second
  board. Distinguishes a **failed load** from **hand not found** (see §4).
  Cancels its stagger timers — autoplay at 3X queued one `setTimeout` per
  action per step and cancelled none of them. Resets the stagger on `reset()`.
  Removes the emoji from the banner comment (CLAUDE.md §5.3).
- **Pot display.** Measured over 40 hands: the sum of action amounts does not
  reconcile to `pot_size` in either direction — blinds and antes are not in the
  action stream and rake is already out of `pot_size`. The running figure is
  now labelled "Pot So Far" and the authoritative `pot_size` is shown once the
  hand has run out, instead of presenting an approximation as the pot.
- **`TournamentPage.tsx`.** Dead import removed.

## 4. The same disease, in all three components

`BlockedPlayersList` and `getSeatedPlayers` both answered a **failed query with
an empty success state**: "No Blocked Players" under a tick, and "No Players
Seated". For a moderation surface that is the worst available lie — it tells a
user they have unblocked everyone. All three now separate "we asked and the
answer is none" from "we could not ask", and offer a retry.

`getSeatedPlayers` now throws instead of returning `[]`; its one caller decides
what an unanswerable question looks like.

Two further correctness bugs in `BlockedPlayersList`, both in the optimistic
unblock:

- `onUnblock?.()` fired immediately and was **never rolled back**. A failed
  delete left the parent believing the block was gone while the row was still
  in the database. The success toast had the same problem, so a failure showed
  the user both "Unblocked X" and "Failed To Unblock Player". Both now fire
  only after the delete lands.
- The rollback restored a **snapshot of the whole array**. Unblocking A then B
  and having B fail brought A back from the dead. It now re-inserts the single
  row at its original index.

Also: `new Date(null)` rendered "Blocked 1/1/1970" for a row with no
`created_at`; the list is now capped and the avatar initial no longer indexes
position 0 of a possibly-empty string.

## 5. The test, and why the first version of it was worthless

`tests/hand-history-shape.test.ts` pins the field names with real production
rows. **The first version passed while the mapper was sabotaged to read
`street`.** The fixture's stage was `preflop`, which is also the fallback, so
the assertion produced the right answer for the wrong reason and could not
fail.

It is now asserted on a **river** action, where the fallback and the truth
differ, plus an end-to-end assertion that a river action reveals five cards.
Re-sabotaged: 2 tests fail, naming the moved key. 18 pass on the real mapper;
3,150 tests across 249 files pass with no regression.

Sabotage-test every new guard before trusting it. This is the second time in
two sessions that a gate of mine reported clean against a bug I had just
planted.

## 6. Still open — a deliberate decision is needed

**Six hand-history/replay components exist. Two are reachable.**

| Component                   | Rendered by        |
| --------------------------- | ------------------ |
| `table/HandHistoryPanel`    | `TableModalsLayer` |
| `table/HandDetailModal`     | `TablePage`        |
| `gameplay/HandReplayViewer` | **nothing**        |
| `table/HandReplayPlayer`    | **nothing**        |
| `history/HandHistoryViewer` | **nothing**        |
| `club/HandHistoryModal`     | **nothing**        |

The two live ones are fed by in-session engine records, not by `hand_history`,
so they cannot replay a hand from an earlier session. `HandReplayViewer` is now
the only correct DB-backed replay in the codebase — and it is unwired.

That is a product call, not a cleanup: either give it a surface (a "Replay"
affordance on a stored hand is the obvious one) or retire the four orphans
deliberately. It was not decided here, because guessing at a new UI surface is
how a seventh replay component gets written.
