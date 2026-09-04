# 2026-09-04 - Previous Hand shows this table's hands

Branch: `fix/previous-hand-shows-this-tables-hands`. Dan: "THE PREVIOUS HAND
FUNCTIONALITY IS COMPLETELY BROKEN, UN ORGANIZED, DOESN'T DISPLAY THE CORRECT
DATA, DOESN'T DISPLAY THE CORRECT HANDS. NEEDS A FULL AUDIT, ENHANCEMENT AND
UPGRADE."

## The audit

Three openers (the Previous Hand card, the table menu, the tab-bar menu) feed
two surfaces (`HandHistoryPanel`, `HandDetailModal`) from one array,
`TablePage.handHistory`, loaded by `handHistoryService.getPlayerHands(userId,
50)`. The Detail tab of the modal does a SECOND read of the same row through
`useHandReplayModel` with a different column list. Sixteen defects, ranked;
the first three are the whole of "wrong hands":

1. **No `table_id`.** The live table listed the player's last 50 hands from
   every table they had ever sat at - other stakes, other clubs, tournaments.
2. **Ordered by `created_at`** - the row's INSERT time. The writer's retry
   queue drains failed inserts minutes later, so during any database blip
   hands landed out of order permanently. `hand_number` is globally monotonic
   and was selected and ignored.
3. **The localStorage cache** was keyed per table and filled with the
   cross-table list, so a table hydrated with another table's hands as its own.
4. **"Showdown" on hands with no showdown.** The panel admitted any winner;
   the Detail tab emitted a row for every player on every board, so a six-way
   fold-around listed six seats of card backs under "Showdown".
5. **Multi-board rows drew board 2's five cards under board 1's hand name**, and
   a one-board winner was flagged winner on every board.
6. **Per-run winners unlabelled.** The row could not say who won run 2 until
   today's `winners_by_board` column (RIT branch); nothing read it.
7. **Double/triple-board bomb pots** rendered as one board (panel) or two (Detail).
8. **`return` (an uncalled bet handed back) was ADDED to the pot**, and
   `sb`/`bb`/`ante`/`straddle`/`post` printed as raw database tokens.
9. The hero cannot see their own cards on a hand they folded or won
   uncontested (only showdown holdings are stored in `hole_cards`;
   `ca_hand_facts.hole_cards` has them for every hand and nothing reads it).
10. Hi-lo is invisible: no low evaluator, the low half is labelled with a high hand.
11. Two reconstructions inside one modal (Summary tab vs Detail tab) from two queries.
12. "Session stats" summed the cross-table list.
13. No rake on the panel: a pre-rake pot beside a post-rake Collected, unlabelled.
14. The writer could file a hand under an empty or incomplete `players` roster -
    and `players` is the RLS key, so such a hand is invisible to its own participants.
15. A dead REPLAY wire in the panel (prop declared, never destructured).
16. An orphan fourth normaliser (`handHistoryShape.ts`) with tests and no importer.

## Fixed here (1-8, 13, 14)

- `getPlayerHands(userId, limit, { tableId })` filters by table and orders by
  `hand_number desc`; both live openers pass the table. The standalone Hand
  History page stays cross-table by passing nothing. `played_at` is
  `started_at`.
- Cache key is `hand_history_v2_<table>`; every v1 key is dropped on mount.
- A showdown is a card turning over. Panel: rows are players who showed or
  who reached showdown and mucked ("Mucked", not "Not Shown"); a hand with no
  showdown gets one line - "No Showdown · Pot Taken By X". Detail:
  `buildReplay` emits showdown rows only for those players.
- Who won each board, on every surface, from `winners_by_board`: the panel
  and the Summary tab label each RUN/BOARD with its winner, hand and share;
  the Detail tab names each board's hand from the board's own record (then a
  local evaluation against THAT board, and the hand-level name only for
  board 1), and flags a winner only on the board they won. The "covers every
  run" note survives only for rows older than the column.
- Bomb-pot boards 2 and 3 reach both surfaces, labelled BOARD n.
- `return` leaves the pot in every pot walk; the forced posts read as words.
- Rake beside the pot on the panel.
- Writer: the roster is the union of the dealing array, everyone dealt cards
  and everyone paid, with a loud log when they disagree.

## Next phase (9-12, 15, 16) - recorded, not done

The hero's own cards on non-showdown hands (`ca_hand_facts`), a low
evaluator for plo8/flo8, collapsing the modal's two reconstructions into
`buildReplay` alone, session stats scoped to the table, the dead REPLAY
wire, and the orphan normaliser. Each is a self-contained change; none
affects what is shown for which hand, which is what this branch was for.

## Law

`tests/previous-hand-shows-this-tables-hands.law.test.ts` (registered in
`docs/laws.d/`). The `buildReplay` pins are behavioural, as the utils ratchet
requires. The 2026-08-25 `handReplay.test.ts` pin that folders appear as
showdown rows with `hole: null` is replaced, deliberately, by the opposite.
