# 2026-09-04 - Second sweep: Run It Twice, Previous Hand, Leave Table

Dan: "YOU NEED TO DO A SECONDARY DEEPER SWEEP, AND CHECK EVERYTHING AGAIN, MAKE
SURE YOU TRULY FIXED ALL THE BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING
ISSUES ANYWHERE AND EVERYWHERE WITHIN THE RUN IT 2X / 3X FIXED ALL AREA'S AND
ANYTHING ELSE. AS WELL AS ... INSIDE THE PREVIOUS HANDS PAGES AND FUNCTIONALITY.
2, THE PREVIOUS HANDS PAGES NEED TO HAVE THE #SMARTERCASINOREALISM UI
IMPLEMENTED AS WELL. 3, WHEN YOU RIGHT CLICK ON THE ACTION BAR AND 'LEAVE
TABLE' THERE IS A LONG DELAY BEFORE YOU ACTUALLY LEAVE THE TABLE AND GO TO THE
GAME LOBBY, THAT NEEDS TO HAPPEN IN REAL TIME, NO 3 SECOND DELAY."

Branch `fix/rit-and-previous-hand-second-sweep`. Three commits, one per area.

## 1. Run It Twice / Three Times - the second pass

The first pass (#3014) fixed the reported hand. This pass audited every surface
the feature touches and found fourteen more, including one regression the first
pass introduced.

- **One reveal timeline.** The server's hold (`handCompletionSpec.ts`, identical
  copies in `src/config` and `server/src/config`) and the client's reveal now
  share `ritRevealTimelineMs()`; the hold equals `doneAt + push` for every
  runs x streets combination (`tests/unit/ritTimelineParity.test.ts`). The
  client clamps the animation-speed multiplier to `min(1, speed)` on the reveal
  so a slow setting cannot outlive the server's hold.
- **Scoop-banner regression (H3).** `ritExpected` had been made constant-true,
  which stalled the bomb-pot scoop banner. It reads `ritExpectedRunsRef >= 2`
  again, and both scoop timers are owned and cleared on `HAND_STARTED`.
- **`winners_by_board` was pre-rake on bomb pots and post-rake on RIT hands.**
  `HandController` rebuilds it from the penny-repaired, rake-scaled awards, so
  the column means one thing.
- **Per-board awards on the wire.** `rit_result` carries `per_board_awards` and
  `net_pot`; the felt labels each run with the engine's verdict (including
  " (Low)"), never a local re-evaluation, and shares are cents-rounded (floored
  only in tournaments).
- **Reconnect mid-reveal.** `getTableState` and the observer gate treat
  `runoutRevealActive` like `showdown`, so a refresh during the runs sees them.
- **Rebuy prompt hold.** The heartbeat carries `rebuyPromptOpen`; the seat sweep
  restarts the grace while the prompt is fresh (12s), so a player reading the
  rebuy sheet is not removed under it. `BuyInModal` / `CashierModal` take
  `accountBalance: number | null` and say "Unavailable" with a retry rather than
  printing 0.
- **Tab strip.** An expired decision is not a live clock; the urgency loop
  ignores `left <= 0` (no more "-0" alarm).

## 2. Previous Hand - one reconstruction, every surface

The audit found FOUR reconstructions of a hand (`buildReplay`, the modal's
Summary adapter, the modal's "degraded" walk, and the panel's own street list)
plus a fifth normaliser nothing imported, FIVE hand shapes, and two separate
SELECT lists that had drifted (`getHand` never selected `winners_by_board`,
`getPlayerHands` never `bomb_pot`). The degraded walk summed raise-TO levels as
chips added and over-counted every raised pot; the Summary adapter filed a
fold-around under "Showdown" and printed "Not Shown" for a muck.

### What there is now

- `HandHistoryService.mapHandHistoryRow` builds `replay: ReplayModel` ONCE from
  the raw row through the new shared mapper `replayInputFromRow` (also used by
  `useHandReplayModel` for the jackpot rundown), and attaches it to the record.
  One select list, `HAND_HISTORY_COLUMNS`, for every read.
- `HandHistoryPanel`, `HandDetailModal` (both tabs), `HandHistoryPage` and
  `HandReplay` all render `hand.replay` through `HandDetailView`. The panel's
  export text is generated from the model too, so the file says what the
  screen says. `handHistoryShape.ts` and its test are deleted;
  `LiveHandReplayer2D` is deleted; `saveHandToSupabase` (a writer to three
  empty legacy tables with no caller) is deleted.
- **Your own cards on hands you folded or mucked.** `ca_hand_facts.hole_cards`
  is read through its own-rows RLS policy (no user id in the query, the same
  shape as `fetchOwnDiscards`) and reaches the model as `privateHoleCards`. A
  fold row draws them face-up marked "Yours"; a mucked showdown row draws them
  marked "Yours, Not Shown"; they never become a `show` row, never add a seat
  to the showdown, never change a winner.
