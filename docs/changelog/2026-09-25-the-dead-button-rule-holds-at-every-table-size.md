# 2026-09-25 -- the dead button rule holds at every table size

Branch `agent/claude-mtt-0925/fix/the-dead-button-rule-holds-at-every-table-size`.
Server engine only; no migration, no client change.

## What was wrong

`ServerTableEngineDealing.ts` applied "the blinds advance and the button
follows" (TDA Rule 30, the dead button; `headsUpButton.ts`, Phase 2.2 of
2026-08-31) only when a table had dropped to TWO players. At three or more the
button still walked to the next occupied seat: the moving-button convention,
which is the published CASH rule here and is not how a tournament is played.

Traced through `dealHand` on `origin/main` with seats 1..6, button 2, small
blind 3, big blind 4:

| between hands                     | next hand on main        | rule                          |
| --------------------------------- | ------------------------ | ----------------------------- |
| seat 3 (small blind) busts        | button 4, small 5, big 6 | button 3 dead, small 4, big 5 |
| seat 4 (big blind) busts          | button 3, small 5, big 6 | button 3, small DEAD, big 5   |
| seat 2 (button) busts             | button 3, small 4, big 5 | same                          |
| a player moved in to empty seat 3 | button 3, small 4, big 5 | button 4, small 5, big 6      |

(The last row starts from button 2, small 4, big 5 with seat 3 empty.)

So seat 4 posted the big blind and then held the button without a small blind
in between; seat 5 went from UTG straight to the big blind (first row) or from
the small blind to the button without ever posting a big blind (second row);
and a balanced-in player took the button while seats 4 and 5 posted the small
and the big blind twice in a row (fourth row).

Measured in production (read-only, `hand_history`, tournament hands with three
or more dealt on both sides of the pair, last five hours before this change):

    consecutive-hand pairs ................ 5,617
    pairs where the roster changed ........   249
    big blind NOT the next live seat ......    92   (37% of roster changes, 0% otherwise)
    small blind posted by somebody else
      after the previous big blind's seat
      had emptied (should be dead) ........    43
    same seat posted the big blind twice ..    13

## What changed

- `server/src/engine/deadButton.ts` (new, pure): `deadButtonPositions(seats,
{smallBlind, bigBlind})`. The big blind advances to the next occupied seat
  after the seat that posted it; the small blind is the seat that posted the
  big blind last hand, DEAD (null) if it has emptied; the button is the last
  seat before the small blind that is occupied now or held the small blind
  last hand, so it can sit on an emptied seat (dead button) and never sits
  behind a live player. Stands down (null) at fewer than three seats or with
  no previous blinds to advance from.
- `ServerTableEngineBase.ts`: `lastSmallBlindSeat` beside `lastBigBlindSeat`;
  `tournamentDeadButtonSeats(roster)` is the ONE definition (tournament
  tables only, three or more); `predictButtonSeat` reads it first and the new
  `predictBlindSeats` names button, small blind seat (occupied or not), small
  blind poster and big blind, so `getSBSeatIndex`, `getBBSeatIndex`,
  `getButtonSeatIndex`, the wait-for-BB gate, the cash hold-outs and the
  tournament arrival rule (B2, `noteTournamentArrival`) all agree with the
  deal. `restoreButtonFromHistory` now reads the blind POSTS (`actions`,
  `origin: 'forced'`) of the last two settled hands so both anchors come
  back exact across a restart, a dead small blind included.
- `ServerTableEngineDealing.ts`: after the heads-up block the tournament rule
  decides the button and both blind seats; `sbSeat` can be null (dead);
  `lastSmallBlindSeat` is recorded on exactly the hands `lastBigBlindSeat`
  is; the straddle order excludes one blind seat when the small blind is
  dead; a tournament hand is handed `config.blindSeats`.
- `HandController.ts`: `blindSeatsForHand()` reads `config.blindSeats` when
  present (dead small blind: no seat posts it; button may be an empty seat),
  otherwise the old walk from the button. Used by `postBlinds` and the
  preflop first-to-act branch, which were two copies of that walk. A dead
  small blind adds nothing to the pot-limit blind adjustment (TDA 54 is about
  a SHORT blind, not an absent one).
