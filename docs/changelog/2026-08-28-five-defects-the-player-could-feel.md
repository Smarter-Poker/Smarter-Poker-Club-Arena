# Five Defects The Player Could Feel (2026-08-28)

A line-by-line sweep of the live table surface and the engine, after the
animation and deploy work. Five real defects, ranked by what they cost a
player. Every one was a complete, correct piece of code that simply never ran.

## 1. The felt froze permanently after every engine rebuild

`TableStateHub.dropTable()` deliberately keeps the room's subscribers and their
OPEN sockets, resets the room sequence, and broadcasts `engine_restarting` to
"tell the clients why they are about to see a sequence reset". Nothing in the
app consumed that event.

`EngineStateClient.resetInbox()` carries the cure and its docblock claimed
"This fires on every dropTable path" — it does not: `resetInbox` is reachable
only from `disconnect()` and `ws.onopen`, and dropTable closes no socket. So
the client kept its old epoch, the rebuilt engine's `SNAPSHOT seq:1` was
discarded by the monotonicity belt, every following DELTA tripped
`msg.prev !== this.seq` into a resync whose reply was dropped the same way —
and because frames kept arriving, neither the staleness watchdog nor the
reconnect ladder ever escalated. No cards, no clock, no chips until the player
reloaded the page. Triggered by the zombie rebuild, lease loss and tournament
table breaks.

Now consumed in `handleMessage`, ahead of the queue, so the reset lands before
the fresh snapshot. The corrected docblock says where the dropTable paths
actually go. **This got more urgent, not less, on the day the deploy
drain-gate deadlock was fixed** — the engine now genuinely restarts on deploy
instead of running hours-stale code, so this path runs often rather than
rarely.

## 2. The "+N" pot total was cut off on every side pot and every hi-lo split

`POT_AWARD_STAGGER_MS` was defined in `handCompletionSpec` for exactly this and
read only by the client. The engine held a flat 4500ms however many winners
there were, while the client fires each award group 900ms after the last.
Measured from the WINNERS tick: one group's float ended at T+7400 inside a
T+7500 hold, two groups ended at T+8300, three at T+9200 — so the last
winner's chip fan and the number telling them what they won were wiped
mid-flight by the board clear. Precisely the truncation this file's header was
written to eliminate, surviving in the multi-winner case because the
arithmetic only ever described one. The hold now takes `potAwardGroups`,
counted server-side the same way the client groups them.

## 3. A bomb pot could silently resize a player's shove

`activeHandVariant()` shipped 2026-08-28 and its docblock names "the
legal-action clamps in Turns" as a required consumer. `getLegalActions` and
the horse snapshot were converted; the human clamp and its horse twin still
read `tableInfo.game_variant`. On a bomb hand whose override differs from the
table: a PLO table with an nlh override clamped a shove down to the pot, and a
fixed-limit table with an nlh override REWROTE the wager to the table's limit
size — the player committed to an amount they never chose. The reverse (NLH
table, PLO bomb) enforced no ceiling here and left HandController to reject
the action, burning the player's clock.

## 4. "Snap continue" on a declined rebuy never worked

`handleRejectRebuy` was imported into the router and never given a branch, so
every POST fell to the 404. Both client call sites fire-and-forget with a
swallowing catch, so nothing surfaced it, and `engine.rejectRebuy()` had no
reachable caller — leaving `rejectedRebuys` the write-only set that the
2026-08-27 snap-continue work exists to read. The table sat out the full
5-second rebuy pause after every bust even when the player pressed No.

Routing it exposed WHY it was never wired: the handler's deps type demanded
`{ rejectRebuy(...) } | undefined` while the real `getTableEngine` returns
`ActionEngine | null | undefined`, so the branch would not typecheck. The type
now says what the handler already does at runtime (it guards both).

## 5. The dealer never said who won

`useTableChat` has always carried complete `HAND_WON` and `SHOWDOWN_START`
subscribers — the only code that writes `type: 'DEALER'` chat lines. Nothing
ever emitted either event, and the only other route to one (a
`message_type = 'dealer'` row) is refused by the chat RLS policy. Every hand
ended with the chat panel silent about who won.

Both sat on `noDeadBusSubscriptions`' KNOWN_DEAD list justified as "superseded
by the server-authoritative snapshot" — which cannot be true: a snapshot does
not produce a chat line. That file calls itself "a debt list, not a permission
slip" and promises every entry was checked; this entry was the exception, and
it is recorded there now. `HAND_WON` is emitted once per hand at
HAND_COMPLETE from the merged winner mirror (so side pots and splits announce
once, with the true total) and `SHOWDOWN_START` from the showdown event's
revealed hands.

## Verification

Client `tsc --noEmit` clean, server `tsc --noEmit` clean. Full SERVER suite
194 files / 2097 tests green. Client: the six law/spec suites touched here
(55 tests), the six suites covering EngineStateClient / bus / showdown /
GameServerAPI (91 tests), and all of `tests/components` (439 tests) green.
The full client run was killed twice by sandbox disk exhaustion (competing
agents' worktrees filled both volumes) after emitting 2182 test-file dots with
zero failure markers; CI's required check runs it complete on this PR.