- **Hi-lo (PLO8 / FLO8).** The client gained `bestLow` / `compareLow` /
  `isEightOrBetterVariant` in `handEvaluator.ts`, ported from the engine's
  `evaluateOmahaLowHand`. Showdown rows come in halves: a low row per qualifying
  player with its own name and share. Server side, `winners_by_board` entries
  carry `low: true` for the low half and the column is written for EVERY hi-lo
  hand (single board included), because `winners` merges a scooper's halves
  under the high hand's name and files a low-only winner under "High Card".
  (`HandController`, `ServerTableEngineRunout`, `handHistory.ts`, `types.ts`.)
- **Boards are listed once.** The model deduplicates a run recorded both as the
  `rit_boards` column and as a `rit_board_N:` pseudo-action.
- **The record is read, never cached.** The per-table localStorage hand list is
  gone (it seeded a fresh sit-down with the previous visit's hands and only
  yielded to a fetch that returned rows). An empty answer is applied;
  `tableId` is a dependency of the fetch; the surfaces get a `loadState` so an
  empty list says loading / failed / none.
- **The modal is pinned to a hand id**, not a list index, so a hand finishing
  behind it cannot move the reader to its neighbour; it opens on Summary; focus
  restore no longer fires on every parent render; the rake-share RPC runs only
  on the Detail tab.
- **The archive** (`/hand-history`) pages with a real offset, shares through
  `panelHandToShareable` (the shared hand now carries its actions and board),
  names the table (the service fetches `tables.name`; every card used to say
  "Table"), drops the five-second false-failure timer and the session cache,
  and no longer serialises the viewer's hole cards into the Jarvis URL.
- **The replay** steps through frames built from the model
  (`utils/replayFrames.ts`): blinds in the pot, raise-TO differenced, the board
  belonging to the street rather than the step number, a street with no action
  still turning its card. The decorative 3D tab (a generic table with no hand
  data) is gone from the modal replay; `HandReplay3D` remains for
  `HandReplayerPage`, which feeds it a real snapshot.
- Panel stats say what they count ("Last N Hands At This Table"), count pots
  won (a walk is a pot), and show VPIP, best and worst.

### #SmarterCasinoRealism

`HandHistoryPanel.css`, `HandDetailModal.css`, `HandHistoryPage.css` and
`HandReplay.css` are rewritten on the house palette (obsidian, carbon,
gunmetal, chrome, steel, broadcast blue, restrained brass), Rajdhani display,
monospace eyebrows, Inter body, a `[data-theme='light']` brushed-silver block
each, `prefers-reduced-motion`, no hover effects, the `#SMARTERCASINOREALISM`
marker. No purpose-built hero renders were commissioned for these four
surfaces; the archive keeps the play circuit's shared chassis art.

### Recorded, not done

- The share-link wire format (`ShareableAction`) has no forced-money verbs, so a
  shared hand still begins with the pot at the first voluntary action. Changing
  it means changing the decoder every recipient runs.
- `useHandReplayModel` (jackpot rundown) does not fetch discards or private
  cards; jackpot hands are NLH.

## 3. Leave Table in real time

Both leave doors (the menu's Leave Table / felt button, and the tab strip's
right-click Leave Table) awaited the entire cash-out before touching the router:
the engine round trip (which itself waits on the previous hand's settlement
writes), the seat read, the cash-out RPC, and on a tournament seat a result
fetch. The player sat on a felt they had left.

The view leaves first. `showLobbyNow()` navigates once per leave the instant
the leave is confirmed; the cash-out completes behind the lobby (the
multi-table container keeps tables mounted while hidden, so every ref the
settlement needs is alive); the results card publishes through the app-root
host; `TABLE_LEFT` closes the tab when the money has moved; a refusal is the
same toast as before with the tab kept as the way back. `MultiTablePage`'s
quick-action `leave` puts the lobby up from the gesture when it is the last
table, and `goToLobby` is idempotent against that early navigation.
Pinned in `tests/unit/theDoorIsNeverLocked.test.ts` ("the lobby comes first").

## Laws touched

- `tests/previous-hand-shows-this-tables-hands.law.test.ts` - rewritten from
  text pins on the old walk to behavioural pins on the model: one
  reconstruction, boards once, hi-lo halves, private cards, uncalled bets.
- `tests/run-it-multiple-times-tells-the-truth.law.test.ts` - second-sweep
  describe.
- `tests/unit/theDoorIsNeverLocked.test.ts` - the lobby comes first.
- New: `tests/unit/replayFrames.test.ts`, `tests/unit/ritTimelineParity.test.ts`.