- `types.ts`: `HandConfig.blindSeats?: { smallBlind: number | null; bigBlind }`.

The heads-up special case is untouched (button posts the small blind,
`headsUpButtonSeat`), and the return from heads-up to three or more is covered
by the same rule. The arrival rule keeps its definition: an arrival in the
coming hand's button seat or small blind seat owes a live big blind to enter.
Under this rule the button seat and the small blind seat are the rule's own,
so an arrival in a dead button seat holds the button and posts to enter, and
an arrival in a dead small blind seat posts the small blind and the big blind
next hand from the button.

## Cash tables are unchanged

`tournamentDeadButtonSeats` returns null for a cash table, `config.blindSeats`
is never set for one, and the cash rows of the new test pin the moving-button
sequence (button 2/3/4, seat 3 leaves, button 4/5/6) and the predictors that
the entry hold-outs read. GameRulesModal publishes exactly that convention for
cash ("The Button Moves Clockwise Among Eligible Players, Skipping Empty
Seats"); it stays as published.

## Verification

- `server/src/engine/DeadButtonEveryTableSize.test.ts` (new, beside
  `HeadsUpButtonFairness.test.ts`): table-driven over eleven scenarios, each
  asserting the (button, small blind, big blind) sequence over several hands,
  first through the pure rule and then through the REAL deal
  (`ServerTableEngine.dealHand` to the controller, then
  `HandController.start()`, the posting seats read off `FORCED_BETS_POSTED`):
  normal orbit, small blind busts, big blind busts, button busts, two adjacent
  busts, arrival behind the button, arrival into the dead button seat (posts
  to enter), arrival into the dead small blind seat, three-handed to heads-up
  and back, heads-up to three-handed with the arrival between the button and
  the big blind, nine-handed with gaps; plus predictor agreement, pot-limit
  with a dead small blind, cash unchanged, and wiring pins.
- Fail before / pass after: with the engine sources stashed and the new file
  in place, 13 of 34 fail on `origin/main` (`expected [4, 5, 6] to deeply equal
[3, 4, 5]`, `expected [3, 5, 6] to deeply equal [3, null, 5]`, ...); with the
  change, 34 of 34 pass.
- Updated in the same commit, because they pinned the shape being replaced:
  `HeadsUpButtonFairness.test.ts` and `RestartFidelity.test.ts` (the restore
  query now selects `actions` and reads two rows), `EntryPostingAndButton.test.ts`
  (the shared predictor is `predictBlindSeats` or `predictButtonSeat`).
- `npx tsc --noEmit -p server` clean. Blind, dealing and HandController test
  files (29 files, 452 tests) pass; the whole `server/src/engine` directory
  was run as well, see the report.

## Not in scope

- `TableBalancer.currentBigBlindSeat` still derives the current big blind
  from the previous hand's `button_seat` over the seats occupied now. It is
  a move-order heuristic, exact whenever the button was live, and one seat
  off only in the window after two adjacent busts. It never posts a blind.
- `HorsePlayStats` reconstructs blind posts from `button_seat` for a stat
  page; a dead-small-blind hand credits the small blind to the wrong seat
  there until it reads the `sb`/`bb` posts the way `ca_stats_witness_audit`
  already does.
- `ca_stats_witness_audit` derives the button as the dealt seat before the
  small-blind poster, so a dead-button hand (button on an emptied seat) will
  count as a button disagreement in that net. That is the net saying the
  button sat on an empty seat, which is now correct behaviour; the derivation
  belongs in a follow-up migration and this change makes no schema change.
- `gtoV31Position` (horse solver labels) already returns null when the button
  is not a dealt seat, so on the one hand with a dead button a horse decides
  without its solver seat label, as that function was written to do.
- Bomb pots on tournament tables (none exist; the MTT roster contract refuses
  `bomb_pot_enabled`) would not advance the anchors on a bomb hand.
- Cash tables keep the moving button on purpose (see above).
